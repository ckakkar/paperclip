import type { API, Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';

import {
  autoMode,
  canHeat,
  clampSetpoint,
  coolMode,
  currentHeaterCoolerState,
  CurrentState,
  defaultManualFan,
  dryMode,
  fanLevels,
  fanModeToSpeed,
  fanOnlyMode,
  fanSpeedStep,
  FAN_ONLY_MODES,
  hasAutoFan,
  isSpecialMode,
  isSwinging,
  modeToTargetState,
  optionalModeBlocker,
  optionalModeEndsWith,
  speedToFanMode,
  swingCommands,
  swingFor,
  targetStateToMode,
  validTargetStates,
  type SwingWish,
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

/** Subtypes of the services Paperclip adds next to the main HeaterCooler. */
export const SUBTYPE = {
  humidity: 'humidity',
  fanTile: 'fan-speed',
  filter: 'filter',
  dry: 'dry',
  fanOnly: 'fan',
  display: 'display',
  autoClean: 'autoclean',
  beep: 'beep',
  swingVertical: 'swing-vertical',
  swingHorizontal: 'swing-horizontal',
  optionalMode: (mode: string) => `mode-${mode}`,
} as const;

export interface AccessoryContext {
  deviceId: string;
  label: string;
  /** "modes" for the companion accessory that holds the mode switches. */
  kind?: 'main' | 'modes';
  /** Mode to return to when Dry or fan-only is turned off. */
  modeBeforeSpecial?: string;
  /** Last display state we set, for units that never report it. */
  displayOn?: boolean;
  /** Last manual fan speed, shown on the slider while the fan is on Auto. */
  lastManualFan?: string;
}

export interface AccessoryDeps {
  api: API;
  log: Log;
  client: SmartThingsClient;
  config: PaperclipConfig;
}

export interface SwitchSpec {
  subtype: string;
  /** Short name, as a native accessory would use inside its own tile. */
  label: string;
}

/** Samsung app order: the cooling boosts first, then comfort modes. */
const OPTIONAL_MODE_ORDER = ['speed', 'quiet', 'sleep', 'windFree', 'windFreeSleep', 'smart', 'comfort', 'longWind'];

/**
 * The toggles this unit gets with this config, in the order the Samsung app lists them. They all sit
 * inside the AC's own tile, under the dial and Fan Speed, so the room shows one accessory per AC.
 */
export function switchPlan(profile: AcProfile, config: PaperclipConfig): SwitchSpec[] {
  const caps = profile.capabilities;
  const plan: SwitchSpec[] = [];
  const modes = config.optionalModeSwitches
    .filter(mode => mode !== 'off' && profile.optionalModes.includes(mode))
    .sort((a, b) => rank(a) - rank(b));
  for (const mode of modes) {
    plan.push({ subtype: SUBTYPE.optionalMode(mode), label: optionalModeLabel(mode) });
  }
  if (config.dryModeSwitch && dryMode(profile)) {
    plan.push({ subtype: SUBTYPE.dry, label: 'Dry' });
  }
  if (config.fanModeSwitch && fanOnlyMode(profile)) {
    plan.push({ subtype: SUBTYPE.fanOnly, label: 'Fan Only' });
  }
  if (config.swingDirectionSwitches && profile.swing.vertical && profile.swing.horizontal) {
    plan.push({ subtype: SUBTYPE.swingVertical, label: 'Swing Up/Down' });
    plan.push({ subtype: SUBTYPE.swingHorizontal, label: 'Swing Left/Right' });
  }
  if (config.displaySwitch && (caps.has(CAP.lighting) || caps.has(CAP.execute))) {
    plan.push({ subtype: SUBTYPE.display, label: 'Display' });
  }
  if (config.beepSwitch && caps.has(CAP.beep)) {
    plan.push({ subtype: SUBTYPE.beep, label: 'Beep' });
  }
  if (config.autoCleanSwitch && caps.has(CAP.autoClean)) {
    plan.push({ subtype: SUBTYPE.autoClean, label: 'Auto Clean' });
  }
  return plan;
}

function rank(mode: string): number {
  const index = OPTIONAL_MODE_ORDER.indexOf(mode);
  return index === -1 ? OPTIONAL_MODE_ORDER.length : index;
}

type Waiter = { resolve: () => void; reject: (error: Error) => void };

export class PaperclipAirConditioner {
  private readonly hap: API['hap'];
  private readonly C: API['hap']['Characteristic'];
  private readonly S: API['hap']['Service'];
  private readonly heaterCooler: Service;
  private readonly name: string;

  /** With a Fan Speed control, fan speed, Auto and swing live there instead of on the AC's own service. */
  private readonly fanTile: boolean;
  /** Fan speeds on the AC's own slider (only used when there is no Fan Speed control). */
  private readonly coolerLevels: string[];
  /** Fan speeds on the Fan Speed control's slider (never Auto; that is its own toggle). */
  private readonly tileLevels: string[];

  private state: AcState;
  private readonly holds = new Map<keyof AcState, { value: unknown; until: number }>();
  private readonly extras: { service: Service; read: () => boolean | undefined }[] = [];
  private humidityService?: Service;
  private fanService?: Service;
  private filterService?: Service;

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

    this.fanTile = deps.config.fanTile && profile.fanModes.length > 0;
    this.tileLevels = this.fanTile ? fanLevels(profile, false) : [];
    this.coolerLevels = this.fanTile ? [] : fanLevels(profile, true);

    accessory.context.deviceId = device.deviceId;
    accessory.context.label = this.name;
    accessory.context.kind = 'main';
    this.rememberManualFan();

    this.setupInformation(accessory, this.device.deviceId);
    this.heaterCooler = this.setupHeaterCooler();
    this.setupCompanions();
    const plan = this.setupSwitches();
    this.orderServices(plan);
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

  private setupInformation(accessory: PlatformAccessory, serial: string): void {
    const model = this.device.ocf?.modelNumber?.split('|')[0]?.trim()
      || this.device.deviceManufacturerCode
      || this.device.name
      || 'Air Conditioner';
    accessory.getService(this.S.AccessoryInformation)!
      .setCharacteristic(this.C.Manufacturer, this.device.manufacturerName?.startsWith('Samsung') ? 'Samsung' : (this.device.manufacturerName || 'Samsung'))
      .setCharacteristic(this.C.Model, model.slice(0, 64))
      .setCharacteristic(this.C.SerialNumber, serial)
      .setCharacteristic(this.C.FirmwareRevision, PLUGIN_VERSION);
  }

  private setupHeaterCooler(): Service {
    const C = this.C;
    const service = this.accessory.getService(this.S.HeaterCooler)
      ?? this.accessory.addService(this.S.HeaterCooler, this.name);
    service.setPrimaryService(true);
    // Without its own ConfiguredName the Home app titles this control "Heater-Cooler".
    this.nameService(service, this.name, ['Heater-Cooler']);

    service.getCharacteristic(C.Active)
      .onGet(() => this.read(this.coolerActive() ? C.Active.ACTIVE : C.Active.INACTIVE))
      .onSet(value => this.setCoolerActive(Number(value) === C.Active.ACTIVE));

    service.getCharacteristic(C.CurrentHeaterCoolerState)
      .onGet(() => this.read(this.coolerCurrentState()));

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

    // The Home app only offers Auto when both thresholds exist. Samsung has one setpoint, so both mirror it.
    if (this.hasHeatingThreshold()) {
      const heating = service.getCharacteristic(C.HeatingThresholdTemperature);
      heating.updateValue(this.displayedSetpoint());
      heating.setProps(thresholdProps)
        .onGet(() => this.read(this.displayedSetpoint()))
        .onSet(value => this.setSetpoint(value));
    } else {
      this.removeCharacteristic(service, C.HeatingThresholdTemperature);
    }

    // With a Fan control, airflow lives only there, so there is one place to change it.
    if (this.coolerLevels.length > 0) {
      this.wireSpeed(service, this.coolerLevels);
    } else {
      this.removeCharacteristic(service, C.RotationSpeed);
    }
    if (this.profile.swing.source && !this.fanTile) {
      this.wireSwingMode(service);
    } else {
      this.removeCharacteristic(service, C.SwingMode);
    }

    return service;
  }

  /**
   * Fan Speed, filter and humidity: shown inside the AC's own tile, like a native air conditioner.
   * Fan Speed is the AC's own fan, as on the remote: its on/off is the unit's power, and it never
   * changes the mode. Fan-only mode has its own toggle next to Dry.
   */
  private setupCompanions(): void {
    const C = this.C;
    const keep = new Set<string>();

    if (this.fanTile) {
      keep.add(SUBTYPE.fanTile);
      const fan = this.accessory.getServiceById(this.S.Fanv2, SUBTYPE.fanTile)
        ?? this.accessory.addService(this.S.Fanv2, FAN_SPEED_NAME, SUBTYPE.fanTile);
      // "Fan" was the 0.2–0.4 name; renaming it says this is the AC's speed, not a separate fan.
      this.nameService(fan, FAN_SPEED_NAME, ['Fan', `${this.name} Fan`, `${this.name} ${FAN_SPEED_NAME}`]);
      fan.getCharacteristic(C.Active)
        .onGet(() => this.read(this.state.power ? C.Active.ACTIVE : C.Active.INACTIVE))
        .onSet(value => this.setFanActive(Number(value) === C.Active.ACTIVE));
      fan.getCharacteristic(C.CurrentFanState)
        .onGet(() => this.read(this.state.power ? C.CurrentFanState.BLOWING_AIR : C.CurrentFanState.INACTIVE));
      if (hasAutoFan(this.profile)) {
        fan.getCharacteristic(C.TargetFanState)
          .onGet(() => this.read(this.state.fanMode === 'auto' ? C.TargetFanState.AUTO : C.TargetFanState.MANUAL))
          .onSet(value => this.setFanAuto(Number(value) === C.TargetFanState.AUTO));
      } else {
        this.removeCharacteristic(fan, C.TargetFanState);
      }
      this.wireSpeed(fan, this.tileLevels);
      if (this.profile.swing.source) {
        this.wireSwingMode(fan);
      } else {
        this.removeCharacteristic(fan, C.SwingMode);
      }
      this.heaterCooler.addLinkedService(fan);
      this.fanService = fan;
    }

    if (this.deps.config.filterStatus && this.profile.capabilities.has(CAP.dustFilter)) {
      keep.add(SUBTYPE.filter);
      const filter = this.accessory.getServiceById(this.S.FilterMaintenance, SUBTYPE.filter)
        ?? this.accessory.addService(this.S.FilterMaintenance, 'Filter', SUBTYPE.filter);
      this.nameService(filter, 'Filter', [`${this.name} Filter`]);
      filter.getCharacteristic(C.FilterChangeIndication).onGet(() => this.read(this.filterChange()));
      filter.getCharacteristic(C.FilterLifeLevel).onGet(() => this.read(this.filterLife()));
      filter.getCharacteristic(C.ResetFilterIndication).onSet(() =>
        this.queue([{ capability: CAP.dustFilter, command: 'resetDustFilter' }], { filterUsage: 0, filterStatus: 'normal' }));
      this.heaterCooler.addLinkedService(filter);
      this.filterService = filter;
    }

    if (this.deps.config.humiditySensor && this.profile.capabilities.has(CAP.humidity)) {
      keep.add(SUBTYPE.humidity);
      const humidity = this.accessory.getServiceById(this.S.HumiditySensor, SUBTYPE.humidity)
        ?? this.accessory.addService(this.S.HumiditySensor, 'Humidity', SUBTYPE.humidity);
      this.nameService(humidity, 'Humidity', [`${this.name} Humidity`]);
      humidity.getCharacteristic(C.CurrentRelativeHumidity).onGet(() => this.read(this.state.humidity ?? 0));
      this.heaterCooler.addLinkedService(humidity);
      this.humidityService = humidity;
    }

    const companions = new Set([this.S.Fanv2.UUID, this.S.FilterMaintenance.UUID, this.S.HumiditySensor.UUID]);
    for (const service of [...this.accessory.services]) {
      if (companions.has(service.UUID) && !keep.has(service.subtype ?? '')) {
        this.removeService(this.accessory, service);
      }
    }
  }

  private setupSwitches(): SwitchSpec[] {
    const plan = switchPlan(this.profile, this.deps.config);
    const handlers = this.switchHandlers();
    const keep = new Set<string>();

    for (const spec of plan) {
      const handler = handlers[spec.subtype] ?? this.optionalModeHandler(spec.subtype);
      if (!handler) {
        continue;
      }
      keep.add(spec.subtype);
      const service = this.accessory.getServiceById(this.S.Switch, spec.subtype)
        ?? this.accessory.addService(this.S.Switch, spec.label, spec.subtype);
      this.nameService(service, spec.label, [`${this.name} ${spec.label}`, `${this.name} ${legacyLabel(spec)}`]);
      service.getCharacteristic(this.C.On)
        .onGet(() => this.read(handler.read() ?? false))
        .onSet(value => handler.write(Boolean(value)));
      this.heaterCooler.addLinkedService(service);
      this.extras.push({ service, read: handler.read });
    }

    for (const service of [...this.accessory.services]) {
      if (service.UUID === this.S.Switch.UUID && !keep.has(service.subtype ?? '')) {
        this.removeService(this.accessory, service);
      }
    }
    return plan;
  }

  /**
   * Lists the services in the order they read on the AC's page: the dial, Fan Speed, the toggles in
   * Samsung-app order, then the filter and humidity. Cached accessories otherwise keep the order the
   * services were first added in, which differs between upgrades. The sort is in place and keeps
   * every service's instance ID, so HomeKit sees the same controls.
   */
  private orderServices(plan: SwitchSpec[]): void {
    const rank = (service: Service): number => {
      if (service.UUID === this.S.AccessoryInformation.UUID) {
        return 0;
      }
      if (service === this.heaterCooler) {
        return 1;
      }
      if (service === this.fanService) {
        return 2;
      }
      if (service.UUID === this.S.Switch.UUID) {
        const index = plan.findIndex(spec => spec.subtype === service.subtype);
        return 10 + (index === -1 ? plan.length : index);
      }
      if (service === this.filterService) {
        return 1000;
      }
      if (service === this.humidityService) {
        return 1001;
      }
      return 2000;
    };
    this.accessory.services.sort((a, b) => rank(a) - rank(b));
  }

  private switchHandlers(): Record<string, { read: () => boolean | undefined; write: (on: boolean) => Promise<void> }> {
    const dry = dryMode(this.profile);
    const fanOnly = fanOnlyMode(this.profile);
    return {
      [SUBTYPE.dry]: {
        read: () => this.state.power === true && this.state.mode === dry,
        write: on => this.setSpecialMode(dry!, on),
      },
      [SUBTYPE.fanOnly]: {
        read: () => this.state.power === true && this.state.mode === fanOnly,
        write: on => this.setSpecialMode(fanOnly!, on),
      },
      [SUBTYPE.swingVertical]: {
        read: () => this.state.swingVertical ?? false,
        write: on => this.setSwing({ vertical: on, horizontal: this.state.swingHorizontal ?? false }, 'vertical'),
      },
      [SUBTYPE.swingHorizontal]: {
        read: () => this.state.swingHorizontal ?? false,
        write: on => this.setSwing({ vertical: this.state.swingVertical ?? false, horizontal: on }, 'horizontal'),
      },
      [SUBTYPE.display]: {
        read: () => this.state.lighting ?? this.accessory.context.displayOn ?? true,
        write: on => this.setDisplay(on),
      },
      [SUBTYPE.beep]: {
        read: () => this.state.beep ?? true,
        write: on => this.queue([{ capability: CAP.beep, command: on ? 'on' : 'off' }], { beep: on }),
      },
      [SUBTYPE.autoClean]: {
        read: () => this.state.autoClean ?? false,
        write: on => this.queue([{ capability: CAP.autoClean, command: 'setAutoCleaningMode', arguments: [on ? 'on' : 'off'] }], { autoClean: on }),
      },
    };
  }

  private optionalModeHandler(subtype: string) {
    const mode = subtype.startsWith('mode-') ? subtype.slice('mode-'.length) : undefined;
    if (!mode) {
      return undefined;
    }
    return {
      read: () => this.state.power === true && this.state.optionalMode === mode,
      write: (on: boolean) => this.setOptionalMode(mode, on),
    };
  }

  private wireSpeed(service: Service, levels: string[]): void {
    const speed = service.getCharacteristic(this.C.RotationSpeed);
    speed.updateValue(this.speedFor(levels));
    speed.setProps({ minValue: 0, maxValue: 100, minStep: fanSpeedStep(levels) })
      .onGet(() => this.read(this.speedFor(levels)))
      .onSet(value => this.setRotationSpeed(value, levels));
  }

  private wireSwingMode(service: Service): void {
    const C = this.C;
    service.getCharacteristic(C.SwingMode)
      .onGet(() => this.read(isSwinging(this.state) ? C.SwingMode.SWING_ENABLED : C.SwingMode.SWING_DISABLED))
      .onSet(value => this.setSwing(swingFor(Number(value) === C.SwingMode.SWING_ENABLED, this.deps.config.swingMode, this.profile)));
  }

  /**
   * Sets the service name. The Home app's own name (ConfiguredName) is only overwritten while it
   * still holds a name Paperclip generated, so a rename made in the Home app is kept.
   */
  private nameService(service: Service, name: string, generatedNames: string[] = []): void {
    service.setCharacteristic(this.C.Name, name);
    if (!service.testCharacteristic(this.C.ConfiguredName)) {
      service.addOptionalCharacteristic(this.C.ConfiguredName);
      service.setCharacteristic(this.C.ConfiguredName, name);
      return;
    }
    const current = service.getCharacteristic(this.C.ConfiguredName).value;
    if (typeof current !== 'string' || current === '' || generatedNames.includes(current)) {
      service.setCharacteristic(this.C.ConfiguredName, name);
    }
  }

  private removeService(accessory: PlatformAccessory, service: Service): void {
    this.deps.log.debug(`${this.name}: removing ${service.displayName}`);
    this.heaterCooler?.removeLinkedService(service);
    accessory.removeService(service);
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

  private hasHeatingThreshold(): boolean {
    return canHeat(this.profile) || autoMode(this.profile) !== undefined;
  }

  private isFanOnly(): boolean {
    return this.state.mode !== undefined && FAN_ONLY_MODES.includes(this.state.mode);
  }

  /** One power, as on the remote: the AC reads on in every mode, Fan Only included (it shows Idle). */
  private coolerActive(): boolean {
    return this.state.power === true;
  }

  private coolerCurrentState(): number {
    return this.coolerActive() ? currentHeaterCoolerState(this.state, this.profile) : CurrentState.INACTIVE;
  }

  private displayedSetpoint(): number {
    const { min, max } = this.profile.setpoint;
    const value = this.state.targetTemperature ?? min;
    return Math.min(max, Math.max(min, value));
  }

  /** Slider position for a list of speeds; while on Auto (and Auto isn't on this slider) show the last manual speed. */
  private speedFor(levels: string[]): number {
    const mode = this.state.fanMode === 'auto' && !levels.includes('auto')
      ? this.accessory.context.lastManualFan
      : this.state.fanMode;
    return fanModeToSpeed(mode, levels);
  }

  private filterLife(): number {
    return Math.round(100 - (this.state.filterUsage ?? 0));
  }

  private filterChange(): number {
    const status = this.state.filterStatus;
    const due = status === 'replace' || status === 'wash';
    return due ? this.C.FilterChangeIndication.CHANGE_FILTER : this.C.FilterChangeIndication.FILTER_OK;
  }

  private rememberManualFan(): void {
    const mode = this.state.fanMode;
    const manual = fanLevels(this.profile, false);
    if (mode && mode !== 'auto' && manual.includes(mode)) {
      this.accessory.context.lastManualFan = mode;
    } else if (!this.accessory.context.lastManualFan || !manual.includes(this.accessory.context.lastManualFan)) {
      this.accessory.context.lastManualFan = defaultManualFan(this.profile);
    }
  }

  /** Mode to cool in when leaving Dry or fan-only. */
  private resumeMode(): string {
    const previous = this.accessory.context.modeBeforeSpecial;
    return previous && this.profile.modes.includes(previous) && !isSpecialMode(previous)
      ? previous
      : coolMode(this.profile) ?? targetStateToMode(validTargetStates(this.profile)[0], this.profile) ?? 'cool';
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * The AC's power. Off always turns the unit off, whatever mode it's in. Turning the AC on after it
   * was left in Fan Only cools again (in the mode before Fan Only), because that's what the AC tile is for.
   */
  private async setCoolerActive(on: boolean): Promise<void> {
    if (!on) {
      await this.queue([{ capability: CAP.switch, command: 'off' }], { power: false });
      return;
    }
    if (this.state.power !== true && this.isFanOnly()) {
      const mode = this.resumeMode();
      await this.queue([
        { capability: CAP.switch, command: 'on' },
        { capability: CAP.mode, command: 'setAirConditionerMode', arguments: [mode] },
      ], { power: true, mode });
      return;
    }
    await this.queue([{ capability: CAP.switch, command: 'on' }], { power: true });
  }

  /**
   * Fan Speed's on/off is the unit's power, like the remote's power button: on resumes the last mode,
   * off turns the unit off. It never picks a mode; Fan Only has its own toggle.
   */
  private async setFanActive(on: boolean): Promise<void> {
    if (!on) {
      await this.queue([{ capability: CAP.switch, command: 'off' }], { power: false });
      return;
    }
    if (this.state.power === true) {
      return;
    }
    await this.queue([{ capability: CAP.switch, command: 'on' }], { power: true });
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
    await this.queue(commands, this.modeChange(mode));
  }

  private async setSetpoint(value: CharacteristicValue): Promise<void> {
    const celsius = clampSetpoint(Number(value), this.profile);
    const deviceValue = this.profile.unit === 'F' ? Math.round(fromCelsius(celsius, 'F')) : celsius;
    await this.queue(
      [{ capability: CAP.coolingSetpoint, command: 'setCoolingSetpoint', arguments: [deviceValue] }],
      { targetTemperature: celsius },
    );
  }

  private async setRotationSpeed(value: CharacteristicValue, levels: string[]): Promise<void> {
    const fanMode = speedToFanMode(Number(value), levels);
    if (!fanMode) {
      // The Home app sends 0 together with Active = 0 when the slider is dragged to the bottom.
      return;
    }
    await this.setFanMode(fanMode);
  }

  private async setFanAuto(auto: boolean): Promise<void> {
    if (auto) {
      await this.setFanMode('auto');
    } else if (this.state.fanMode === 'auto') {
      await this.setFanMode(this.accessory.context.lastManualFan ?? defaultManualFan(this.profile) ?? 'low');
    }
  }

  private async setFanMode(fanMode: string): Promise<void> {
    if (fanMode !== 'auto') {
      this.accessory.context.lastManualFan = fanMode;
    }
    await this.queue([{ capability: CAP.fanMode, command: 'setFanMode', arguments: [fanMode] }], { fanMode });
  }

  /** `only` limits the commands to one axis, so a stale reading of the other axis is never written back. */
  private async setSwing(wish: SwingWish, only?: 'vertical' | 'horizontal'): Promise<void> {
    let commands = swingCommands(wish, this.profile);
    if (only && this.profile.swing.source === 'airFlow') {
      const command = only === 'vertical' ? 'setVerticalDirection' : 'setHorizontalDirection';
      commands = commands.filter(c => c.command === command);
    }
    if (commands.length === 0) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    const optimistic: Partial<AcState> = {};
    if (!only || only === 'vertical') {
      optimistic.swingVertical = wish.vertical && this.profile.swing.vertical;
    }
    if (!only || only === 'horizontal') {
      optimistic.swingHorizontal = wish.horizontal && this.profile.swing.horizontal;
    }
    await this.queue(commands, optimistic);
  }

  private async setOptionalMode(mode: string, on: boolean): Promise<void> {
    if (!on) {
      if (this.state.optionalMode === mode) {
        await this.queue([{ capability: CAP.optionalMode, command: 'setAcOptionalMode', arguments: ['off'] }], { optionalMode: 'off' });
      }
      return;
    }
    const blocker = optionalModeBlocker(mode, this.state);
    if (blocker) {
      // Like the Samsung app, which greys these out: the Home app flips the switch back.
      this.deps.log.info(`${this.name}: ${optionalModeLabel(mode)} ${blocker}; not turned on.`);
      setTimeout(() => this.pushState(), 0);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    await this.queue([{ capability: CAP.optionalMode, command: 'setAcOptionalMode', arguments: [mode] }], { optionalMode: mode });
  }

  /** Optimistic state for a mode change, including the optional mode the unit will drop. */
  private modeChange(mode: string): Partial<AcState> {
    return optionalModeEndsWith(this.state.optionalMode, mode) ? { power: true, mode, optionalMode: 'off' } : { power: true, mode };
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
      await this.queue(commands, this.modeChange(mode));
      return;
    }

    if (this.state.mode !== mode) {
      return;
    }
    const back = this.resumeMode();
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
    this.state = { ...this.state, ...fresh };
    this.rememberManualFan();
    this.pushState();
  }

  private pushState(): void {
    const C = this.C;
    const s = this.heaterCooler;
    const state = this.state;
    const swing = isSwinging(state) ? C.SwingMode.SWING_ENABLED : C.SwingMode.SWING_DISABLED;

    if (state.power !== undefined) {
      s.updateCharacteristic(C.Active, this.coolerActive() ? C.Active.ACTIVE : C.Active.INACTIVE);
    }
    s.updateCharacteristic(C.CurrentHeaterCoolerState, this.coolerCurrentState());
    s.updateCharacteristic(C.TargetHeaterCoolerState, modeToTargetState(state.mode, this.profile));
    if (state.currentTemperature !== undefined) {
      s.updateCharacteristic(C.CurrentTemperature, state.currentTemperature);
    }
    if (state.targetTemperature !== undefined) {
      s.updateCharacteristic(C.CoolingThresholdTemperature, this.displayedSetpoint());
      if (this.hasHeatingThreshold()) {
        s.updateCharacteristic(C.HeatingThresholdTemperature, this.displayedSetpoint());
      }
    }
    if (this.coolerLevels.length > 0 && state.fanMode !== undefined) {
      s.updateCharacteristic(C.RotationSpeed, this.speedFor(this.coolerLevels));
    }
    if (this.profile.swing.source && !this.fanTile) {
      s.updateCharacteristic(C.SwingMode, swing);
    }

    const fan = this.fanService;
    if (fan) {
      if (state.power !== undefined) {
        fan.updateCharacteristic(C.Active, state.power ? C.Active.ACTIVE : C.Active.INACTIVE);
        fan.updateCharacteristic(C.CurrentFanState, state.power ? C.CurrentFanState.BLOWING_AIR : C.CurrentFanState.INACTIVE);
      }
      if (state.fanMode !== undefined) {
        fan.updateCharacteristic(C.RotationSpeed, this.speedFor(this.tileLevels));
        if (hasAutoFan(this.profile)) {
          fan.updateCharacteristic(C.TargetFanState, state.fanMode === 'auto' ? C.TargetFanState.AUTO : C.TargetFanState.MANUAL);
        }
      }
      if (this.profile.swing.source) {
        fan.updateCharacteristic(C.SwingMode, swing);
      }
    }

    if (this.filterService) {
      this.filterService.updateCharacteristic(C.FilterLifeLevel, this.filterLife());
      this.filterService.updateCharacteristic(C.FilterChangeIndication, this.filterChange());
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
    this.fanService?.updateCharacteristic(this.C.Active, error);
  }
}

const FAN_SPEED_NAME = 'Fan Speed';

/** The long names 0.2.0 generated, so they can be replaced by the short ones. */
function legacyLabel(spec: SwitchSpec): string {
  return spec.subtype === SUBTYPE.optionalMode('speed') ? 'Fast Cool' : spec.label;
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

const ON_OFF_NAMES: Record<string, string> = {
  [CAP.switch]: 'power',
  [CAP.lighting]: 'display',
  [CAP.beep]: 'beep',
};

function describeCommand(command: Command): string {
  const name = ON_OFF_NAMES[command.capability];
  if (name && (command.command === 'on' || command.command === 'off')) {
    return `${name} ${command.command}`;
  }
  const args = (command.arguments ?? []).map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(', ');
  return `${command.command}(${args})`;
}
