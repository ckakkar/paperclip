import type { Log } from '../settings.js';
import { DEFAULT_REDIRECT_URI } from '../settings.js';
import type { CredentialStore, StoredCredentials } from './credentialStore.js';
import { OAuthError, refreshTokens, type FetchLike } from './oauth.js';

export type AuthMode = 'oauth' | 'pat' | 'none';

/** Credentials that may come straight from config.json (advanced / manual setups). */
export interface ConfigCredentials {
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  redirectUri?: string;
}

export interface TokenProvider {
  getAccessToken(): Promise<string>;
  /** Called after a 401. Returns a different token to retry with, or undefined if there is none. */
  onUnauthorized(rejectedToken: string): Promise<string | undefined>;
}

/** Renew this long before the access token actually expires. */
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;

export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/**
 * Hands out a valid SmartThings access token, renewing it with the refresh token when
 * needed. The credential file is the source of truth: it is re-read before every renewal
 * so a reconnect done in the settings UI (a separate process) is picked up without a
 * restart, and a rotated refresh token is written back immediately.
 */
export class TokenManager implements TokenProvider {
  private creds: StoredCredentials | null = null;
  private refreshing: Promise<string> | null = null;
  private patWarned = false;
  private _mode: AuthMode = 'none';

  constructor(
    private readonly log: Log,
    private readonly store: CredentialStore,
    private readonly fromConfig: ConfigCredentials = {},
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get mode(): AuthMode {
    return this._mode;
  }

  /** Loads stored credentials and works out which auth mode is usable. */
  async init(): Promise<AuthMode> {
    this.creds = await this.loadMerged();
    this._mode = this.modeFor(this.creds);
    return this._mode;
  }

  async getAccessToken(): Promise<string> {
    if (this._mode === 'none') {
      await this.init();
    }

    if (this._mode === 'pat') {
      if (!this.patWarned) {
        this.patWarned = true;
        this.log.warn(
          'Using a personal access token from the config. SmartThings tokens created after 30 Dec 2024 stop '
          + 'working 24 hours after creation. Open Paperclip\'s settings and connect with OAuth to stay signed in.',
        );
      }
      return this.fromConfig.accessToken!.trim();
    }

    if (this._mode === 'none' || !this.creds) {
      throw new AuthRequiredError('Paperclip is not connected to SmartThings yet. Open the plugin settings in the Homebridge UI to connect.');
    }

    if (this.creds.accessToken && (this.creds.expiresAt ?? 0) - EXPIRY_MARGIN_MS > Date.now()) {
      return this.creds.accessToken;
    }

    return this.refresh();
  }

  async onUnauthorized(rejectedToken: string): Promise<string | undefined> {
    if (this._mode !== 'oauth') {
      return undefined;
    }

    // Another process (the settings UI or the CLI) may have reconnected in the meantime.
    const latest = await this.loadMerged().catch(() => null);
    if (latest?.accessToken && latest.accessToken !== rejectedToken && (latest.expiresAt ?? 0) > Date.now()) {
      this.creds = latest;
      return latest.accessToken;
    }

    try {
      return await this.refresh(true);
    } catch (error) {
      this.log.debug('Renewing the token after a 401 failed:', (error as Error).message);
      return undefined;
    }
  }

  private refresh(force = false): Promise<string> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(force).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(force: boolean): Promise<string> {
    // Pick up anything another process wrote since we last looked.
    const latest = await this.loadMerged();
    if (latest) {
      this.creds = latest;
      this._mode = this.modeFor(latest);
    }

    const creds = this.creds;
    if (!creds?.clientId || !creds.clientSecret || !creds.refreshToken) {
      throw new AuthRequiredError('Paperclip is not connected to SmartThings. Open the plugin settings in the Homebridge UI to connect.');
    }

    if (!force && creds.accessToken && (creds.expiresAt ?? 0) - EXPIRY_MARGIN_MS > Date.now()) {
      return creds.accessToken;
    }

    let tokens;
    try {
      tokens = await refreshTokens({ clientId: creds.clientId, clientSecret: creds.clientSecret }, creds.refreshToken, this.fetchImpl);
    } catch (error) {
      if (error instanceof OAuthError && error.isInvalidGrant) {
        this.log.error(
          'SmartThings no longer accepts Paperclip\'s sign-in (the refresh token expired or was revoked). '
          + 'Open the plugin settings in the Homebridge UI and click "Reconnect".',
        );
        throw new AuthRequiredError(error.message);
      }
      throw error;
    }

    const updated: StoredCredentials = {
      ...creds,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      installedAppId: tokens.installedAppId ?? creds.installedAppId,
    };
    this.creds = updated;

    try {
      this.creds = await this.store.write(updated);
    } catch (error) {
      this.log.error(
        `Could not save the renewed SmartThings sign-in to ${this.store.filePath}: ${(error as Error).message}. `
        + 'It is only held in memory; if Homebridge restarts before this works, you will need to reconnect.',
      );
    }

    this.log.debug(`SmartThings access token renewed, valid until ${new Date(tokens.expiresAt).toISOString()}`);
    return tokens.accessToken;
  }

  /** Stored file wins over config, because the stored refresh token is the rotated one. */
  private async loadMerged(): Promise<StoredCredentials | null> {
    const stored = await this.store.read();
    const cfg = this.fromConfig;
    const hasConfigOAuth = Boolean(cfg.clientId?.trim() && cfg.clientSecret?.trim() && cfg.refreshToken?.trim());

    if (stored?.refreshToken && stored.clientId && stored.clientSecret) {
      return stored;
    }
    if (hasConfigOAuth) {
      return {
        version: 1,
        ...(stored ?? {}),
        clientId: cfg.clientId!.trim(),
        clientSecret: cfg.clientSecret!.trim(),
        refreshToken: cfg.refreshToken!.trim(),
        redirectUri: cfg.redirectUri?.trim() || stored?.redirectUri || DEFAULT_REDIRECT_URI,
      };
    }
    return stored;
  }

  private modeFor(creds: StoredCredentials | null): AuthMode {
    if (creds?.clientId && creds.clientSecret && creds.refreshToken) {
      return 'oauth';
    }
    if (this.fromConfig.accessToken?.trim()) {
      return 'pat';
    }
    return 'none';
  }
}
