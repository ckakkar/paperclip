import type { Command } from '../smartthings/client.js';
import { CAP, type AcProfile, type AcState } from './profile.js';

/** HomeKit HeaterCooler values, kept here so the mapping is testable without HAP. */
export const TargetState = { AUTO: 0, HEAT: 1, COOL: 2 } as const;
export const CurrentState = { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 } as const;

const COOL_MODES = ['cool', 'coolClean'];
const HEAT_MODES = ['heat', 'heatClean'];
const AUTO_MODES = ['auto', 'aIComfort'];
export const DRY_MODES = ['dry', 'dryClean'];
/** Samsung uses all three names for fan-only, depending on the model. */
export const FAN_ONLY_MODES = ['wind', 'fan', 'fanOnly'];

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
  let state: number;
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

// -----------------------------------------------------------------------------
// Fan speed
// -----------------------------------------------------------------------------

export function hasAutoFan(profile: AcProfile): boolean {
  return profile.fanModes.includes('auto');
}

/** Speeds the slider can pick, slowest first. Auto is left out when a separate Auto toggle exists. */
export function fanLevels(profile: AcProfile, includeAuto: boolean): string[] {
  return includeAuto ? profile.fanModes : profile.fanModes.filter(m => m !== 'auto');
}

/**
 * Speeds become evenly spaced RotationSpeed steps, slowest first. Zero is never used for a
 * speed, because the Home app turns the accessory off when the slider reaches zero.
 */
export function fanSpeedStep(levels: string[]): number {
  return levels.length > 0 ? 100 / levels.length : 100;
}

export function fanModeToSpeed(fanMode: string | undefined, levels: string[]): number {
  if (levels.length === 0) {
    return 100;
  }
  const index = fanMode ? levels.indexOf(fanMode) : -1;
  return round2((Math.max(0, index) + 1) * fanSpeedStep(levels));
}

export function speedToFanMode(speed: number, levels: string[]): string | undefined {
  if (levels.length === 0 || !(speed > 0)) {
    return undefined;
  }
  // Nearest step: HomeKit snaps the slider to minStep, but floats like 66.67 must not tip into the next speed.
  const index = Math.min(levels.length - 1, Math.max(0, Math.round(speed / fanSpeedStep(levels)) - 1));
  return levels[index];
}

/** The speed to fall back to when leaving Auto, or to show on the slider while in Auto. */
export function defaultManualFan(profile: AcProfile): string | undefined {
  const manual = fanLevels(profile, false);
  return manual.includes('medium') ? 'medium' : manual[Math.floor((manual.length - 1) / 2)];
}

// -----------------------------------------------------------------------------
// Swing
// -----------------------------------------------------------------------------

export interface SwingWish {
  vertical: boolean;
  horizontal: boolean;
}

export function isSwinging(state: AcState): boolean {
  return state.swingVertical === true || state.swingHorizontal === true;
}

/** What turning the HomeKit "Oscillate" toggle on or off should mean for this unit. */
export function swingFor(enabled: boolean, preference: 'all' | 'vertical' | 'horizontal', profile: AcProfile): SwingWish {
  const { vertical, horizontal } = profile.swing;
  if (!enabled) {
    return { vertical: false, horizontal: false };
  }
  if (preference === 'vertical' && vertical) {
    return { vertical: true, horizontal: false };
  }
  if (preference === 'horizontal' && horizontal) {
    return { vertical: false, horizontal: true };
  }
  if (preference !== 'all') {
    // The preferred axis is missing; swing the one the unit has.
    return { vertical, horizontal: !vertical && horizontal };
  }
  return { vertical, horizontal };
}

/** SmartThings commands that put the unit's swing into the wished state. */
export function swingCommands(wish: SwingWish, profile: AcProfile): Command[] {
  const { source, vertical, horizontal } = profile.swing;
  if (source === 'airFlow') {
    const commands: Command[] = [];
    if (vertical) {
      commands.push({ capability: CAP.airFlow, command: 'setVerticalDirection', arguments: [wish.vertical ? 'swing' : 'fixed'] });
    }
    if (horizontal) {
      commands.push({ capability: CAP.airFlow, command: 'setHorizontalDirection', arguments: [wish.horizontal ? 'swing' : 'fixed'] });
    }
    return commands;
  }
  if (source === 'oscillation') {
    const modes = profile.oscillationModes;
    let mode: string | undefined;
    if (wish.vertical && wish.horizontal) {
      mode = 'all';
    } else if (wish.vertical) {
      mode = 'vertical';
    } else if (wish.horizontal) {
      mode = 'horizontal';
    } else {
      mode = 'fixed';
    }
    if (!modes.includes(mode)) {
      mode = mode === 'fixed' ? undefined : modes.find(m => m !== 'fixed');
    }
    return mode ? [{ capability: CAP.oscillation, command: 'setFanOscillationMode', arguments: [mode] }] : [];
  }
  return [];
}

// -----------------------------------------------------------------------------
// Temperature
// -----------------------------------------------------------------------------

/** HomeKit (°C) value clamped and rounded to what the unit accepts. */
export function clampSetpoint(celsius: number, profile: AcProfile): number {
  const { min, max, step } = profile.setpoint;
  return Math.min(max, Math.max(min, Math.round(celsius / step) * step));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
