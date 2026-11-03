import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { PaperclipAirConditioner, type AccessoryContext } from './accessory.js';
import { buildProfile, describeProfile, isAirConditioner } from './ac/profile.js';
import { parseConfig, type PaperclipConfig } from './config.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { SmartThingsClient } from './smartthings/client.js';
import { CredentialStore } from './smartthings/credentialStore.js';
import { AuthRequiredError, TokenManager } from './smartthings/tokenManager.js';
import type { Device } from './smartthings/types.js';

/** Wait before checking again for credentials saved by the settings UI. */
const NOT_CONNECTED_RECHECK_MS = 60_000;
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

export class PaperclipPlatform implements DynamicPlatformPlugin {
  private readonly config: PaperclipConfig;
  private readonly tokens: TokenManager;
  private readonly client: SmartThingsClient;
  private readonly cached = new Map<string, PlatformAccessory<AccessoryContext>>();
  private readonly active = new Map<string, PaperclipAirConditioner>();
  private retryTimer?: NodeJS.Timeout;
  private retryDelay = RETRY_MIN_MS;
  private notConnectedLogged = false;
  private stopped = false;

  constructor(
    private readonly log: Logging,
    rawConfig: PlatformConfig,
    private readonly api: API,
  ) {
    this.config = parseConfig(rawConfig, log);
    const store = new CredentialStore(api.user.storagePath());
    this.tokens = new TokenManager(log, store, this.config.credentials);
    this.client = new SmartThingsClient(this.tokens, { timeoutMs: this.config.requestTimeout, log });

    api.on('didFinishLaunching', () => void this.start());
    api.on('shutdown', () => this.shutdown());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory as PlatformAccessory<AccessoryContext>);
  }

  private async start(): Promise<void> {
    if (this.stopped) {
      return;
    }

    let mode;
    try {
      mode = await this.tokens.init();
    } catch (error) {
      this.log.error((error as Error).message);
      this.scheduleRetry(NOT_CONNECTED_RECHECK_MS);
      return;
    }

    if (mode === 'none') {
      if (!this.notConnectedLogged) {
        this.notConnectedLogged = true;
        this.log.warn(
          'Not connected to SmartThings yet. In the Homebridge UI open Plugins → Paperclip → Settings and '
          + 'follow the setup steps. Paperclip checks again every minute, so no restart is needed afterwards.',
        );
      }
      this.scheduleRetry(NOT_CONNECTED_RECHECK_MS);
      return;
    }

    if (this.notConnectedLogged) {
      this.log.info('SmartThings connection found. Loading your air conditioners…');
      this.notConnectedLogged = false;
    }
    await this.discover();
  }

  private async discover(): Promise<void> {
    let devices: Device[];
    try {
      devices = await this.client.listDevices();
    } catch (error) {
      this.handleDiscoveryError(error as Error);
      return;
    }

    const airConditioners = devices.filter(isAirConditioner);
    this.log.info(
      `SmartThings has ${devices.length} device(s); ${airConditioners.length} air conditioner(s) found`
      + (airConditioners.length ? `: ${airConditioners.map(d => d.label || d.name).join(', ')}` : '.'),
    );
    if (airConditioners.length === 0 && devices.length > 0) {
      this.log.warn(
        'None of your SmartThings devices look like an air conditioner. If yours is in a different SmartThings '
        + 'location, reconnect in Paperclip\'s settings and pick that location.',
      );
    }

    const seen = new Set<string>();
    let failed = 0;

    for (const device of airConditioners) {
      const uuid = this.uuidFor(device.deviceId);
      const label = device.label || device.name || device.deviceId;

      if (this.isExcluded(device)) {
        this.log.info(`${label}: excluded in the config, not added to HomeKit.`);
        this.removeAccessory(uuid, 'excluded in the config');
        this.removeAccessory(this.uuidFor(device.deviceId, 'modes'), 'excluded in the config');
        continue;
      }

      seen.add(uuid);
      if (this.active.has(uuid)) {
        continue;
      }

      try {
        await this.addDevice(device, uuid);
      } catch (error) {
        failed++;
        this.log.error(`${label}: could not be set up (${(error as Error).message}). Will retry.`);
      }
    }

    if (this.config.removeStaleAccessories) {
      for (const [uuid, accessory] of this.cached) {
        if (!seen.has(uuid) && !this.active.has(uuid)) {
          this.removeAccessory(uuid, `"${accessory.displayName}" is no longer in SmartThings`);
        }
      }
    }

    if (failed > 0) {
      this.scheduleRetry(this.nextBackoff());
    } else {
      this.retryDelay = RETRY_MIN_MS;
    }
  }

  private async addDevice(device: Device, uuid: string): Promise<void> {
    const status = await this.client.getStatus(device.deviceId);
    const profile = buildProfile(device, status);
    const label = device.label || device.name || 'Air Conditioner';
    this.log.info(`${label}: ${describeProfile(profile)}`);

    const { accessory, isNew } = this.accessoryFor(uuid, label, this.api.hap.Categories.AIR_CONDITIONER);

    // 0.2 and 0.3 put some switches on a second accessory; one tile per AC is what a native unit does.
    this.removeAccessory(this.uuidFor(device.deviceId, 'modes'), 'its switches now sit inside the AC');

    const handler = new PaperclipAirConditioner(
      { api: this.api, log: this.log, client: this.client, config: this.config },
      accessory,
      device,
      profile,
      status,
    );
    this.active.set(uuid, handler);

    if (isNew) {
      this.log.info(`${label}: adding to HomeKit.`);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else {
      this.api.updatePlatformAccessories([accessory]);
    }
    handler.start();
  }

  private accessoryFor(uuid: string, name: string, category: number) {
    let accessory = this.cached.get(uuid);
    const isNew = !accessory;
    if (!accessory) {
      accessory = new this.api.platformAccessory<AccessoryContext>(name, uuid, category);
      this.cached.set(uuid, accessory);
    }
    return { accessory, isNew };
  }

  private handleDiscoveryError(error: Error): void {
    if (error instanceof AuthRequiredError) {
      this.log.error(error.message);
      this.scheduleRetry(NOT_CONNECTED_RECHECK_MS);
      return;
    }
    const delay = this.nextBackoff();
    this.log.error(`Could not load devices from SmartThings: ${error.message} Retrying in ${Math.round(delay / 1000)}s.`);
    this.scheduleRetry(delay);
  }

  private nextBackoff(): number {
    const delay = this.retryDelay;
    this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2);
    return delay;
  }

  private scheduleRetry(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.start(), delayMs);
  }

  private isExcluded(device: Device): boolean {
    const excluded = this.config.excludeDevices.map(e => e.toLowerCase());
    return [device.deviceId, device.label, device.name]
      .filter((v): v is string => typeof v === 'string')
      .some(v => excluded.includes(v.trim().toLowerCase()));
  }

  private removeAccessory(uuid: string, reason: string): void {
    const accessory = this.cached.get(uuid);
    if (!accessory) {
      return;
    }
    this.active.get(uuid)?.stop();
    this.active.delete(uuid);
    this.cached.delete(uuid);
    this.log.info(`Removing ${accessory.displayName} from HomeKit (${reason}).`);
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  private uuidFor(deviceId: string, kind: 'main' | 'modes' = 'main'): string {
    return this.api.hap.uuid.generate(kind === 'main' ? `${PLUGIN_NAME}:${deviceId}` : `${PLUGIN_NAME}:${deviceId}:${kind}`);
  }

  private shutdown(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    for (const handler of this.active.values()) {
      handler.stop();
    }
  }
}
