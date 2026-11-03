import * as hap from '@homebridge/hap-nodejs';
import type { API, PlatformAccessory } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PaperclipAirConditioner, type AccessoryContext } from '../src/accessory.js';
import { buildProfile } from '../src/ac/profile.js';
import { parseConfig } from '../src/config.js';
import type { Command } from '../src/smartthings/client.js';
import { SmartThingsApiError, type SmartThingsClient } from '../src/smartthings/client.js';
import type { DeviceStatus } from '../src/smartthings/types.js';
import { windFreeDevice, windFreeStatus } from './fixtures.js';

const { Characteristic: C, Service: S } = hap;

class FakePlatformAccessory extends hap.Accessory {
  context: Record<string, unknown> = {};
}

function setup(options: { config?: Record<string, unknown>; status?: DeviceStatus } = {}) {
  const status = options.status ?? windFreeStatus();
  const device = windFreeDevice();
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
    expect(char(C.RotationSpeed).props.minStep).toBe(20);
    expect(heaterCooler.testCharacteristic(C.SwingMode)).toBe(true);
    expect(heaterCooler.testCharacteristic(C.HeatingThresholdTemperature)).toBe(false);

    const subtypes = accessory.services.map(s => s.subtype).filter(Boolean).sort();
    expect(subtypes).toEqual(['dry', 'humidity', 'mode-windFree']);
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
    expect(subtypes).toEqual(['autoclean', 'display', 'dry', 'fan', 'humidity', 'mode-quiet']);
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
