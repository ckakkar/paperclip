import type { API, CharacteristicValue, PlatformAccessory, Service, WithUUID, Characteristic } from 'homebridge';

import {
  clampSetpoint,
  canHeat,
  currentHeaterCoolerState,
  dryMode,
  fanModeToSpeed,
  fanOnlyMode,
  fanSpeedStep,
  isSpecialMode,
  isSwinging,
  modeToTargetState,
  coolMode,
  speedToFanMode,
  swingToOscillation,
  targetStateToMode,
  validTargetStates,
} from './ac/mapping.js';
import { CAP, fromCelsius, parseState, type AcProfile, type AcState } from './ac/profile.js';
import { optionalModeLabel, type PaperclipConfig } from './config.js';
import type { Log } from './settings.js';
import { SmartThingsApiError, type Command, type SmartThingsClient } from './smartthings/client.js';
import { AuthRequiredError } from './smartthings/tokenManager.js';
import type { Device, DeviceStatus } from './smartthings/types.js';
import { PLUGIN_VERSION } from './version.js';

/** Collect characteristic writes for this long and send them as one SmartThings request. */
const BATCH_MS = 250;
/** Ignore polled values that contradict a write for this long; SmartThings reports changes with a lag. */
const HOLD_MS = 12_000;
/** Re-read the unit this long after a command so HomeKit sees what the unit actually did. */
const REFRESH_AFTER_COMMAND_MS = 3_000;
/** Show "No Response" after this many consecutive failed refreshes. */
const FAILURES_BEFORE_UNREACHABLE = 3;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

export interface AccessoryContext {
  deviceId: string;
  label: string;
  /** Mode to return to when the Dry or Fan switch is turned off. */
  modeBeforeSpecial?: string;
  /** Last display state we set, for units that never report it. */
  displayOn?: boolean;
}

export interface AccessoryDeps {
  api: API;
  log: Log;
  client: SmartThingsClient;
  config: PaperclipConfig;
}

type Waiter = { resolve: () => void; reject: (error: Error) => void };

export class PaperclipAirConditioner {
  private readonly hap: API['hap'];
  private readonly C: API['hap']['Characteristic'];
  private readonly S: API['hap']['Service'];
  private readonly heaterCooler: Service;
  private readonly name: string;

  private state: AcState;
  private readonly holds = new Map<keyof AcState, { value: unknown; until: number }>();
  private readonly extras: { service: Service; read: () => boolean | undefined }[] = [];
  private humidityService?: Service;

  private pending: Command[] = [];
  private waiters: Waiter[] = [];
  private flushTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private polling = false;
  private failures = 0;
  private backoffUntil = 0;
  private stopped = false;

  constructor(
    private readonly deps: AccessoryDeps,
    readonly accessory: PlatformAccessory<AccessoryContext>,
    readonly device: Device,
    readonly profile: AcProfile,
    initialStatus: DeviceStatus,
  ) {
    this.hap = deps.api.hap;
    this.C = this.hap.Characteristic;
    this.S = this.hap.Service;
    this.name = device.label || device.name || 'Air Conditioner';
    this.state = parseState(initialStatus, profile);

    accessory.context.deviceId = device.deviceId;
    accessory.context.label = this.name;

    this.setupInformation();
    this.heaterCooler = this.setupHeaterCooler();
    this.setupExtras();
    this.pushState();
  }

  get deviceId(): string {
    return this.device.deviceId;
  }

  /** Current view of the unit (with any pending writes applied). Exposed for tests and diagnostics. */
  get currentState(): Readonly<AcState> {
    return this.state;
  }

  start(): void {
    const jitter = Math.floor(Math.random() * 3000);
    this.pollTimer = setInterval(() => void this.refresh(), this.deps.config.pollInterval * 1000 + jitter);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.refreshTimer);
    clearTimeout(this.flushTimer);
  }

  // ---------------------------------------------------------------------------
  // Service setup
  // ---------------------------------------------------------------------------

  private setupInformation(): void {
    const model = this.device.ocf?.modelNumber?.split('|')[0]?.trim()
      || this.device.deviceManufacturerCode
      || this.device.name
      || 'Air Conditioner';
    this.accessory.getService(this.S.AccessoryInformation)!
      .setCharacteristic(this.C.Manufacturer, this.device.manufacturerName?.startsWith('Samsung') ? 'Samsung' : (this.device.manufacturerName || 'Samsung'))
      .setCharacteristic(this.C.Model, model.slice(0, 64))
      .setCharacteristic(this.C.SerialNumber, this.device.deviceId)
      .setCharacteristic(this.C.FirmwareRevision, PLUGIN_VERSION);
  }

  private setupHeaterCooler(): Service {
    const C = this.C;
    const service = this.accessory.getService(this.S.HeaterCooler)
      ?? this.accessory.addService(this.S.HeaterCooler, this.name);
    service.setPrimaryService(true);
    service.setCharacteristic(C.Name, this.name);

    service.getCharacteristic(C.Active)
      .onGet(() => this.read(this.state.power ? C.Active.ACTIVE : C.Active.INACTIVE))
      .onSet(value => this.setActive(value));

    service.getCharacteristic(C.CurrentHeaterCoolerState)
      .onGet(() => this.read(currentHeaterCoolerState(this.state, this.profile)));

    const valid = validTargetStates(this.profile);
    const target = service.getCharacteristic(C.TargetHeaterCoolerState);
    target.updateValue(modeToTargetState(this.state.mode, this.profile));
    target.setProps({ minValue: Math.min(...valid), maxValue: Math.max(...valid), validValues: valid })
      .onGet(() => this.read(modeToTargetState(this.state.mode, this.profile)))
      .onSet(value => this.setTargetState(value));

    service.getCharacteristic(C.CurrentTemperature)
      .setProps({ minValue: -40, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.read(this.state.currentTemperature ?? this.state.targetTemperature ?? 25));

    const { min, max, step } = this.profile.setpoint;
    const thresholdProps = { minValue: min, maxValue: max, minStep: step };
    const cooling = service.getCharacteristic(C.CoolingThresholdTemperature);
    cooling.updateValue(this.displayedSetpoint());
    cooling.setProps(thresholdProps)
      .onGet(() => this.read(this.displayedSetpoint()))
      .onSet(value => this.setSetpoint(value));

    if (canHeat(this.profile)) {
      const heating = service.getCharacteristic(C.HeatingThresholdTemperature);
      heating.updateValue(this.displayedSetpoint());
      heating.setProps(thresholdProps)
        .onGet(() => this.read(this.displayedSetpoint()))
        .onSet(value => this.setSetpoint(value));
    } else {
      this.removeCharacteristic(service, C.HeatingThresholdTemperature);
    }

    if (this.profile.fanModes.length > 0) {
      const speed = service.getCharacteristic(C.RotationSpeed);
      speed.updateValue(fanModeToSpeed(this.state.fanMode, this.profile));
      speed.setProps({ minValue: 0, maxValue: 100, minStep: fanSpeedStep(this.profile) })
        .onGet(() => this.read(fanModeToSpeed(this.state.fanMode, this.profile)))
        .onSet(value => this.setRotationSpeed(value));
    } else {
      this.removeCharacteristic(service, C.RotationSpeed);
    }

    if (this.profile.oscillationModes.some(m => m !== 'fixed')) {
      service.getCharacteristic(C.SwingMode)
        .onGet(() => this.read(isSwinging(this.state.oscillation) ? C.SwingMode.SWING_ENABLED : C.SwingMode.SWING_DISABLED))
        .onSet(value => this.setSwing(value));
    } else {
      this.removeCharacteristic(service, C.SwingMode);
    }

    return service;
  }

  private setupExtras(): void {
    const cfg = this.deps.config;
    const caps = this.profile.capabilities;
    const keep = new Set<string>();

    // Humidity
    if (cfg.humiditySensor && caps.has(CAP.humidity)) {
      keep.add('humidity');
      this.humidityService = this.accessory.getServiceById(this.S.HumiditySensor, 'humidity')
        ?? this.accessory.addService(this.S.HumiditySensor, `${this.name} Humidity`, 'humidity');
      this.nameService(this.humidityService, `${this.name} Humidity`);
      this.humidityService.getCharacteristic(this.C.CurrentRelativeHumidity)
        .onGet(() => this.read(this.state.humidity ?? 0));
    }

    // Samsung optional modes (WindFree, Sleep, Quiet, Fast Cool…)
    for (const mode of cfg.optionalModeSwitches) {
      if (mode === 'off') {
        continue;
      }
      if (!this.profile.optionalModes.includes(mode)) {
        this.deps.log.info(`${this.name}: "${mode}" is not one of this unit's modes (${this.profile.optionalModes.filter(m => m !== 'off').join(', ') || 'none'}); no switch added.`);
        continue;
      }
      this.addSwitch(`mode-${mode}`, optionalModeLabel(mode), keep,
        () => this.state.power === true && this.state.optionalMode === mode,
        on => this.setOptionalMode(mode, on));
    }

    const dry = dryMode(this.profile);
    if (cfg.dryModeSwitch && dry) {
      this.addSwitch('dry', 'Dry', keep,
        () => this.state.power === true && this.state.mode === dry,
        on => this.setSpecialMode(dry, on));
    }

    const fan = fanOnlyMode(this.profile);
    if (cfg.fanModeSwitch && fan) {
      this.addSwitch('fan', 'Fan Only', keep,
        () => this.state.power === true && this.state.mode === fan,
        on => this.setSpecialMode(fan, on));
    }

    if (cfg.displaySwitch && (caps.has(CAP.lighting) || caps.has(CAP.execute))) {
      this.addSwitch('display', 'Display', keep,
        () => this.state.lighting ?? this.accessory.context.displayOn ?? true,
        on => this.setDisplay(on));
    }

    if (cfg.autoCleanSwitch && caps.has(CAP.autoClean)) {
      this.addSwitch('autoclean', 'Auto Clean', keep,
        () => this.state.autoClean ?? false,
        on => this.queue([{ capability: CAP.autoClean, command: 'setAutoCleaningMode', arguments: [on ? 'on' : 'off'] }], { autoClean: on }));
    }

    // Drop services from a previous configuration so they don't linger as "No Response" tiles.
    for (const service of [...this.accessory.services]) {
      const managed = service.UUID === this.S.Switch.UUID || service.UUID === this.S.HumiditySensor.UUID;
      if (managed && !keep.has(service.subtype ?? '')) {
        this.deps.log.debug(`${this.name}: removing unused ${service.displayName} service`);
        this.accessory.removeService(service);
      }
    }
  }

  private addSwitch(
    subtype: string,
    label: string,
    keep: Set<string>,
    read: () => boolean | undefined,
    write: (on: boolean) => Promise<void>,
  ): void {
    keep.add(subtype);
    const displayName = `${this.name} ${label}`;
    const service = this.accessory.getServiceById(this.S.Switch, subtype)
      ?? this.accessory.addService(this.S.Switch, displayName, subtype);
    this.nameService(service, displayName);
    service.getCharacteristic(this.C.On)
      .onGet(() => this.read(read() ?? false))
      .onSet(value => write(Boolean(value)));
    this.extras.push({ service, read });
  }

  private nameService(service: Service, name: string): void {
    service.setCharacteristic(this.C.Name, name);
    if (!service.testCharacteristic(this.C.ConfiguredName)) {
      service.addOptionalCharacteristic(this.C.ConfiguredName);
      service.setCharacteristic(this.C.ConfiguredName, name);
    }
  }

  private removeCharacteristic(service: Service, characteristic: WithUUID<new () => Characteristic>): void {
    const existing = service.characteristics.find(c => c.UUID === characteristic.UUID);
    if (existing) {
      service.removeCharacteristic(existing);
    }
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  private read<T extends CharacteristicValue>(value: T): T {
    if (this.failures >= FAILURES_BEFORE_UNREACHABLE) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return value;
  }

  private displayedSetpoint(): number {
    const { min, max } = this.profile.setpoint;
    const value = this.state.targetTemperature ?? min;
    return Math.min(max, Math.max(min, value));
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  private async setActive(value: CharacteristicValue): Promise<void> {
    const on = Number(value) === this.C.Active.ACTIVE;
    await this.queue([{ capability: CAP.switch, command: on ? 'on' : 'off' }], { power: on });
  }

  private async setTargetState(value: CharacteristicValue): Promise<void> {
    const mode = targetStateToMode(Number(value), this.profile);
    if (!mode) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    const commands: Command[] = [];
    if (this.state.power !== true) {
      commands.push({ capability: CAP.switch, command: 'on' });
    }
    commands.push({ capability: CAP.mode, command: 'setAirConditionerMode', arguments: [mode] });
    await this.queue(commands, { power: true, mode });
  }

  private async setSetpoint(value: CharacteristicValue): Promise<void> {
    const celsius = clampSetpoint(Number(value), this.profile);
    const unit = this.profile.unit;
    const deviceValue = unit === 'F' ? Math.round(fromCelsius(celsius, 'F')) : celsius;
    await this.queue(
      [{ capability: CAP.coolingSetpoint, command: 'setCoolingSetpoint', arguments: [deviceValue] }],
      { targetTemperature: celsius },
    );
  }

  private async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    const fanMode = speedToFanMode(Number(value), this.profile);
    if (!fanMode) {
      // The Home app sends 0 together with Active = 0 when the slider is dragged to the bottom.
      return;
    }
    await this.queue([{ capability: CAP.fanMode, command: 'setFanMode', arguments: [fanMode] }], { fanMode });
  }

  private async setSwing(value: CharacteristicValue): Promise<void> {
    const enabled = Number(value) === this.C.SwingMode.SWING_ENABLED;
    const oscillation = swingToOscillation(enabled, this.profile, this.deps.config.swingMode);
    if (!oscillation) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    await this.queue([{ capability: CAP.oscillation, command: 'setFanOscillationMode', arguments: [oscillation] }], { oscillation });
  }

  private async setOptionalMode(mode: string, on: boolean): Promise<void> {
    if (!on && this.state.optionalMode !== mode) {
      return;
    }
    const commands: Command[] = [];
    if (on && this.state.power !== true) {
      commands.push({ capability: CAP.switch, command: 'on' });
    }
    commands.push({ capability: CAP.optionalMode, command: 'setAcOptionalMode', arguments: [on ? mode : 'off'] });
    await this.queue(commands, on ? { power: true, optionalMode: mode } : { optionalMode: 'off' });
  }

  private async setSpecialMode(mode: string, on: boolean): Promise<void> {
    if (on) {
      if (this.state.mode && !isSpecialMode(this.state.mode)) {
        this.accessory.context.modeBeforeSpecial = this.state.mode;
        this.persistContext();
      }
      const commands: Command[] = [];
      if (this.state.power !== true) {
        commands.push({ capability: CAP.switch, command: 'on' });
      }
      commands.push({ capability: CAP.mode, command: 'setAirConditionerMode', arguments: [mode] });
      await this.queue(commands, { power: true, mode });
      return;
    }

    if (this.state.mode !== mode) {
      return;
    }
    const previous = this.accessory.context.modeBeforeSpecial;
    const back = previous && this.profile.modes.includes(previous) && !isSpecialMode(previous)
      ? previous
      : coolMode(this.profile) ?? targetStateToMode(validTargetStates(this.profile)[0], this.profile) ?? 'cool';
    await this.queue([{ capability: CAP.mode, command: 'setAirConditionerMode', arguments: [back] }], { mode: back });
  }

  private async setDisplay(on: boolean): Promise<void> {
    if (this.profile.capabilities.has(CAP.lighting)) {
      await this.queue([{ capability: CAP.lighting, command: on ? 'on' : 'off' }], { lighting: on });
    } else {
      // Samsung names the option after the "light off" feature, so Light_Off lights the display.
      await this.queue([{
        capability: CAP.execute,
        command: 'execute',
        arguments: ['mode/vs/0', { 'x.com.samsung.da.options': [on ? 'Light_Off' : 'Light_On'] }],
      }], {});
    }
    this.accessory.context.displayOn = on;
    this.persistContext();
  }

  /**
   * Applies the change optimistically, then batches the command with any others that arrive
   * in the next few hundred milliseconds (the Home app sends power, mode and temperature as
   * separate writes) and sends them to SmartThings in one request.
   */
  private queue(commands: Command[], optimistic: Partial<AcState>): Promise<void> {
    for (const command of commands) {
      const key = commandKey(command);
      this.pending = this.pending.filter(c => commandKey(c) !== key);
      this.pending.push(command);
    }

    const until = Date.now() + HOLD_MS;
    for (const [key, value] of Object.entries(optimistic) as [keyof AcState, unknown][]) {
      (this.state as Record<string, unknown>)[key] = value;
      this.holds.set(key, { value, until });
    }
    this.pushState();

    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => void this.flush(), BATCH_MS);
      }
    });
  }

  private async flush(): Promise<void> {
    this.flushTimer = undefined;
    const commands = orderCommands(this.pending);
    const waiters = this.waiters;
    this.pending = [];
    this.waiters = [];
    if (commands.length === 0) {
      waiters.forEach(w => w.resolve());
      return;
    }

    try {
      await this.deps.client.executeCommands(this.deviceId, commands);
      this.deps.log.info(`${this.name}: ${commands.map(describeCommand).join(', ')}`);
      waiters.forEach(w => w.resolve());
      this.scheduleRefresh(REFRESH_AFTER_COMMAND_MS);
    } catch (error) {
      this.deps.log.error(`${this.name}: could not send ${commands.map(describeCommand).join(', ')}: ${(error as Error).message}`);
      this.holds.clear();
      const hapError = new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      waiters.forEach(w => w.reject(hapError));
      this.scheduleRefresh(500);
    }
  }

  private persistContext(): void {
    try {
      this.deps.api.updatePlatformAccessories([this.accessory]);
    } catch {
      // Not registered yet; the context is saved when the platform registers it.
    }
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  private scheduleRefresh(delayMs: number): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(true), delayMs);
  }

  /** Reads the unit from SmartThings and pushes any changes to HomeKit. */
  async refresh(force = false): Promise<void> {
    if (this.stopped || this.polling || (!force && Date.now() < this.backoffUntil)) {
      return;
    }
    this.polling = true;
    try {
      const status = await this.deps.client.getStatus(this.deviceId);
      this.applyStatus(status);
      if (this.failures >= FAILURES_BEFORE_UNREACHABLE) {
        this.deps.log.info(`${this.name}: reachable again.`);
      }
      this.failures = 0;
      this.backoffUntil = 0;
    } catch (error) {
      this.failures++;
      if (error instanceof SmartThingsApiError && error.isRateLimited) {
        const wait = error.retryAfterMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
        this.backoffUntil = Date.now() + wait;
        this.deps.log.warn(`${this.name}: SmartThings rate limit reached; pausing updates for ${Math.round(wait / 1000)}s.`);
      } else if (error instanceof AuthRequiredError) {
        this.backoffUntil = Date.now() + 5 * 60_000;
        if (this.failures === 1) {
          this.deps.log.error(`${this.name}: ${error.message}`);
        }
      } else if (this.failures === 1 || this.failures === FAILURES_BEFORE_UNREACHABLE) {
        this.deps.log.warn(`${this.name}: could not refresh status (${(error as Error).message})`);
      } else {
        this.deps.log.debug(`${this.name}: refresh failed again (${(error as Error).message})`);
      }
      if (this.failures === FAILURES_BEFORE_UNREACHABLE) {
        this.pushUnreachable();
      }
    } finally {
      this.polling = false;
    }
  }

  /** Exposed for tests: merge a SmartThings status payload, respecting recent writes. */
  applyStatus(status: DeviceStatus): void {
    const fresh = parseState(status, this.profile);
    const now = Date.now();
    for (const [key, hold] of [...this.holds]) {
      if (hold.until < now || fresh[key] === hold.value) {
        this.holds.delete(key);
      } else {
        (fresh as Record<string, unknown>)[key] = hold.value;
      }
    }
    this.state = { ...this.state, ...stripUndefined(fresh) };
    this.pushState();
  }

  private pushState(): void {
    const C = this.C;
    const s = this.heaterCooler;
    const state = this.state;

    if (state.power !== undefined) {
      s.updateCharacteristic(C.Active, state.power ? C.Active.ACTIVE : C.Active.INACTIVE);
    }
    s.updateCharacteristic(C.CurrentHeaterCoolerState, currentHeaterCoolerState(state, this.profile));
    s.updateCharacteristic(C.TargetHeaterCoolerState, modeToTargetState(state.mode, this.profile));
    if (state.currentTemperature !== undefined) {
      s.updateCharacteristic(C.CurrentTemperature, state.currentTemperature);
    }
    if (state.targetTemperature !== undefined) {
      s.updateCharacteristic(C.CoolingThresholdTemperature, this.displayedSetpoint());
      if (canHeat(this.profile)) {
        s.updateCharacteristic(C.HeatingThresholdTemperature, this.displayedSetpoint());
      }
    }
    if (this.profile.fanModes.length > 0 && state.fanMode !== undefined) {
      s.updateCharacteristic(C.RotationSpeed, fanModeToSpeed(state.fanMode, this.profile));
    }
    if (this.profile.oscillationModes.some(m => m !== 'fixed') && state.oscillation !== undefined) {
      s.updateCharacteristic(C.SwingMode, isSwinging(state.oscillation) ? C.SwingMode.SWING_ENABLED : C.SwingMode.SWING_DISABLED);
    }
    if (this.humidityService && state.humidity !== undefined) {
      this.humidityService.updateCharacteristic(C.CurrentRelativeHumidity, state.humidity);
    }
    for (const extra of this.extras) {
      extra.service.updateCharacteristic(C.On, extra.read() ?? false);
    }
  }

  private pushUnreachable(): void {
    const error = new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    this.heaterCooler.updateCharacteristic(this.C.Active, error);
  }
}

function commandKey(command: Command): string {
  // Power on/off share a key so the last one wins; every other command is keyed by itself.
  return command.capability === CAP.switch ? 'switch' : `${command.capability}:${command.command}`;
}

/** Power on first so the unit accepts the rest; power off last so nothing turns it back on. */
function orderCommands(commands: Command[]): Command[] {
  const on = commands.filter(c => c.capability === CAP.switch && c.command === 'on');
  const off = commands.filter(c => c.capability === CAP.switch && c.command === 'off');
  const mode = commands.filter(c => c.capability === CAP.mode);
  const rest = commands.filter(c => c.capability !== CAP.switch && c.capability !== CAP.mode);
  return [...on, ...mode, ...rest, ...off];
}

function describeCommand(command: Command): string {
  if (command.capability === CAP.switch) {
    return `power ${command.command}`;
  }
  const args = (command.arguments ?? []).map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(', ');
  return `${command.command}(${args})`;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
