import type { ComponentStatus, Device, DeviceStatus } from '../smartthings/types.js';

/** SmartThings capabilities Paperclip understands on a Samsung air conditioner. */
export const CAP = {
  switch: 'switch',
  mode: 'airConditionerMode',
  coolingSetpoint: 'thermostatCoolingSetpoint',
  temperature: 'temperatureMeasurement',
  humidity: 'relativeHumidityMeasurement',
  fanMode: 'airConditionerFanMode',
  oscillation: 'fanOscillationMode',
  optionalMode: 'custom.airConditionerOptionalMode',
  autoClean: 'custom.autoCleaningMode',
  lighting: 'samsungce.airConditionerLighting',
  execute: 'execute',
  setpointControl: 'custom.thermostatSetpointControl',
  disabled: 'custom.disabledCapabilities',
} as const;

export type TemperatureUnit = 'C' | 'F';

/** What a particular unit can do. Built once at discovery, refreshed when the device reports new lists. */
export interface AcProfile {
  /** Capabilities on the main component, minus the ones the unit marks as disabled. */
  capabilities: Set<string>;
  modes: string[];
  fanModes: string[];
  oscillationModes: string[];
  optionalModes: string[];
  unit: TemperatureUnit;
  /** Target temperature range in °C (HomeKit only speaks Celsius). */
  setpoint: { min: number; max: number; step: number };
}

/** The current state of a unit, in HomeKit-friendly units. */
export interface AcState {
  power?: boolean;
  mode?: string;
  currentTemperature?: number;
  targetTemperature?: number;
  humidity?: number;
  fanMode?: string;
  oscillation?: string;
  optionalMode?: string;
  autoClean?: boolean;
  lighting?: boolean;
}

const REQUIRED = [CAP.switch, CAP.mode];

/** Default modes for a unit that does not report a list (cooling-only, like most WindFree units sold in India). */
const FALLBACK_MODES = ['cool', 'dry', 'wind', 'auto'];
const FALLBACK_FAN_MODES = ['auto', 'low', 'medium', 'high', 'turbo'];

/** Fan speeds from slowest to fastest; unknown values keep their reported order after these. */
const FAN_ORDER = ['auto', 'quiet', 'sleep', 'low', 'medium', 'mid', 'high', 'turbo', 'max'];

export function mainComponent(device: Device) {
  return device.components?.find(c => c.id === 'main') ?? device.components?.[0];
}

export function mainStatus(status: DeviceStatus): ComponentStatus {
  return status.components?.main ?? {};
}

export function isAirConditioner(device: Device): boolean {
  const main = mainComponent(device);
  if (!main) {
    return false;
  }
  const ids = new Set(main.capabilities.map(c => c.id));
  if (REQUIRED.every(id => ids.has(id))) {
    return true;
  }
  return Boolean(main.categories?.some(c => c.name === 'AirConditioner') && ids.has(CAP.switch));
}

export function readValue(status: ComponentStatus, capability: string, attribute: string): unknown {
  return status[capability]?.[attribute]?.value;
}

function readUnit(status: ComponentStatus, capability: string, attribute: string): string | undefined {
  return status[capability]?.[attribute]?.unit;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : [];
}

function firstNonEmpty(...lists: string[][]): string[] {
  return lists.find(list => list.length > 0) ?? [];
}

export function toCelsius(value: number, unit: TemperatureUnit): number {
  return unit === 'F' ? (value - 32) * 5 / 9 : value;
}

export function fromCelsius(value: number, unit: TemperatureUnit): number {
  return unit === 'F' ? value * 9 / 5 + 32 : value;
}

export function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export function orderFanModes(modes: string[]): string[] {
  const known = FAN_ORDER.filter(m => modes.includes(m));
  const unknown = modes.filter(m => !FAN_ORDER.includes(m));
  return [...known, ...unknown];
}

export function buildProfile(device: Device, status: DeviceStatus): AcProfile {
  const main = mainStatus(status);
  const disabled = new Set(stringList(readValue(main, CAP.disabled, 'disabledCapabilities')));
  const capabilities = new Set(
    (mainComponent(device)?.capabilities ?? []).map(c => c.id).filter(id => !disabled.has(id)),
  );

  const unitRaw = readUnit(main, CAP.coolingSetpoint, 'coolingSetpoint') ?? readUnit(main, CAP.temperature, 'temperature');
  const unit: TemperatureUnit = unitRaw === 'F' ? 'F' : 'C';

  const modes = firstNonEmpty(
    stringList(readValue(main, CAP.mode, 'supportedAcModes')),
    stringList(readValue(main, CAP.mode, 'availableAcModes')),
    FALLBACK_MODES,
  );

  const fanModes = capabilities.has(CAP.fanMode)
    ? orderFanModes(firstNonEmpty(
      stringList(readValue(main, CAP.fanMode, 'supportedAcFanModes')),
      stringList(readValue(main, CAP.fanMode, 'availableAcFanModes')),
      FALLBACK_FAN_MODES,
    ))
    : [];

  const oscillationModes = capabilities.has(CAP.oscillation)
    ? firstNonEmpty(
      stringList(readValue(main, CAP.oscillation, 'supportedFanOscillationModes')),
      stringList(readValue(main, CAP.oscillation, 'availableFanOscillationModes')),
      ['fixed', 'all'],
    )
    : [];

  const optionalModes = capabilities.has(CAP.optionalMode)
    ? stringList(readValue(main, CAP.optionalMode, 'supportedAcOptionalMode'))
    : [];

  return { capabilities, modes, fanModes, oscillationModes, optionalModes, unit, setpoint: setpointRange(main, unit) };
}

function setpointRange(main: ComponentStatus, unit: TemperatureUnit): AcProfile['setpoint'] {
  let min: number | undefined;
  let max: number | undefined;
  let step: number | undefined;

  const range = readValue(main, CAP.coolingSetpoint, 'coolingSetpointRange') as { minimum?: unknown; maximum?: unknown; step?: unknown } | null;
  if (range && typeof range === 'object') {
    min = typeof range.minimum === 'number' ? range.minimum : undefined;
    max = typeof range.maximum === 'number' ? range.maximum : undefined;
    step = typeof range.step === 'number' && range.step > 0 ? range.step : undefined;
  }

  const ctlMin = readValue(main, CAP.setpointControl, 'minimumSetpoint');
  const ctlMax = readValue(main, CAP.setpointControl, 'maximumSetpoint');
  if (typeof ctlMin === 'number') {
    min = ctlMin;
  }
  if (typeof ctlMax === 'number') {
    max = ctlMax;
  }

  const defaults = unit === 'F' ? { min: 61, max: 86 } : { min: 16, max: 30 };
  let minC = toCelsius(min ?? defaults.min, unit);
  let maxC = toCelsius(max ?? defaults.max, unit);
  if (!(maxC > minC) || minC < 0 || maxC > 50) {
    minC = 16;
    maxC = 30;
  }

  // A whole °F is 0.56 °C, so Fahrenheit units get half-degree steps to keep every setpoint reachable.
  const stepC = unit === 'F' ? 0.5 : (step === 0.5 ? 0.5 : 1);
  return { min: Math.floor(minC / stepC) * stepC, max: Math.ceil(maxC / stepC) * stepC, step: stepC };
}

export function parseState(status: DeviceStatus, profile: AcProfile): AcState {
  const main = mainStatus(status);
  const state: AcState = {};

  const power = readValue(main, CAP.switch, 'switch');
  if (power === 'on' || power === 'off') {
    state.power = power === 'on';
  }

  const mode = readValue(main, CAP.mode, 'airConditionerMode');
  if (typeof mode === 'string' && mode !== '' && mode !== 'notSupported') {
    state.mode = mode;
  }

  const temp = readValue(main, CAP.temperature, 'temperature');
  if (typeof temp === 'number' && Number.isFinite(temp)) {
    const unit = readUnit(main, CAP.temperature, 'temperature') === 'F' ? 'F' : readUnit(main, CAP.temperature, 'temperature') === 'C' ? 'C' : profile.unit;
    state.currentTemperature = Math.round(toCelsius(temp, unit) * 10) / 10;
  }

  const setpoint = readValue(main, CAP.coolingSetpoint, 'coolingSetpoint');
  if (typeof setpoint === 'number' && Number.isFinite(setpoint)) {
    const unit = readUnit(main, CAP.coolingSetpoint, 'coolingSetpoint') === 'F' ? 'F' : readUnit(main, CAP.coolingSetpoint, 'coolingSetpoint') === 'C' ? 'C' : profile.unit;
    state.targetTemperature = Math.round(toCelsius(setpoint, unit) * 10) / 10;
  }

  const humidity = readValue(main, CAP.humidity, 'humidity');
  if (typeof humidity === 'number' && Number.isFinite(humidity)) {
    state.humidity = Math.min(100, Math.max(0, humidity));
  }

  const fanMode = readValue(main, CAP.fanMode, 'fanMode');
  if (typeof fanMode === 'string' && fanMode !== '') {
    state.fanMode = fanMode;
  }

  const oscillation = readValue(main, CAP.oscillation, 'fanOscillationMode');
  if (typeof oscillation === 'string' && oscillation !== '') {
    state.oscillation = oscillation;
  }

  const optionalMode = readValue(main, CAP.optionalMode, 'acOptionalMode');
  if (typeof optionalMode === 'string' && optionalMode !== '') {
    state.optionalMode = optionalMode;
  }

  const autoClean = readValue(main, CAP.autoClean, 'autoCleaningMode');
  if (autoClean === 'on' || autoClean === 'off') {
    state.autoClean = autoClean === 'on';
  }

  const lighting = readValue(main, CAP.lighting, 'lighting');
  if (lighting === 'on' || lighting === 'off') {
    state.lighting = lighting === 'on';
  }

  return state;
}

/** One-line summary for logs and the setup UI. */
export function describeProfile(profile: AcProfile): string {
  const parts = [
    `modes: ${profile.modes.join('/') || 'unknown'}`,
    profile.fanModes.length ? `fan: ${profile.fanModes.join('/')}` : 'no fan speeds',
    profile.oscillationModes.length ? `swing: ${profile.oscillationModes.join('/')}` : 'no swing',
    profile.optionalModes.length ? `extras: ${profile.optionalModes.filter(m => m !== 'off').join('/')}` : 'no extra modes',
    `range: ${profile.setpoint.min}–${profile.setpoint.max} °C`,
    `unit: °${profile.unit}`,
  ];
  return parts.join(', ');
}
