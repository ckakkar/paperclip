import type { PlatformConfig } from 'homebridge';

import type { Log } from './settings.js';
import type { ConfigCredentials } from './smartthings/tokenManager.js';

export type SwingPreference = 'all' | 'vertical' | 'horizontal';

export interface PaperclipConfig {
  name: string;
  /** Seconds between status refreshes. */
  pollInterval: number;
  /** Device IDs or names to leave out of HomeKit (case-insensitive). */
  excludeDevices: string[];
  humiditySensor: boolean;
  /** A Fan Speed control inside the AC: speed steps, an Auto toggle and Oscillate. */
  fanTile: boolean;
  dryModeSwitch: boolean;
  fanModeSwitch: boolean;
  /** Samsung "optional modes" to expose as switches, e.g. windFree, sleep, quiet, speed. */
  optionalModeSwitches: string[];
  displaySwitch: boolean;
  autoCleanSwitch: boolean;
  beepSwitch: boolean;
  /** Separate "Swing Up/Down" and "Swing Left/Right" switches, on units that swing both ways (Oscillate on the Fan covers most uses). */
  swingDirectionSwitches: boolean;
  /** Filter life and a "clean filter" alert, from the unit's dust filter counter. */
  filterStatus: boolean;
  swingMode: SwingPreference;
  /** Unregister cached accessories whose device is gone from SmartThings. */
  removeStaleAccessories: boolean;
  /** Milliseconds before a SmartThings request is abandoned. */
  requestTimeout: number;
  credentials: ConfigCredentials;
}

/** Every Samsung optional mode Paperclip knows; only the ones a unit supports become switches. */
export const ALL_OPTIONAL_MODES = ['windFree', 'windFreeSleep', 'sleep', 'quiet', 'speed', 'smart', 'comfort', 'longWind'];

export const DEFAULTS: Omit<PaperclipConfig, 'credentials'> = {
  name: 'Paperclip',
  pollInterval: 20,
  excludeDevices: [],
  humiditySensor: true,
  fanTile: true,
  dryModeSwitch: true,
  fanModeSwitch: true,
  optionalModeSwitches: ALL_OPTIONAL_MODES,
  displaySwitch: false,
  autoCleanSwitch: false,
  beepSwitch: false,
  swingDirectionSwitches: false,
  filterStatus: true,
  swingMode: 'all',
  removeStaleAccessories: true,
  requestTimeout: 15_000,
};

const MIN_POLL = 10;
const MAX_POLL = 600;

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function strings(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value.map(v => (typeof v === 'string' ? v.trim() : '')).filter(v => v !== '');
}

export function parseConfig(raw: PlatformConfig | Record<string, unknown>, log?: Log): PaperclipConfig {
  const cfg = raw as Record<string, unknown>;

  let pollInterval = typeof cfg.pollInterval === 'number' ? Math.round(cfg.pollInterval) : DEFAULTS.pollInterval;
  if (pollInterval < MIN_POLL || pollInterval > MAX_POLL) {
    const clamped = Math.min(MAX_POLL, Math.max(MIN_POLL, pollInterval));
    log?.warn(`pollInterval must be between ${MIN_POLL} and ${MAX_POLL} seconds; using ${clamped}.`);
    pollInterval = clamped;
  }

  const swing = str(cfg.swingMode);
  const swingMode: SwingPreference = swing === 'vertical' || swing === 'horizontal' ? swing : 'all';

  const timeoutSeconds = typeof cfg.requestTimeout === 'number' && cfg.requestTimeout >= 3 && cfg.requestTimeout <= 60
    ? cfg.requestTimeout
    : DEFAULTS.requestTimeout / 1000;

  return {
    name: str(cfg.name) ?? DEFAULTS.name,
    pollInterval,
    excludeDevices: strings(cfg.excludeDevices, []),
    humiditySensor: bool(cfg.humiditySensor, DEFAULTS.humiditySensor),
    fanTile: bool(cfg.fanTile, DEFAULTS.fanTile),
    dryModeSwitch: bool(cfg.dryModeSwitch, DEFAULTS.dryModeSwitch),
    fanModeSwitch: bool(cfg.fanModeSwitch, DEFAULTS.fanModeSwitch),
    optionalModeSwitches: strings(cfg.optionalModeSwitches, DEFAULTS.optionalModeSwitches),
    displaySwitch: bool(cfg.displaySwitch, DEFAULTS.displaySwitch),
    autoCleanSwitch: bool(cfg.autoCleanSwitch, DEFAULTS.autoCleanSwitch),
    beepSwitch: bool(cfg.beepSwitch, DEFAULTS.beepSwitch),
    swingDirectionSwitches: bool(cfg.swingDirectionSwitches, DEFAULTS.swingDirectionSwitches),
    filterStatus: bool(cfg.filterStatus, DEFAULTS.filterStatus),
    swingMode,
    removeStaleAccessories: bool(cfg.removeStaleAccessories, DEFAULTS.removeStaleAccessories),
    requestTimeout: timeoutSeconds * 1000,
    credentials: {
      accessToken: str(cfg.accessToken),
      clientId: str(cfg.clientId),
      clientSecret: str(cfg.clientSecret),
      refreshToken: str(cfg.refreshToken),
      redirectUri: str(cfg.redirectUri),
    },
  };
}

/** Friendly names for Samsung's optional modes. */
export const OPTIONAL_MODE_LABELS: Record<string, string> = {
  windFree: 'WindFree',
  windFreeSleep: 'WindFree Sleep',
  sleep: 'Sleep',
  quiet: 'Quiet',
  // Samsung's fast-cooling option, labelled Turbo on the remote and in the SmartThings app.
  speed: 'Turbo',
  smart: 'Smart',
  comfort: 'Comfort',
  twoStep: '2-Step',
  longWind: 'Long Wind',
  motionIndirect: 'Motion Indirect',
  motionDirect: 'Motion Direct',
};

export function optionalModeLabel(mode: string): string {
  return OPTIONAL_MODE_LABELS[mode] ?? mode.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}
