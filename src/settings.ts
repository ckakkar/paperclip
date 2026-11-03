/** The name users put in config.json `"platform"`. Must match config.schema.json `pluginAlias`. */
export const PLATFORM_NAME = 'Paperclip';

/** Must match `name` in package.json. */
export const PLUGIN_NAME = 'homebridge-paperclip';

/** `PAPERCLIP_API_URL` lets contributors point the plugin at a local fake SmartThings server. */
export const SMARTTHINGS_API_URL = process.env.PAPERCLIP_API_URL || 'https://api.smartthings.com/v1';
export const OAUTH_AUTHORIZE_URL = 'https://api.smartthings.com/oauth/authorize';
export const OAUTH_TOKEN_URL = 'https://api.smartthings.com/oauth/token';

/**
 * SmartThings only accepts public HTTPS redirect URIs (localhost and plain http are
 * rejected with a 403 on the authorize page). httpbin simply echoes the query string
 * back, so the authorization code is visible on the page and in the address bar.
 */
export const DEFAULT_REDIRECT_URI = 'https://httpbin.org/get';

/** Read devices, send commands to devices, read the location name for the UI. */
export const OAUTH_SCOPES = ['r:devices:*', 'x:devices:*', 'r:locations:*'];

/** Folder inside the Homebridge storage path that holds Paperclip's own files. */
export const STORAGE_DIR = 'paperclip';
export const CREDENTIALS_FILE = 'credentials.json';

/** Minimal logger shape shared by the plugin, the settings UI server and the CLI. */
export interface Log {
  debug(message: string, ...params: unknown[]): void;
  info(message: string, ...params: unknown[]): void;
  warn(message: string, ...params: unknown[]): void;
  error(message: string, ...params: unknown[]): void;
}

export const silentLog: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
