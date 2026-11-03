import { describe, expect, it } from 'vitest';

import {
  CurrentState,
  TargetState,
  clampSetpoint,
  currentHeaterCoolerState,
  fanLevels,
  fanModeToSpeed,
  modeToTargetState,
  speedToFanMode,
  swingCommands,
  swingFor,
  targetStateToMode,
  validTargetStates,
} from '../src/ac/mapping.js';
import { buildProfile, describeProfile, isAirConditioner, orderFanModes, parseState } from '../src/ac/profile.js';
import { rac01011Device, rac01011Status, windFreeDevice, windFreeStatus } from './fixtures.js';

describe('profile', () => {
  const profile = buildProfile(windFreeDevice(), windFreeStatus());

  it('recognises Samsung ACs and ignores other devices', () => {
    expect(isAirConditioner(windFreeDevice())).toBe(true);
    expect(isAirConditioner({ deviceId: 'tv', components: [{ id: 'main', capabilities: [{ id: 'switch' }, { id: 'tvChannel' }] }] })).toBe(false);
  });

  it('reads modes, fan speeds, swing and extras', () => {
    expect(profile.modes).toEqual(['cool', 'dry', 'wind', 'auto']);
    expect(profile.fanModes).toEqual(['auto', 'low', 'medium', 'high', 'turbo']);
    expect(profile.oscillationModes).toEqual(['fixed', 'all', 'vertical', 'horizontal']);
    expect(profile.swing).toEqual({ source: 'oscillation', vertical: true, horizontal: true });
    expect(profile.optionalModes).toContain('windFree');
    expect(profile.setpoint).toEqual({ min: 16, max: 30, step: 1 });
    expect(describeProfile(profile)).toContain('range: 16–30 °C');
  });

  it('drops capabilities the unit lists as disabled', () => {
    expect(profile.capabilities.has('custom.spiMode')).toBe(false);
    expect(profile.capabilities.has('audioVolume')).toBe(false);
    expect(profile.capabilities.has('samsungce.airConditionerLighting')).toBe(true);
  });

  it('parses the current state', () => {
    expect(parseState(windFreeStatus(), profile)).toEqual({
      power: false, mode: 'cool', currentTemperature: 29, targetTemperature: 24, humidity: 58,
      fanMode: 'auto', swingVertical: false, swingHorizontal: false, optionalMode: 'off', autoClean: true, lighting: true,
    });
  });

  it('converts a Fahrenheit unit to Celsius with half-degree steps', () => {
    const status = windFreeStatus({
      'temperatureMeasurement': { temperature: { value: 80, unit: 'F' } },
      'thermostatCoolingSetpoint': { coolingSetpoint: { value: 72, unit: 'F' } },
      'custom.thermostatSetpointControl': { minimumSetpoint: { value: 61, unit: 'F' }, maximumSetpoint: { value: 86, unit: 'F' } },
    });
    const fProfile = buildProfile(windFreeDevice(), status);
    expect(fProfile.unit).toBe('F');
    expect(fProfile.setpoint.step).toBe(0.5);
    expect(fProfile.setpoint.min).toBe(16);
    expect(fProfile.setpoint.max).toBe(30);
    const state = parseState(status, fProfile);
    expect(state.currentTemperature).toBeCloseTo(26.7, 1);
    expect(state.targetTemperature).toBeCloseTo(22.2, 1);
  });

  it('falls back to sensible defaults when the unit reports nothing', () => {
    const bare = buildProfile(windFreeDevice(), { components: { main: {} } });
    expect(bare.modes).toEqual(['cool', 'dry', 'wind', 'auto']);
    expect(bare.setpoint).toEqual({ min: 16, max: 30, step: 1 });
  });

  it('reads a 2025 unit that swings through the air-flow capability', () => {
    const rac = buildProfile(rac01011Device(), rac01011Status());
    expect(rac.modes).toEqual(['auto', 'cool', 'dry', 'fan']);
    expect(rac.swing).toEqual({ source: 'airFlow', vertical: true, horizontal: true });
    expect(rac.capabilities.has('relativeHumidityMeasurement')).toBe(false);
    expect(rac.optionalModes).toEqual(['off', 'sleep', 'quiet', 'speed']);
    expect(describeProfile(rac)).toContain('swing: up/down + left/right');
    const state = parseState(rac01011Status({
      'samsungce.airConditionerAirFlowDirection': { verticalDirection: { value: 'swing' }, horizontalDirection: { value: 'fixed' } },
    }), rac);
    expect(state).toMatchObject({ swingVertical: true, swingHorizontal: false, beep: true, filterUsage: 77, filterStatus: 'normal', fanMode: 'low' });
    expect(state.humidity).toBeUndefined();
  });

  it('orders fan speeds slowest first', () => {
    expect(orderFanModes(['turbo', 'high', 'auto', 'low', 'medium', 'boost'])).toEqual(['auto', 'low', 'medium', 'high', 'turbo', 'boost']);
  });
});

describe('HomeKit mapping', () => {
  const profile = buildProfile(windFreeDevice(), windFreeStatus());
  const heatPump = buildProfile(windFreeDevice(), windFreeStatus({
    airConditionerMode: { supportedAcModes: { value: ['auto', 'cool', 'dry', 'wind', 'heat'] }, airConditionerMode: { value: 'heat' } },
  }));

  it('only offers modes the unit has', () => {
    expect(validTargetStates(profile)).toEqual([TargetState.AUTO, TargetState.COOL]);
    expect(validTargetStates(heatPump)).toEqual([TargetState.AUTO, TargetState.HEAT, TargetState.COOL]);
    expect(targetStateToMode(TargetState.HEAT, profile)).toBeUndefined();
    expect(targetStateToMode(TargetState.HEAT, heatPump)).toBe('heat');
  });

  it('shows dry and fan-only as Auto, or Cool for units without Auto', () => {
    expect(modeToTargetState('dry', profile)).toBe(TargetState.AUTO);
    const coolOnly = { ...profile, modes: ['cool', 'dry', 'wind'] };
    expect(modeToTargetState('wind', coolOnly)).toBe(TargetState.COOL);
    expect(validTargetStates(coolOnly)).toEqual([TargetState.COOL]);
  });

  it('works out whether the unit is actively cooling', () => {
    expect(currentHeaterCoolerState({ power: false, mode: 'cool' }, profile)).toBe(CurrentState.INACTIVE);
    expect(currentHeaterCoolerState({ power: true, mode: 'cool', currentTemperature: 29, targetTemperature: 24 }, profile)).toBe(CurrentState.COOLING);
    expect(currentHeaterCoolerState({ power: true, mode: 'cool', currentTemperature: 23, targetTemperature: 24 }, profile)).toBe(CurrentState.IDLE);
    expect(currentHeaterCoolerState({ power: true, mode: 'dry' }, profile)).toBe(CurrentState.IDLE);
    expect(currentHeaterCoolerState({ power: true, mode: 'auto', currentTemperature: 20, targetTemperature: 24 }, profile)).toBe(CurrentState.IDLE);
    expect(currentHeaterCoolerState({ power: true, mode: 'auto', currentTemperature: 20, targetTemperature: 24 }, heatPump)).toBe(CurrentState.HEATING);
  });

  it('maps fan speeds to slider steps and back without using zero', () => {
    const withAuto = fanLevels(profile, true);
    expect(withAuto.map(m => fanModeToSpeed(m, withAuto))).toEqual([20, 40, 60, 80, 100]);
    for (const mode of withAuto) {
      expect(speedToFanMode(fanModeToSpeed(mode, withAuto), withAuto)).toBe(mode);
    }
    expect(speedToFanMode(0, withAuto)).toBeUndefined();
    expect(speedToFanMode(1, withAuto)).toBe('auto');
    expect(speedToFanMode(55, withAuto)).toBe('medium');

    const manual = fanLevels(profile, false);
    expect(manual).toEqual(['low', 'medium', 'high', 'turbo']);
    expect(manual.map(m => fanModeToSpeed(m, manual))).toEqual([25, 50, 75, 100]);
    expect(speedToFanMode(100, manual)).toBe('turbo');

    const three = ['low', 'medium', 'high'];
    expect(three.map(m => speedToFanMode(fanModeToSpeed(m, three), three))).toEqual(three);
  });

  it('maps the Oscillate toggle to the preferred swing direction', () => {
    expect(swingFor(true, 'all', profile)).toEqual({ vertical: true, horizontal: true });
    expect(swingFor(true, 'vertical', profile)).toEqual({ vertical: true, horizontal: false });
    expect(swingFor(false, 'all', profile)).toEqual({ vertical: false, horizontal: false });
    const leftRightOnly = { ...profile, swing: { source: 'airFlow' as const, vertical: false, horizontal: true } };
    expect(swingFor(true, 'vertical', leftRightOnly)).toEqual({ vertical: false, horizontal: true });
  });

  it('turns a swing wish into the right SmartThings commands', () => {
    expect(swingCommands({ vertical: true, horizontal: false }, profile))
      .toEqual([{ capability: 'fanOscillationMode', command: 'setFanOscillationMode', arguments: ['vertical'] }]);
    expect(swingCommands({ vertical: false, horizontal: false }, profile)[0].arguments).toEqual(['fixed']);
    const onlyAll = { ...profile, oscillationModes: ['fixed', 'all'] };
    expect(swingCommands({ vertical: true, horizontal: false }, onlyAll)[0].arguments).toEqual(['all']);

    const rac = buildProfile(rac01011Device(), rac01011Status());
    expect(swingCommands({ vertical: true, horizontal: false }, rac)).toEqual([
      { capability: 'samsungce.airConditionerAirFlowDirection', command: 'setVerticalDirection', arguments: ['swing'] },
      { capability: 'samsungce.airConditionerAirFlowDirection', command: 'setHorizontalDirection', arguments: ['fixed'] },
    ]);
  });

  it('recognises "fan" as fan-only mode', () => {
    const rac = buildProfile(rac01011Device(), rac01011Status());
    expect(modeToTargetState('fan', rac)).toBe(TargetState.AUTO);
    expect(currentHeaterCoolerState({ power: true, mode: 'fan' }, rac)).toBe(CurrentState.IDLE);
  });

  it('clamps and rounds setpoints to what the unit accepts', () => {
    expect(clampSetpoint(10, profile)).toBe(16);
    expect(clampSetpoint(35, profile)).toBe(30);
    expect(clampSetpoint(23.6, profile)).toBe(24);
  });
});
