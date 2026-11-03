import * as hap from '@homebridge/hap-nodejs';
import type { API, PlatformAccessory } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PaperclipAirConditioner, type AccessoryContext } from '../src/accessory.js';
import { buildProfile } from '../src/ac/profile.js';
import { parseConfig } from '../src/config.js';
import type { Command } from '../src/smartthings/client.js';
import { SmartThingsApiError, type SmartThingsClient } from '../src/smartthings/client.js';
import type { Device, DeviceStatus } from '../src/smartthings/types.js';
import { rac01011Device, rac01011Status, windFreeDevice, windFreeStatus } from './fixtures.js';

const { Characteristic: C, Service: S } = hap;

class FakePlatformAccessory extends hap.Accessory {
  context: Record<string, unknown> = {};
}

function setup(options: { config?: Record<string, unknown>; status?: DeviceStatus; device?: Device } = {}) {
  const status = options.status ?? windFreeStatus();
  const device = options.device ?? windFreeDevice();
  const profile = buildProfile(device, status);
  const sent: Command[][] = [];
  const client = {
    getStatus: vi.fn(async () => status),
    executeCommands: vi.fn(async (_id: string, commands: Command[]) => {
      sent.push(commands);
    }),
  };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const api = { hap, updatePlatformAccessories: vi.fn() } as unknown as API;
  const accessory = new FakePlatformAccessory('Bedroom AC', hap.uuid.generate('test')) as unknown as PlatformAccessory<AccessoryContext>;
  const ac = new PaperclipAirConditioner(
    { api, log, client: client as unknown as SmartThingsClient, config: parseConfig(options.config ?? {}) },
    accessory,
    device,
    profile,
    status,
  );
  const heaterCooler = accessory.getService(S.HeaterCooler)!;
  const char = (type: hap.WithUUID<new () => hap.Characteristic>) => heaterCooler.getCharacteristic(type);
  return { ac, accessory, client, sent, log, heaterCooler, char };
}

async function write(characteristic: hap.Characteristic, value: hap.CharacteristicValue) {
  const pending = characteristic.handleSetRequest(value);
  await vi.advanceTimersByTimeAsync(300);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PaperclipAirConditioner', () => {
  it('builds a HeaterCooler that matches what the unit can do', () => {
    const { accessory, char, heaterCooler } = setup();

    expect(char(C.TargetHeaterCoolerState).props.validValues).toEqual([0, 2]);
    expect(char(C.CoolingThresholdTemperature).props).toMatchObject({ minValue: 16, maxValue: 30, minStep: 1 });
    // With a Fan tile holding the Auto toggle, the AC tile's slider only has the four manual speeds.
    expect(char(C.RotationSpeed).props.minStep).toBe(25);
    expect(heaterCooler.testCharacteristic(C.SwingMode)).toBe(true);
    expect(heaterCooler.testCharacteristic(C.HeatingThresholdTemperature)).toBe(false);

    const subtypes = accessory.services.map(s => s.subtype).filter(Boolean).sort();
    expect(subtypes).toEqual([
      'dry', 'fan-speed', 'humidity', 'mode-quiet', 'mode-sleep', 'mode-speed', 'mode-windFree', 'mode-windFreeSleep',
      'swing-horizontal', 'swing-vertical',
    ]);
    expect(char(C.CurrentTemperature).value).toBe(29);
    expect(char(C.CoolingThresholdTemperature).value).toBe(24);
    expect(char(C.Active).value).toBe(0);
  });

  it('batches power and mode into a single SmartThings request, power first', async () => {
    const { char, sent } = setup();
    const a = char(C.Active).handleSetRequest(1);
    const b = char(C.TargetHeaterCoolerState).handleSetRequest(C.TargetHeaterCoolerState.COOL);
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all([a, b]);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([
      { capability: 'switch', command: 'on' },
      { capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['cool'] },
    ]);
    expect(char(C.Active).value).toBe(1);
  });

  it('sets the temperature in the unit\'s own scale', async () => {
    const { char, sent } = setup();
    await write(char(C.CoolingThresholdTemperature), 22);
    expect(sent[0]).toEqual([{ capability: 'thermostatCoolingSetpoint', command: 'setCoolingSetpoint', arguments: [22] }]);

    const f = setup({
      status: windFreeStatus({ thermostatCoolingSetpoint: { coolingSetpoint: { value: 75, unit: 'F' } } }),
    });
    await write(f.char(C.CoolingThresholdTemperature), 22);
    expect(f.sent[0][0].arguments).toEqual([72]);
  });

  it('keeps a just-written value when a stale poll arrives', async () => {
    const { ac, char } = setup();
    await write(char(C.CoolingThresholdTemperature), 20);
    ac.applyStatus(windFreeStatus()); // still says 24
    expect(char(C.CoolingThresholdTemperature).value).toBe(20);

    await vi.advanceTimersByTimeAsync(13_000);
    ac.applyStatus(windFreeStatus());
    expect(char(C.CoolingThresholdTemperature).value).toBe(24);
  });

  it('maps fan slider steps to Samsung fan modes', async () => {
    const { char, sent } = setup();
    await write(char(C.RotationSpeed), 80);
    expect(sent[0]).toEqual([{ capability: 'airConditionerFanMode', command: 'setFanMode', arguments: ['high'] }]);
    await write(char(C.RotationSpeed), 0);
    expect(sent).toHaveLength(1);
  });

  it('uses the Dry switch to enter dry mode and return to the previous mode', async () => {
    const { accessory, sent, ac } = setup({
      status: windFreeStatus({ switch: { switch: { value: 'on' } }, airConditionerMode: { supportedAcModes: { value: ['cool', 'dry', 'wind', 'auto'] }, airConditionerMode: { value: 'auto' } } }),
    });
    const dry = accessory.getServiceById(S.Switch, 'dry')!.getCharacteristic(C.On);

    await write(dry, true);
    expect(sent[0]).toEqual([{ capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['dry'] }]);
    expect(accessory.context.modeBeforeSpecial).toBe('auto');
    expect(ac.currentState.mode).toBe('dry');

    await write(dry, false);
    expect(sent[1]).toEqual([{ capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['auto'] }]);
  });

  it('turns WindFree on (powering the unit up) and off', async () => {
    const { accessory, sent } = setup();
    const windFree = accessory.getServiceById(S.Switch, 'mode-windFree')!.getCharacteristic(C.On);
    await write(windFree, true);
    expect(sent[0]).toEqual([
      { capability: 'switch', command: 'on' },
      { capability: 'custom.airConditionerOptionalMode', command: 'setAcOptionalMode', arguments: ['windFree'] },
    ]);
    await write(windFree, false);
    expect(sent[1]).toEqual([{ capability: 'custom.airConditionerOptionalMode', command: 'setAcOptionalMode', arguments: ['off'] }]);
  });

  it('adds optional switches only when asked and supported', () => {
    const { accessory } = setup({ config: { displaySwitch: true, autoCleanSwitch: true, fanModeSwitch: true, optionalModeSwitches: ['quiet', 'notAMode'] } });
    const subtypes = accessory.services.map(s => s.subtype).filter(Boolean).sort();
    expect(subtypes).toEqual(['autoclean', 'display', 'dry', 'fan', 'fan-speed', 'humidity', 'mode-quiet', 'swing-horizontal', 'swing-vertical']);
  });

  it('keeps the old single-slider behaviour when the Fan tile is turned off', () => {
    const { accessory, char } = setup({ config: { fanTile: false } });
    expect(char(C.RotationSpeed).props.minStep).toBe(20);
    expect(accessory.getServiceById(S.Fanv2, 'fan-speed')).toBeUndefined();
  });

  it('reports a failed command back to HomeKit', async () => {
    const { char, client, log } = setup();
    client.executeCommands.mockRejectedValueOnce(new SmartThingsApiError('boom', 500));
    const pending = char(C.Active).handleSetRequest(1).catch(e => e);
    await vi.advanceTimersByTimeAsync(300);
    // HAP turns the thrown HapStatusError into the status code the Home app receives.
    expect(await pending).toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('could not send power on'));
  });

  it('shows No Response after repeated refresh failures and recovers', async () => {
    const { ac, client, char } = setup();
    client.getStatus.mockRejectedValue(new SmartThingsApiError('down', 503));
    await ac.refresh(true);
    await ac.refresh(true);
    await expect(char(C.Active).handleGetRequest()).resolves.toBe(0);
    await ac.refresh(true);
    await expect(char(C.Active).handleGetRequest()).rejects.toBeDefined();

    client.getStatus.mockResolvedValue(windFreeStatus({ switch: { switch: { value: 'on' } } }));
    await ac.refresh(true);
    await expect(char(C.Active).handleGetRequest()).resolves.toBe(1);
  });

  it('backs off after a rate limit', async () => {
    const { ac, client } = setup();
    client.getStatus.mockRejectedValueOnce(new SmartThingsApiError('slow down', 429, 30_000));
    await ac.refresh();
    await ac.refresh();
    expect(client.getStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    await ac.refresh();
    expect(client.getStatus).toHaveBeenCalledTimes(2);
  });
});

describe('a 2025 unit with air-flow swing (DA-AC-RAC-01011)', () => {
  const rac = (config: Record<string, unknown> = {}) =>
    setup({ device: rac01011Device(), status: rac01011Status(), config: { fanModeSwitch: true, beepSwitch: true, ...config } });

  it('exposes a Fan tile, both swing axes, Sleep/Quiet/Turbo and filter life', () => {
    const { accessory, heaterCooler } = rac();
    const subtypes = accessory.services.map(s => s.subtype).filter(Boolean).sort();
    expect(subtypes).toEqual([
      'beep', 'dry', 'fan', 'fan-speed', 'filter', 'mode-quiet', 'mode-sleep', 'mode-speed', 'swing-horizontal', 'swing-vertical',
    ]);
    expect(accessory.getServiceById(S.Switch, 'mode-speed')!.getCharacteristic(C.Name).value).toBe('Samsung Room A/C Turbo');
    expect(heaterCooler.testCharacteristic(C.SwingMode)).toBe(true);

    const fan = accessory.getServiceById(S.Fanv2, 'fan-speed')!;
    expect(fan.getCharacteristic(C.TargetFanState).value).toBe(C.TargetFanState.MANUAL);
    expect(fan.getCharacteristic(C.RotationSpeed).value).toBe(25);
    expect(fan.getCharacteristic(C.RotationSpeed).props.minStep).toBe(25);

    const filter = accessory.getServiceById(S.FilterMaintenance, 'filter')!;
    expect(filter.getCharacteristic(C.FilterLifeLevel).value).toBe(23);
    expect(filter.getCharacteristic(C.FilterChangeIndication).value).toBe(C.FilterChangeIndication.FILTER_OK);
    expect(heaterCooler.linkedServices).toContain(fan);
  });

  it('switches the fan to Auto and back to the last manual speed', async () => {
    const { accessory, sent } = rac();
    const fan = accessory.getServiceById(S.Fanv2, 'fan-speed')!;
    await write(fan.getCharacteristic(C.RotationSpeed), 100);
    expect(sent[0]).toEqual([{ capability: 'airConditionerFanMode', command: 'setFanMode', arguments: ['turbo'] }]);
    await write(fan.getCharacteristic(C.TargetFanState), C.TargetFanState.AUTO);
    expect(sent[1]).toEqual([{ capability: 'airConditionerFanMode', command: 'setFanMode', arguments: ['auto'] }]);
    expect(fan.getCharacteristic(C.RotationSpeed).value).toBe(100);
    await write(fan.getCharacteristic(C.TargetFanState), C.TargetFanState.MANUAL);
    expect(sent[2]).toEqual([{ capability: 'airConditionerFanMode', command: 'setFanMode', arguments: ['turbo'] }]);
  });

  it('swings both axes from Oscillate and one axis from its own switch', async () => {
    const { accessory, char, sent } = rac();
    await write(char(C.SwingMode), C.SwingMode.SWING_ENABLED);
    expect(sent[0]).toEqual([
      { capability: 'samsungce.airConditionerAirFlowDirection', command: 'setVerticalDirection', arguments: ['swing'] },
      { capability: 'samsungce.airConditionerAirFlowDirection', command: 'setHorizontalDirection', arguments: ['swing'] },
    ]);
    const leftRight = accessory.getServiceById(S.Switch, 'swing-horizontal')!.getCharacteristic(C.On);
    expect(leftRight.value).toBe(true);
    await write(leftRight, false);
    expect(sent[1]).toEqual([
      { capability: 'samsungce.airConditionerAirFlowDirection', command: 'setHorizontalDirection', arguments: ['fixed'] },
    ]);
    expect(char(C.SwingMode).value).toBe(C.SwingMode.SWING_ENABLED);
  });

  it('turns on Turbo and Fan Only, and resets the filter', async () => {
    const { accessory, sent } = rac();
    await write(accessory.getServiceById(S.Switch, 'mode-speed')!.getCharacteristic(C.On), true);
    expect(sent[0]).toEqual([{ capability: 'custom.airConditionerOptionalMode', command: 'setAcOptionalMode', arguments: ['speed'] }]);

    const fanOnly = accessory.getServiceById(S.Switch, 'fan')!.getCharacteristic(C.On);
    await write(fanOnly, true);
    expect(sent[1]).toEqual([{ capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['fan'] }]);
    await write(fanOnly, false);
    expect(sent[2]).toEqual([{ capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['cool'] }]);

    await write(accessory.getServiceById(S.FilterMaintenance, 'filter')!.getCharacteristic(C.ResetFilterIndication), 1);
    expect(sent[3]).toEqual([{ capability: 'custom.dustFilter', command: 'resetDustFilter' }]);
  });

  it('flags a dirty filter and toggles the beep', async () => {
    const { accessory, ac, sent } = rac();
    ac.applyStatus(rac01011Status({ 'custom.dustFilter': { dustFilterUsage: { value: 100 }, dustFilterStatus: { value: 'wash' } } }));
    const filter = accessory.getServiceById(S.FilterMaintenance, 'filter')!;
    expect(filter.getCharacteristic(C.FilterChangeIndication).value).toBe(C.FilterChangeIndication.CHANGE_FILTER);
    expect(filter.getCharacteristic(C.FilterLifeLevel).value).toBe(0);

    await write(accessory.getServiceById(S.Switch, 'beep')!.getCharacteristic(C.On), false);
    expect(sent[0]).toEqual([{ capability: 'samsungce.airConditionerBeep', command: 'off' }]);
  });
});
