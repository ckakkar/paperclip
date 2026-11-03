/**
 * Server side of Paperclip's settings page in the Homebridge UI.
 *
 * Runs in its own process, started by homebridge-config-ui-x while the settings page is open.
 * Secrets (client secret, tokens) are written straight to the credential file and never
 * sent back to the browser.
 */
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

import { buildProfile, describeProfile, isAirConditioner } from '../dist/ac/profile.js';
import { DEFAULT_REDIRECT_URI } from '../dist/settings.js';
import { SmartThingsClient } from '../dist/smartthings/client.js';
import { CredentialStore } from '../dist/smartthings/credentialStore.js';
import {
  buildAuthorizeUrl,
  createOAuthApp,
  exchangeCode,
  extractAuthCode,
  oauthAppDefinition,
} from '../dist/smartthings/oauth.js';
import { TokenManager } from '../dist/smartthings/tokenManager.js';

const quietLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: (...args) => console.warn('[Paperclip UI]', ...args),
  error: (...args) => console.error('[Paperclip UI]', ...args),
};

function mask(value) {
  return typeof value === 'string' && value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : undefined;
}

function fail(error) {
  throw new RequestError(error?.message ?? String(error), { status: error?.status });
}

class PaperclipUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.store = new CredentialStore(this.homebridgeStoragePath ?? `${process.env.HOME}/.homebridge`);

    this.onRequest('/state', () => this.state());
    this.onRequest('/create-app', payload => this.createApp(payload));
    this.onRequest('/use-app', payload => this.useApp(payload));
    this.onRequest('/authorize-url', () => this.authorizeUrl());
    this.onRequest('/exchange', payload => this.exchange(payload));
    this.onRequest('/devices', () => this.devices());
    this.onRequest('/disconnect', payload => this.disconnect(payload));

    this.ready();
  }

  async state() {
    let creds = null;
    let fileError;
    try {
      creds = await this.store.read();
    } catch (error) {
      fileError = error.message;
    }
    return {
      hasApp: Boolean(creds?.clientId && creds?.clientSecret),
      connected: Boolean(creds?.refreshToken),
      clientId: mask(creds?.clientId),
      redirectUri: creds?.redirectUri ?? DEFAULT_REDIRECT_URI,
      expiresAt: creds?.expiresAt,
      locationName: creds?.locationName,
      updatedAt: creds?.updatedAt,
      credentialsPath: this.store.filePath,
      fileError,
      appDefinition: JSON.stringify(oauthAppDefinition(DEFAULT_REDIRECT_URI), null, 2),
    };
  }

  async createApp({ pat, redirectUri } = {}) {
    try {
      const app = await createOAuthApp(String(pat ?? ''), { redirectUri: redirectUri || DEFAULT_REDIRECT_URI });
      await this.store.write({ clientId: app.clientId, clientSecret: app.clientSecret, redirectUri: app.redirectUri, appId: app.appId });
      return { authorizeUrl: buildAuthorizeUrl(app), clientId: mask(app.clientId) };
    } catch (error) {
      return fail(error);
    }
  }

  async useApp({ clientId, clientSecret, redirectUri } = {}) {
    const id = String(clientId ?? '').trim();
    const secret = String(clientSecret ?? '').trim();
    const redirect = String(redirectUri ?? '').trim() || DEFAULT_REDIRECT_URI;
    if (!id || !secret) {
      throw new RequestError('Enter both the OAuth Client ID and the Client Secret.');
    }
    if (!/^https:\/\//.test(redirect)) {
      throw new RequestError('The redirect URI must start with https:// (SmartThings rejects anything else).');
    }
    await this.store.write({ clientId: id, clientSecret: secret, redirectUri: redirect });
    return { authorizeUrl: buildAuthorizeUrl({ clientId: id, redirectUri: redirect }), clientId: mask(id) };
  }

  async authorizeUrl() {
    const creds = await this.store.read().catch(fail);
    if (!creds?.clientId) {
      throw new RequestError('Create or enter a SmartThings app first.');
    }
    return { authorizeUrl: buildAuthorizeUrl({ clientId: creds.clientId, redirectUri: creds.redirectUri ?? DEFAULT_REDIRECT_URI }) };
  }

  async exchange({ pasted } = {}) {
    try {
      const creds = await this.store.read();
      if (!creds?.clientId || !creds.clientSecret) {
        throw new RequestError('Create or enter a SmartThings app first.');
      }
      const redirectUri = creds.redirectUri ?? DEFAULT_REDIRECT_URI;
      const code = extractAuthCode(String(pasted ?? ''));
      const tokens = await exchangeCode({ clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri }, code);

      const client = new SmartThingsClient({ getAccessToken: async () => tokens.accessToken, onUnauthorized: async () => undefined });
      const all = await client.listDevices().catch(() => []);
      const acs = all.filter(isAirConditioner);
      const locationName = acs[0]?.locationId ? await client.getLocationName(acs[0].locationId) : undefined;

      await this.store.write({
        ...creds,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        installedAppId: tokens.installedAppId,
        locationName,
      });

      return {
        locationName,
        deviceCount: all.length,
        airConditioners: acs.map(d => ({ id: d.deviceId, label: d.label || d.name })),
      };
    } catch (error) {
      if (error instanceof RequestError) {
        throw error;
      }
      return fail(error);
    }
  }

  async devices() {
    try {
      const tokens = new TokenManager(quietLog, this.store);
      if ((await tokens.init()) === 'none') {
        throw new RequestError('Not connected to SmartThings yet.');
      }
      const client = new SmartThingsClient(tokens);
      const all = await client.listDevices();
      const result = [];
      for (const device of all.filter(isAirConditioner)) {
        try {
          const status = await client.getStatus(device.deviceId);
          const profile = buildProfile(device, status);
          result.push({
            id: device.deviceId,
            label: device.label || device.name,
            model: device.ocf?.modelNumber?.split('|')[0] ?? device.deviceManufacturerCode ?? '',
            summary: describeProfile(profile),
            optionalModes: profile.optionalModes.filter(m => m !== 'off'),
          });
        } catch (error) {
          result.push({ id: device.deviceId, label: device.label || device.name, summary: `Could not read status: ${error.message}` });
        }
      }
      return { deviceCount: all.length, airConditioners: result };
    } catch (error) {
      if (error instanceof RequestError) {
        throw error;
      }
      return fail(error);
    }
  }

  async disconnect({ forgetApp } = {}) {
    if (forgetApp) {
      await this.store.clear();
    } else {
      const creds = await this.store.read().catch(() => null);
      if (creds) {
        await this.store.write({ clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri: creds.redirectUri, appId: creds.appId });
      }
    }
    return this.state();
  }
}

(() => new PaperclipUiServer())();
