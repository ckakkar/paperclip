import { randomUUID } from 'node:crypto';

import {
  DEFAULT_REDIRECT_URI,
  OAUTH_AUTHORIZE_URL,
  OAUTH_SCOPES,
  OAUTH_TOKEN_URL,
  SMARTTHINGS_API_URL,
} from '../settings.js';

export type FetchLike = typeof fetch;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope?: string;
  installedAppId?: string;
}

export interface CreatedOAuthApp {
  appId?: string;
  appName: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** An error from the SmartThings OAuth endpoints, with the provider's error code when present. */
export class OAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }

  /** True when the refresh token (or code) was revoked, expired or already used. */
  get isInvalidGrant(): boolean {
    return this.code === 'invalid_grant';
  }
}

const REQUEST_TIMEOUT_MS = 20_000;

/** Fallback lifetime when the token endpoint leaves `expires_in` out (SmartThings uses 24h). */
const DEFAULT_EXPIRES_IN_S = 24 * 60 * 60;

export function buildAuthorizeUrl(client: Pick<OAuthClient, 'clientId' | 'redirectUri'>, scopes = OAUTH_SCOPES): string {
  // Built by hand so spaces become %20, the form SmartThings documents (URLSearchParams would use "+").
  const query = [
    ['client_id', client.clientId],
    ['response_type', 'code'],
    ['redirect_uri', client.redirectUri],
    ['scope', scopes.join(' ')],
  ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `${OAUTH_AUTHORIZE_URL}?${query}`;
}

/**
 * Pulls the authorization code out of whatever the user pasted: the full redirect URL
 * from the address bar, just the query string, the JSON httpbin prints, or the bare code.
 */
export function extractAuthCode(input: string): string {
  const text = (input ?? '').trim();
  if (text === '') {
    throw new OAuthError('Paste the address of the page you landed on after approving access, or just the code.');
  }

  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { args?: { code?: unknown }; code?: unknown };
      const code = parsed.args?.code ?? parsed.code;
      if (typeof code === 'string' && code.trim() !== '') {
        return code.trim();
      }
    } catch {
      // Not JSON after all; fall through to the other formats.
    }
  }

  const queryMatch = /[?&#]code=([^&#\s"]+)/.exec(text) ?? /^code=([^&#\s"]+)/.exec(text);
  if (queryMatch) {
    return decodeURIComponent(queryMatch[1]);
  }

  const jsonMatch = /"code"\s*:\s*"([^"]+)"/.exec(text);
  if (jsonMatch) {
    return jsonMatch[1];
  }

  if (/^[A-Za-z0-9._~-]{4,512}$/.test(text)) {
    return text;
  }

  if (/[?&]error=/.test(text)) {
    const error = /[?&]error=([^&#\s]+)/.exec(text)?.[1];
    const description = /[?&]error_description=([^&#\s]+)/.exec(text)?.[1];
    throw new OAuthError(
      `SmartThings did not grant access (${decodeURIComponent(error ?? 'error')}`
      + `${description ? `: ${decodeURIComponent(description.replace(/\+/g, ' '))}` : ''}).`,
      undefined,
      error,
    );
  }

  throw new OAuthError('Could not find an authorization code in what was pasted. Copy the full address from the browser after approving access.');
}

export async function exchangeCode(client: OAuthClient, code: string, fetchImpl: FetchLike = fetch): Promise<TokenSet> {
  return tokenRequest(client, {
    grant_type: 'authorization_code',
    client_id: client.clientId,
    code,
    redirect_uri: client.redirectUri,
  }, fetchImpl);
}

export async function refreshTokens(
  client: Pick<OAuthClient, 'clientId' | 'clientSecret'>,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenSet> {
  const tokens = await tokenRequest(client, {
    grant_type: 'refresh_token',
    client_id: client.clientId,
    refresh_token: refreshToken,
  }, fetchImpl);
  // SmartThings rotates refresh tokens, but keep the old one if a response ever omits it.
  return { ...tokens, refreshToken: tokens.refreshToken || refreshToken };
}

async function tokenRequest(
  client: Pick<OAuthClient, 'clientId' | 'clientSecret'>,
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<TokenSet> {
  const basic = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64');

  let response: Response;
  try {
    response = await fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OAuthError(`Could not reach SmartThings to ${describeGrant(params.grant_type)}: ${(error as Error).message}`);
  }

  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    // Leave data empty; handled below.
  }

  if (!response.ok) {
    const code = typeof data.error === 'string' ? data.error : undefined;
    const description = typeof data.error_description === 'string' ? data.error_description : undefined;
    throw new OAuthError(
      `SmartThings refused to ${describeGrant(params.grant_type)} (HTTP ${response.status}`
      + `${code ? `, ${code}` : ''}${description ? `: ${description}` : ''}).${hintFor(code, response.status)}`,
      response.status,
      code,
    );
  }

  if (typeof data.access_token !== 'string' || data.access_token === '') {
    throw new OAuthError('SmartThings answered the token request without an access token.', response.status);
  }

  const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : DEFAULT_EXPIRES_IN_S;

  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : '',
    expiresAt: Date.now() + expiresIn * 1000,
    scope: typeof data.scope === 'string' ? data.scope : undefined,
    installedAppId: typeof data.installed_app_id === 'string' ? data.installed_app_id : undefined,
  };
}

function describeGrant(grantType: string): string {
  return grantType === 'refresh_token' ? 'renew the access token' : 'exchange the authorization code';
}

function hintFor(code: string | undefined, status: number): string {
  if (code === 'invalid_grant') {
    return ' The code or refresh token has expired or was already used. Run the Paperclip setup again to reconnect.';
  }
  if (code === 'invalid_client' || status === 401) {
    return ' Check the Client ID and Client Secret.';
  }
  if (code === 'invalid_request') {
    return ' The redirect URI must match the one registered on the SmartThings app exactly.';
  }
  return '';
}

/**
 * Creates a SmartThings "OAuth-In" app (the same request `smartthings apps:create` sends)
 * using a short-lived personal access token. The response is the only time SmartThings
 * reveals the client secret.
 */
export async function createOAuthApp(
  personalAccessToken: string,
  options: { displayName?: string; redirectUri?: string; scopes?: string[] } = {},
  fetchImpl: FetchLike = fetch,
): Promise<CreatedOAuthApp> {
  const pat = personalAccessToken.trim();
  if (pat === '') {
    throw new OAuthError('A SmartThings personal access token is required to create the app.');
  }

  const displayName = (options.displayName ?? 'Paperclip for Homebridge').slice(0, 75);
  const redirectUri = options.redirectUri ?? DEFAULT_REDIRECT_URI;
  const appName = `paperclip-homebridge-${randomUUID()}`;

  const body = {
    appName,
    displayName,
    description: 'Lets Homebridge (homebridge-paperclip) read and control your Samsung air conditioners.',
    appType: 'API_ONLY',
    classifications: ['CONNECTED_SERVICE'],
    singleInstance: true,
    principalType: 'LOCATION',
    apiOnly: {},
    oauth: {
      clientName: displayName,
      scope: options.scopes ?? OAUTH_SCOPES,
      redirectUris: [redirectUri],
    },
  };

  let response: Response;
  try {
    response = await fetchImpl(`${SMARTTHINGS_API_URL}/apps`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OAuthError(`Could not reach SmartThings to create the app: ${(error as Error).message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    let hint = '';
    if (response.status === 401) {
      hint = ' The personal access token is invalid or has expired (they only last 24 hours). Create a new one.';
    } else if (response.status === 403) {
      hint = ' The token is missing the "Apps" permissions. Create a new token with every scope ticked, '
        + 'or create the app with the SmartThings CLI instead (see the Paperclip README).';
    }
    throw new OAuthError(`SmartThings refused to create the app (HTTP ${response.status}).${hint} ${truncate(text)}`.trim(), response.status);
  }

  const data = JSON.parse(text) as { app?: { appId?: string; appName?: string }; oauthClientId?: string; oauthClientSecret?: string };
  if (!data.oauthClientId || !data.oauthClientSecret) {
    throw new OAuthError('SmartThings created the app but did not return OAuth credentials.', response.status);
  }

  return {
    appId: data.app?.appId,
    appName: data.app?.appName ?? appName,
    clientId: data.oauthClientId,
    clientSecret: data.oauthClientSecret,
    redirectUri,
  };
}

/** Request body for `smartthings apps:create -i <file>`, for people who prefer the official CLI. */
export function oauthAppDefinition(redirectUri = DEFAULT_REDIRECT_URI): Record<string, unknown> {
  return {
    appName: `paperclip-homebridge-${randomUUID()}`,
    displayName: 'Paperclip for Homebridge',
    description: 'Lets Homebridge (homebridge-paperclip) read and control your Samsung air conditioners.',
    appType: 'API_ONLY',
    classifications: ['CONNECTED_SERVICE'],
    singleInstance: true,
    principalType: 'LOCATION',
    apiOnly: {},
    oauth: {
      clientName: 'Paperclip for Homebridge',
      scope: OAUTH_SCOPES,
      redirectUris: [redirectUri],
    },
  };
}

function truncate(text: string, max = 300): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
