import type { AcProfile, AcState } from './profile.js';

/** HomeKit HeaterCooler values, kept here so the mapping is testable without HAP. */
export const TargetState = { AUTO: 0, HEAT: 1, COOL: 2 } as const;
export const CurrentState = { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 } as const;

const COOL_MODES = ['cool', 'coolClean'];
const HEAT_MODES = ['heat', 'heatClean'];
const AUTO_MODES = ['auto', 'aIComfort'];
export const DRY_MODES = ['dry', 'dryClean'];
export const FAN_ONLY_MODES = ['wind', 'fanOnly'];

function pick(profile: AcProfile, candidates: string[]): string | undefined {
  return candidates.find(m => profile.modes.includes(m));
}

export function coolMode(profile: AcProfile) {
  return pick(profile, COOL_MODES);
}
export function heatMode(profile: AcProfile) {
  return pick(profile, HEAT_MODES);
}
export function autoMode(profile: AcProfile) {
  return pick(profile, AUTO_MODES);
}
export function dryMode(profile: AcProfile) {
  return pick(profile, DRY_MODES);
}
export function fanOnlyMode(profile: AcProfile) {
  return pick(profile, FAN_ONLY_MODES);
}

export function canHeat(profile: AcProfile): boolean {
  return heatMode(profile) !== undefined;
}

/** The HomeKit target states this unit can actually be put in. Always at least one. */
export function validTargetStates(profile: AcProfile): number[] {
  const states: number[] = [];
  if (autoMode(profile)) {
    states.push(TargetState.AUTO);
  }
  if (heatMode(profile)) {
    states.push(TargetState.HEAT);
  }
  if (coolMode(profile) || states.length === 0) {
    states.push(TargetState.COOL);
  }
  return states;
}

/** True for modes HomeKit has no word for (dry, fan only). */
export function isSpecialMode(mode: string | undefined): boolean {
  return mode !== undefined && (DRY_MODES.includes(mode) || FAN_ONLY_MODES.includes(mode));
}

export function modeToTargetState(mode: string | undefined, profile: AcProfile): number {
  const valid = validTargetStates(profile);
  let state: number | undefined;
  if (mode && COOL_MODES.includes(mode)) {
    state = TargetState.COOL;
  } else if (mode && HEAT_MODES.includes(mode)) {
    state = TargetState.HEAT;
  } else if (mode && AUTO_MODES.includes(mode)) {
    state = TargetState.AUTO;
  } else {
    // Dry / fan only: show Auto when HomeKit can show it, otherwise Cool.
    state = valid.includes(TargetState.AUTO) ? TargetState.AUTO : TargetState.COOL;
  }
  return valid.includes(state) ? state : valid[valid.length - 1];
}

export function targetStateToMode(state: number, profile: AcProfile): string | undefined {
  switch (state) {
    case TargetState.COOL:
      return coolMode(profile) ?? (profile.modes.length === 0 ? 'cool' : undefined);
    case TargetState.HEAT:
      return heatMode(profile);
    case TargetState.AUTO:
      return autoMode(profile);
    default:
      return undefined;
  }
}

export function currentHeaterCoolerState(state: AcState, profile: AcProfile): number {
  if (state.power !== true) {
    return CurrentState.INACTIVE;
  }
  const { mode, currentTemperature: current, targetTemperature: target } = state;
  const known = typeof current === 'number' && typeof target === 'number';

  if (mode && COOL_MODES.includes(mode)) {
    return !known || current! > target! ? CurrentState.COOLING : CurrentState.IDLE;
  }
  if (mode && HEAT_MODES.includes(mode)) {
    return !known || current! < target! ? CurrentState.HEATING : CurrentState.IDLE;
  }
  if (mode && AUTO_MODES.includes(mode)) {
    if (!known) {
      return CurrentState.IDLE;
    }
    if (current! > target! + 0.5) {
      return CurrentState.COOLING;
    }
    if (current! < target! - 0.5 && canHeat(profile)) {
      return CurrentState.HEATING;
    }
    return CurrentState.IDLE;
  }
  return CurrentState.IDLE;
}

/**
 * Fan speeds become evenly spaced RotationSpeed steps, slowest first, with Auto (when the
 * unit has it) as the lowest step. Zero is never used for a speed, because the Home app
 * turns the accessory off when the slider reaches zero.
 */
export function fanSpeedStep(profile: AcProfile): number {
  return profile.fanModes.length > 0 ? 100 / profile.fanModes.length : 100;
}

export function fanModeToSpeed(fanMode: string | undefined, profile: AcProfile): number {
  const levels = profile.fanModes;
  if (levels.length === 0) {
    return 100;
  }
  const index = fanMode ? levels.indexOf(fanMode) : -1;
  const position = index === -1 ? 0 : index;
  return round2((position + 1) * fanSpeedStep(profile));
}

export function speedToFanMode(speed: number, profile: AcProfile): string | undefined {
  const levels = profile.fanModes;
  if (levels.length === 0 || !(speed > 0)) {
    return undefined;
  }
  // Nearest step: HomeKit snaps the slider to minStep, but floats like 66.67 must not tip into the next speed.
  const index = Math.min(levels.length - 1, Math.max(0, Math.round(speed / fanSpeedStep(profile)) - 1));
  return levels[index];
}

export function isSwinging(oscillation: string | undefined): boolean {
  return oscillation !== undefined && oscillation !== 'fixed';
}

export function swingToOscillation(enabled: boolean, profile: AcProfile, preferred: string): string | undefined {
  const modes = profile.oscillationModes;
  if (!enabled) {
    return modes.includes('fixed') || modes.length === 0 ? 'fixed' : undefined;
  }
  if (modes.includes(preferred)) {
    return preferred;
  }
  return ['all', 'vertical', 'horizontal'].find(m => modes.includes(m)) ?? modes.find(m => m !== 'fixed');
}

/** Device-unit setpoint for a HomeKit (°C) value, clamped to the unit's range. */
export function clampSetpoint(celsius: number, profile: AcProfile): number {
  const { min, max, step } = profile.setpoint;
  return Math.min(max, Math.max(min, Math.round(celsius / step) * step));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
