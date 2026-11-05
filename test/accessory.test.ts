import * as hap from '@homebridge/hap-nodejs';
import type { API, PlatformAccessory } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PaperclipAirConditioner, switchPlan, type AccessoryContext } from '../src/accessory.js';
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
  const config = parseConfig(options.config ?? {});
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
    { api, log, client: client as unknown as SmartThingsClient, config },
    accessory,
    device,
    profile,
    status,
  );
  const heaterCooler = accessory.getService(S.HeaterCooler)!;
  const fan = accessory.getServiceById(S.Fanv2, 'fan-speed');
  const char = (type: hap.WithUUID<new () => hap.Characteristic>) => heaterCooler.getCharacteristic(type);
  const toggle = (subtype: string) => accessory.getServiceById(S.Switch, subtype)!.getCharacteristic(C.On);
  const subtypes = (a: PlatformAccessory | undefined) => (a?.services ?? []).map(s => s.subtype).filter(Boolean).sort();
  return { ac, accessory, client, sent, log, heaterCooler, fan, char, toggle, subtypes, profile, config };
}

/** Writes like the Home app does, then lets the 250 ms command batch go out. Rejects with the HAP status on refusal. */
async function write(characteristic: hap.Characteristic, value: hap.CharacteristicValue) {
  let failure: { error: unknown } | undefined;
  const pending = characteristic.handleSetRequest(value).catch((error: unknown) => {
    failure = { error };
  });
  await vi.advanceTimersByTimeAsync(300);
  await pending;
  if (failure) {
    throw failure.error;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PaperclipAirConditioner', () => {
  it('lays the AC out like the Samsung app: one tile with the dial, Fan Speed and the mode toggles', () => {
    const { accessory, char, heaterCooler, fan, subtypes } = setup();

    expect(heaterCooler.getCharacteristic(C.ConfiguredName).value).toBe('Bedroom AC');
    expect(char(C.TargetHeaterCoolerState).props.validValues).toEqual([0, 2]);
    expect(char(C.CoolingThresholdTemperature).props).toMatchObject({ minValue: 16, maxValue: 30, minStep: 1 });
    // The Home app only lists Auto when both thresholds exist; both mirror Samsung's single setpoint.
    expect(char(C.HeatingThresholdTemperature).value).toBe(24);
    // Airflow lives only on Fan Speed, so there's one place to change it.
    expect(heaterCooler.testCharacteristic(C.RotationSpeed)).toBe(false);
    expect(heaterCooler.testCharacteristic(C.SwingMode)).toBe(false);

    expect(subtypes(accessory)).toEqual(['dry', 'fan', 'fan-speed', 'humidity', 'mode-quiet', 'mode-sleep', 'mode-speed', 'mode-windFree', 'mode-windFreeSleep']);
    const turbo = accessory.getServiceById(S.Switch, 'mode-speed')!;
    expect(heaterCooler.linkedServices).toContain(turbo);

    expect(fan!.getCharacteristic(C.ConfiguredName).value).toBe('Fan Speed');
    expect(fan!.getCharacteristic(C.RotationSpeed).props.minStep).toBe(25);
    expect(fan!.testCharacteristic(C.SwingMode)).toBe(true);
    expect(heaterCooler.linkedServices).toContain(fan);

    expect(char(C.CurrentTemperature).value).toBe(29);
    expect(char(C.CoolingThresholdTemperature).value).toBe(24);
    expect(char(C.Active).value).toBe(0);
  });

  it('names mode switches the short, native way', () => {
    const { accessory } = setup();
    const names = accessory.services.filter(s => s.UUID === S.Switch.UUID).map(s => s.getCharacteristic(C.ConfiguredName).value).sort();
    expect(names).toEqual(['Dry', 'Fan Only', 'Quiet', 'Sleep', 'Turbo', 'WindFree', 'WindFree Sleep']);
  });

  it('keeps a name the user set in the Home app', () => {
    const first = setup();
    first.fan!.getCharacteristic(C.ConfiguredName).setValue('Bedroom Breeze');
    // A restart re-runs setup on the cached accessory.
    const again = new PaperclipAirConditioner(
      { api: { hap, updatePlatformAccessories: vi.fn() } as unknown as API, log: first.log, client: first.client as unknown as SmartThingsClient, config: first.config },
      first.accessory, windFreeDevice(), first.profile, windFreeStatus(),
    );
    expect(again.accessory.getServiceById(S.Fanv2, 'fan-speed')!.getCharacteristic(C.ConfiguredName).value).toBe('Bedroom Breeze');
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

  it('maps Fan slider steps to Samsung fan speeds', async () => {
    const { fan, sent } = setup();
    await write(fan!.getCharacteristic(C.RotationSpeed), 75);
    expect(sent[0]).toEqual([{ capability: 'airConditionerFanMode', command: 'setFanMode', arguments: ['high'] }]);
    await write(fan!.getCharacteristic(C.RotationSpeed), 0);
    expect(sent).toHaveLength(1);
  });

  it('treats Fan Speed\'s on/off as the AC\'s power, like the remote, without changing the mode', async () => {
    const { ac, fan, char, sent } = setup({
      status: windFreeStatus({ airConditionerMode: { supportedAcModes: { value: ['cool', 'dry', 'wind', 'auto'] }, airConditionerMode: { value: 'auto' } } }),
    });
    // Dragging the slider up from off: the Home app sends Active and the speed together.
    const on = fan!.getCharacteristic(C.Active).handleSetRequest(1);
    const speed = fan!.getCharacteristic(C.RotationSpeed).handleSetRequest(50);
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all([on, speed]);
    expect(sent[0]).toEqual([
      { capability: 'switch', command: 'on' },
      { capability: 'airConditionerFanMode', command: 'setFanMode', arguments: ['medium'] },
    ]);
    expect(ac.currentState.mode).toBe('auto');
    expect(char(C.Active).value).toBe(1);

    await write(fan!.getCharacteristic(C.Active), 0);
    expect(sent[1]).toEqual([{ capability: 'switch', command: 'off' }]);
    expect(char(C.Active).value).toBe(0);
  });

  it('shows Fan Only as a running AC and switches it with its own toggle', async () => {
    const { ac, accessory, char, fan, sent, toggle } = setup({
      status: windFreeStatus({ switch: { switch: { value: 'on' } }, airConditionerMode: { supportedAcModes: { value: ['cool', 'dry', 'wind', 'auto'] }, airConditionerMode: { value: 'auto' } } }),
    });
    await write(toggle('fan'), true);
    expect(sent[0]).toEqual([{ capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['wind'] }]);
    expect(accessory.context.modeBeforeSpecial).toBe('auto');
    expect(ac.currentState.mode).toBe('wind');
    // One power: the AC reads on (Idle, not cooling), the menu shows Cool, Fan Speed stays on.
    expect(char(C.Active).value).toBe(1);
    expect(char(C.CurrentHeaterCoolerState).value).toBe(C.CurrentHeaterCoolerState.IDLE);
    expect(char(C.TargetHeaterCoolerState).value).toBe(C.TargetHeaterCoolerState.COOL);
    expect(fan!.getCharacteristic(C.Active).value).toBe(1);
    expect(toggle('dry').value).toBe(false);

    await write(toggle('fan'), false);
    expect(sent[1]).toEqual([{ capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['auto'] }]);
  });

  it('turns the unit off from the AC in Fan Only too, and cools again when it is turned back on', async () => {
    const { ac, char, sent, accessory } = setup({
      status: windFreeStatus({ switch: { switch: { value: 'on' } }, airConditionerMode: { supportedAcModes: { value: ['cool', 'wind'] }, airConditionerMode: { value: 'wind' } } }),
    });
    accessory.context.modeBeforeSpecial = 'cool';
    await write(char(C.Active), 0);
    expect(sent[0]).toEqual([{ capability: 'switch', command: 'off' }]);

    await write(char(C.Active), 1);
    expect(sent[1]).toEqual([
      { capability: 'switch', command: 'on' },
      { capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['cool'] },
    ]);
    expect(ac.currentState.mode).toBe('cool');
  });

  it('lists the services in reading order: dial, Fan Speed, toggles, filter', () => {
    const { accessory, client, config, log, profile } = setup({ device: rac01011Device(), status: rac01011Status(), config: { displaySwitch: true } });
    // A cache from an older version keeps the order its services were first added in.
    accessory.services.reverse();
    new PaperclipAirConditioner(
      { api: { hap, updatePlatformAccessories: vi.fn() } as unknown as API, log, client: client as unknown as SmartThingsClient, config },
      accessory, rac01011Device(), profile, rac01011Status(),
    );
    const order = accessory.services.slice(1).map(s => s.getCharacteristic(C.ConfiguredName).value);
    expect(accessory.services[0].UUID).toBe(S.AccessoryInformation.UUID);
    expect(order.slice(1)).toEqual(['Fan Speed', 'Turbo', 'Quiet', 'Sleep', 'Dry', 'Fan Only', 'Display', 'Filter']);
    expect(accessory.services[1]).toBe(accessory.getService(S.HeaterCooler));
  });

  it('uses the Dry switch to enter dry mode and return to the previous mode', async () => {
    const { accessory, sent, ac, toggle } = setup({
      status: windFreeStatus({ switch: { switch: { value: 'on' } }, airConditionerMode: { supportedAcModes: { value: ['cool', 'dry', 'wind', 'auto'] }, airConditionerMode: { value: 'auto' } } }),
    });
    await write(toggle('dry'), true);
    expect(sent[0]).toEqual([{ capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['dry'] }]);
    expect(accessory.context.modeBeforeSpecial).toBe('auto');
    expect(ac.currentState.mode).toBe('dry');

    await write(toggle('dry'), false);
    expect(sent[1]).toEqual([{ capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['auto'] }]);
  });

  it('turns WindFree on and off while the AC runs', async () => {
    const { sent, toggle } = setup({ status: windFreeStatus({ switch: { switch: { value: 'on' } } }) });
    await write(toggle('mode-windFree'), true);
    expect(sent[0]).toEqual([{ capability: 'custom.airConditionerOptionalMode', command: 'setAcOptionalMode', arguments: ['windFree'] }]);
    await write(toggle('mode-windFree'), false);
    expect(sent[1]).toEqual([{ capability: 'custom.airConditionerOptionalMode', command: 'setAcOptionalMode', arguments: ['off'] }]);
  });

  it('refuses mode toggles while the AC is off, like the Samsung app', async () => {
    const { sent, toggle, log } = setup();
    expect(await write(toggle('mode-sleep'), true).catch(e => e)).toBe(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    expect(sent).toHaveLength(0);
    expect(toggle('mode-sleep').value).toBe(false);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Sleep only works while the AC is on'));
  });

  it('adds optional switches only when asked and supported', () => {
    const { accessory, subtypes } = setup({ config: { displaySwitch: true, autoCleanSwitch: true, fanModeSwitch: true, optionalModeSwitches: ['quiet', 'notAMode'] } });
    expect(subtypes(accessory)).toEqual(['autoclean', 'display', 'dry', 'fan', 'fan-speed', 'humidity', 'mode-quiet']);
  });

  it('lists the toggles in the Samsung app\'s order, whatever order the config uses', () => {
    const profile = buildProfile(windFreeDevice(), windFreeStatus());
    expect(switchPlan(profile, parseConfig({ optionalModeSwitches: [], dryModeSwitch: false, fanModeSwitch: false }))).toEqual([]);
    expect(switchPlan(profile, parseConfig({ optionalModeSwitches: ['sleep', 'windFree', 'quiet', 'speed'], displaySwitch: true })).map(s => s.label))
      .toEqual(['Turbo', 'Quiet', 'Sleep', 'WindFree', 'Dry', 'Fan Only', 'Display']);
  });

  it('keeps the old single-slider behaviour when Fan Speed is turned off', () => {
    const { accessory, char, heaterCooler } = setup({ config: { fanTile: false } });
    expect(char(C.RotationSpeed).props.minStep).toBe(20);
    expect(heaterCooler.testCharacteristic(C.SwingMode)).toBe(true);
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
    setup({ device: rac01011Device(), status: rac01011Status(), config: { beepSwitch: true, swingDirectionSwitches: true, ...config } });

  it('shows one AC with Fan Speed, Filter, mode toggles and the settings it was asked for', () => {
    const { accessory, fan, heaterCooler, subtypes } = rac();
    expect(subtypes(accessory)).toEqual(['beep', 'dry', 'fan', 'fan-speed', 'filter', 'mode-quiet', 'mode-sleep', 'mode-speed', 'swing-horizontal', 'swing-vertical']);
    expect(accessory.getServiceById(S.Switch, 'mode-speed')!.getCharacteristic(C.Name).value).toBe('Turbo');
    // Four speeds, four steps: Low 25, Medium 50, High 75, Turbo 100.
    expect(fan!.getCharacteristic(C.RotationSpeed).props).toMatchObject({ minValue: 0, maxValue: 100, minStep: 25 });

    expect(fan!.getCharacteristic(C.TargetFanState).value).toBe(C.TargetFanState.MANUAL);
    expect(fan!.getCharacteristic(C.RotationSpeed).value).toBe(25);
    expect(fan!.testCharacteristic(C.SwingMode)).toBe(true);

    const filter = accessory.getServiceById(S.FilterMaintenance, 'filter')!;
    expect(filter.getCharacteristic(C.FilterLifeLevel).value).toBe(23);
    expect(filter.getCharacteristic(C.FilterChangeIndication).value).toBe(C.FilterChangeIndication.FILTER_OK);
    expect(heaterCooler.linkedServices).toEqual(expect.arrayContaining([fan, filter]));
  });

  it('switches the fan to Auto and back to the last manual speed', async () => {
    const { fan, sent } = rac();
    await write(fan!.getCharacteristic(C.RotationSpeed), 100);
    expect(sent[0]).toEqual([{ capability: 'airConditionerFanMode', command: 'setFanMode', arguments: ['turbo'] }]);
    await write(fan!.getCharacteristic(C.TargetFanState), C.TargetFanState.AUTO);
    expect(sent[1]).toEqual([{ capability: 'airConditionerFanMode', command: 'setFanMode', arguments: ['auto'] }]);
    expect(fan!.getCharacteristic(C.RotationSpeed).value).toBe(100);
    await write(fan!.getCharacteristic(C.TargetFanState), C.TargetFanState.MANUAL);
    expect(sent[2]).toEqual([{ capability: 'airConditionerFanMode', command: 'setFanMode', arguments: ['turbo'] }]);
  });

  it('swings both axes from Oscillate and one axis from its own switch', async () => {
    const { fan, sent, toggle } = rac();
    await write(fan!.getCharacteristic(C.SwingMode), C.SwingMode.SWING_ENABLED);
    expect(sent[0]).toEqual([
      { capability: 'samsungce.airConditionerAirFlowDirection', command: 'setVerticalDirection', arguments: ['swing'] },
      { capability: 'samsungce.airConditionerAirFlowDirection', command: 'setHorizontalDirection', arguments: ['swing'] },
    ]);
    expect(toggle('swing-horizontal').value).toBe(true);
    await write(toggle('swing-horizontal'), false);
    expect(sent[1]).toEqual([
      { capability: 'samsungce.airConditionerAirFlowDirection', command: 'setHorizontalDirection', arguments: ['fixed'] },
    ]);
    expect(fan!.getCharacteristic(C.SwingMode).value).toBe(C.SwingMode.SWING_ENABLED);
  });

  it('runs fan-only with the unit\'s "fan" mode, and turns it on from off', async () => {
    const { sent, ac, toggle } = rac();
    ac.applyStatus(rac01011Status({ switch: { switch: { value: 'off' } } }));
    await write(toggle('fan'), true);
    expect(sent[0]).toEqual([
      { capability: 'switch', command: 'on' },
      { capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['fan'] },
    ]);
  });

  it('turns on Turbo while cooling, and resets the filter', async () => {
    const { accessory, sent, toggle } = rac();
    await write(toggle('mode-speed'), true);
    expect(sent[0]).toEqual([{ capability: 'custom.airConditionerOptionalMode', command: 'setAcOptionalMode', arguments: ['speed'] }]);

    await write(accessory.getServiceById(S.FilterMaintenance, 'filter')!.getCharacteristic(C.ResetFilterIndication), 1);
    expect(sent[1]).toEqual([{ capability: 'custom.dustFilter', command: 'resetDustFilter' }]);
  });

  it('only allows Turbo in Cool mode', async () => {
    const dry = setup({
      device: rac01011Device(),
      status: rac01011Status({ airConditionerMode: { supportedAcModes: { value: ['auto', 'cool', 'dry', 'fan'] }, airConditionerMode: { value: 'dry' } } }),
    });
    expect(await write(dry.toggle('mode-speed'), true).catch(e => e)).toBe(hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    expect(dry.sent).toHaveLength(0);
    expect(dry.log.info).toHaveBeenCalledWith(expect.stringContaining('Turbo only works in Cool mode'));
    // Quiet has no such rule.
    await write(dry.toggle('mode-quiet'), true);
    expect(dry.sent[0][0].arguments).toEqual(['quiet']);
  });

  it('turns Turbo off as soon as the AC leaves Cool', async () => {
    const { char, toggle, ac } = rac();
    await write(toggle('mode-speed'), true);
    expect(toggle('mode-speed').value).toBe(true);
    await write(char(C.TargetHeaterCoolerState), C.TargetHeaterCoolerState.AUTO);
    expect(ac.currentState.optionalMode).toBe('off');
    expect(toggle('mode-speed').value).toBe(false);
  });

  it('flags a dirty filter and toggles the beep', async () => {
    const { accessory, ac, sent, toggle } = rac();
    ac.applyStatus(rac01011Status({ 'custom.dustFilter': { dustFilterUsage: { value: 100 }, dustFilterStatus: { value: 'wash' } } }));
    const filter = accessory.getServiceById(S.FilterMaintenance, 'filter')!;
    expect(filter.getCharacteristic(C.FilterChangeIndication).value).toBe(C.FilterChangeIndication.CHANGE_FILTER);
    expect(filter.getCharacteristic(C.FilterLifeLevel).value).toBe(0);

    await write(toggle('beep'), false);
    expect(sent[0]).toEqual([{ capability: 'samsungce.airConditionerBeep', command: 'off' }]);
  });
});
