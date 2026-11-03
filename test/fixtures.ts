import type { Device, DeviceStatus } from '../src/smartthings/types.js';

/** Shaped after a SmartThings Samsung WindFree split AC (OCF, DA-AC-RAC). */
export function windFreeDevice(overrides: Partial<Device> = {}): Device {
  return {
    deviceId: 'a1b2c3d4-0000-1111-2222-333344445555',
    name: 'Samsung Room A/C',
    label: 'Bedroom AC',
    manufacturerName: 'Samsung Electronics',
    presentationId: 'DA-AC-RAC-000003',
    deviceManufacturerCode: 'Samsung Electronics',
    locationId: 'loc-1',
    roomId: 'room-1',
    type: 'OCF',
    ocf: {
      ocfDeviceType: 'oic.d.airconditioner',
      name: 'Bedroom AC',
      manufacturerName: 'Samsung Electronics',
      modelNumber: 'ARA-WW-TP1-22-COMMON|10229141|60010523001511014600083200800000',
      firmwareVersion: 'ARA-WW-TP1-22-COMMON_11240702',
      vendorId: 'DA-AC-RAC-000003',
    },
    components: [{
      id: 'main',
      label: 'main',
      categories: [{ name: 'AirConditioner', categoryType: 'manufacturer' }],
      capabilities: [
        'ocf', 'switch', 'airConditionerMode', 'airConditionerFanMode', 'fanOscillationMode',
        'temperatureMeasurement', 'thermostatCoolingSetpoint', 'relativeHumidityMeasurement',
        'custom.airConditionerOptionalMode', 'custom.autoCleaningMode', 'custom.thermostatSetpointControl',
        'custom.disabledCapabilities', 'custom.dustFilter', 'custom.spiMode', 'samsungce.airConditionerLighting',
        'execute', 'healthCheck', 'refresh', 'audioVolume',
      ].map(id => ({ id, version: 1 })),
    }],
    ...overrides,
  };
}

export function windFreeStatus(main: Record<string, unknown> = {}): DeviceStatus {
  return {
    components: {
      main: {
        'switch': { switch: { value: 'off' } },
        'airConditionerMode': {
          availableAcModes: { value: [] },
          supportedAcModes: { value: ['cool', 'dry', 'wind', 'auto'] },
          airConditionerMode: { value: 'cool' },
        },
        'temperatureMeasurement': { temperatureRange: { value: null }, temperature: { value: 29, unit: 'C' } },
        'thermostatCoolingSetpoint': { coolingSetpointRange: { value: null }, coolingSetpoint: { value: 24, unit: 'C' } },
        'custom.thermostatSetpointControl': { minimumSetpoint: { value: 16, unit: 'C' }, maximumSetpoint: { value: 30, unit: 'C' } },
        'relativeHumidityMeasurement': { humidity: { value: 58, unit: '%' } },
        'airConditionerFanMode': {
          fanMode: { value: 'auto' },
          supportedAcFanModes: { value: ['auto', 'low', 'medium', 'high', 'turbo'] },
          availableAcFanModes: { value: ['auto', 'low', 'medium', 'high', 'turbo'] },
        },
        'fanOscillationMode': {
          supportedFanOscillationModes: { value: ['fixed', 'all', 'vertical', 'horizontal'] },
          availableFanOscillationModes: { value: null },
          fanOscillationMode: { value: 'fixed' },
        },
        'custom.airConditionerOptionalMode': {
          supportedAcOptionalMode: { value: ['off', 'sleep', 'quiet', 'speed', 'windFree', 'windFreeSleep'] },
          acOptionalMode: { value: 'off' },
        },
        'custom.autoCleaningMode': { autoCleaningMode: { value: 'on' } },
        'samsungce.airConditionerLighting': { supportedLightingLevels: { value: ['on', 'off'] }, lighting: { value: 'on' } },
        'custom.disabledCapabilities': {
          disabledCapabilities: { value: ['custom.dustFilter', 'custom.spiMode', 'audioVolume'] },
        },
        ...main,
      },
    },
  };
}

/** A canned fetch: each call is answered by the next handler, and every request is recorded. */
export function scriptedFetch(...handlers: ((url: string, init: RequestInit) => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit; body?: string }[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init, body: typeof init.body === 'string' ? init.body : undefined });
    const handler = handlers.shift();
    if (!handler) {
      throw new Error(`Unexpected request to ${url}`);
    }
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * Shaped after a 2025 Samsung split AC sold in India (SmartThings presentation DA-AC-RAC-01011):
 * modes auto/cool/dry/fan, swing through samsungce.airConditionerAirFlowDirection, the old
 * fanOscillationMode and the humidity sensor both disabled. IDs are made up.
 */
export function rac01011Device(): Device {
  return windFreeDevice({
    deviceId: '00000000-aaaa-bbbb-cccc-000000000001',
    name: 'Samsung Room A/C',
    label: 'Samsung Room A/C',
    presentationId: 'DA-AC-RAC-01011',
    ocf: { ocfDeviceType: 'oic.d.airconditioner', modelNumber: 'TP1X_DA-AC-RAC-01011_0000|00000000|0000', vendorId: 'DA-AC-RAC-01011' },
    components: [{
      id: 'main',
      categories: [{ name: 'AirConditioner', categoryType: 'manufacturer' }],
      capabilities: [
        'ocf', 'switch', 'airConditionerMode', 'airConditionerFanMode', 'fanOscillationMode', 'temperatureMeasurement',
        'thermostatCoolingSetpoint', 'relativeHumidityMeasurement', 'custom.thermostatSetpointControl',
        'custom.airConditionerOptionalMode', 'custom.autoCleaningMode', 'custom.dustFilter', 'custom.disabledCapabilities',
        'samsungce.airConditionerAirFlowDirection', 'samsungce.airConditionerBeep', 'samsungce.airConditionerLighting', 'execute',
      ].map(id => ({ id, version: 1 })),
    }],
  });
}

export function rac01011Status(main: Record<string, unknown> = {}): DeviceStatus {
  return {
    components: {
      main: {
        'switch': { switch: { value: 'on' } },
        'airConditionerMode': {
          availableAcModes: { value: ['auto', 'cool', 'dry', 'fan'] },
          supportedAcModes: { value: ['auto', 'cool', 'dry', 'fan'] },
          airConditionerMode: { value: 'cool' },
        },
        'airConditionerFanMode': {
          fanMode: { value: 'low' },
          supportedAcFanModes: { value: ['auto', 'low', 'medium', 'high', 'turbo'] },
          availableAcFanModes: { value: ['auto', 'low', 'medium', 'high', 'turbo'] },
        },
        'temperatureMeasurement': { temperature: { value: 25, unit: 'C' } },
        'thermostatCoolingSetpoint': { coolingSetpointRange: { value: { minimum: 16, maximum: 30, step: 1 }, unit: 'C' }, coolingSetpoint: { value: 24, unit: 'C' } },
        'custom.thermostatSetpointControl': { minimumSetpoint: { value: 16, unit: 'C' }, maximumSetpoint: { value: 30, unit: 'C' } },
        'custom.airConditionerOptionalMode': { supportedAcOptionalMode: { value: ['off', 'sleep', 'quiet', 'speed'] }, acOptionalMode: { value: 'off' } },
        'custom.autoCleaningMode': { autoCleaningMode: { value: 'off' } },
        'custom.dustFilter': { dustFilterUsage: { value: 77 }, dustFilterStatus: { value: 'normal' }, dustFilterCapacity: { value: 180, unit: 'Hour' } },
        'samsungce.airConditionerAirFlowDirection': {
          supportedVerticalDirections: { value: ['swing', 'fixed'] },
          supportedHorizontalDirections: { value: ['swing', 'fixed'] },
          verticalDirection: { value: 'fixed' },
          horizontalDirection: { value: 'fixed' },
        },
        'samsungce.airConditionerBeep': { beep: { value: 'on' } },
        'samsungce.airConditionerLighting': { supportedLightingLevels: { value: ['on', 'off'] }, lighting: { value: 'on' } },
        'custom.disabledCapabilities': { disabledCapabilities: { value: ['relativeHumidityMeasurement', 'fanOscillationMode'] } },
        ...main,
      },
    },
  };
}
