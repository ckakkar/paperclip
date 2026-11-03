import { describe, expect, it } from 'vitest';

import {
  OAuthError,
  buildAuthorizeUrl,
  createOAuthApp,
  exchangeCode,
  extractAuthCode,
  refreshTokens,
} from '../src/smartthings/oauth.js';
import { json, scriptedFetch } from './fixtures.js';

const client = { clientId: 'client-123', clientSecret: 'secret-456', redirectUri: 'https://httpbin.org/get' };

describe('buildAuthorizeUrl', () => {
  it('builds the SmartThings authorize URL with the requested scopes', () => {
    const url = new URL(buildAuthorizeUrl(client));
    expect(url.origin + url.pathname).toBe('https://api.smartthings.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://httpbin.org/get');
    expect(url.searchParams.get('scope')).toBe('r:devices:* x:devices:* r:locations:*');
    expect(buildAuthorizeUrl(client)).toContain('scope=r%3Adevices%3A*%20x%3Adevices%3A*%20r%3Alocations%3A*');
  });
});

describe('extractAuthCode', () => {
  it.each([
    ['https://httpbin.org/get?code=hkp89A', 'hkp89A'],
    ['https://httpbin.org/get?code=hkp89A&state=x', 'hkp89A'],
    ['  code=abc123  ', 'abc123'],
    ['{"args": {"code": "Zx9Y"}, "url": "https://httpbin.org/get?code=Zx9Y"}', 'Zx9Y'],
    ['"args": { "code": "Q1w2" },', 'Q1w2'],
    ['hkp89A', 'hkp89A'],
  ])('reads %s', (input, expected) => {
    expect(extractAuthCode(input)).toBe(expected);
  });

  it('explains a denied authorization', () => {
    expect(() => extractAuthCode('https://httpbin.org/get?error=access_denied&error_description=User+denied'))
      .toThrow(/did not grant access \(access_denied: User denied\)/);
  });

  it('rejects empty and unrelated input', () => {
    expect(() => extractAuthCode('')).toThrow(OAuthError);
    expect(() => extractAuthCode('https://example.com/nothing here')).toThrow(/Could not find/);
  });
});

describe('token requests', () => {
  it('exchanges a code with HTTP Basic client auth', async () => {
    const { fetch, calls } = scriptedFetch(() => json({
      access_token: 'at-1', refresh_token: 'rt-1', expires_in: 86399, scope: 'r:devices:*', installed_app_id: 'ia-1',
    }));
    const before = Date.now();
    const tokens = await exchangeCode(client, 'the-code', fetch);

    expect(calls[0].url).toBe('https://api.smartthings.com/oauth/token');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('client-123:secret-456').toString('base64')}`);
    const body = new URLSearchParams(calls[0].body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('redirect_uri')).toBe('https://httpbin.org/get');

    expect(tokens.accessToken).toBe('at-1');
    expect(tokens.refreshToken).toBe('rt-1');
    expect(tokens.installedAppId).toBe('ia-1');
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 86399_000);
  });

  it('keeps the old refresh token if a refresh response omits it', async () => {
    const { fetch, calls } = scriptedFetch(() => json({ access_token: 'at-2', expires_in: 100 }));
    const tokens = await refreshTokens(client, 'rt-old', fetch);
    expect(new URLSearchParams(calls[0].body).get('grant_type')).toBe('refresh_token');
    expect(tokens.refreshToken).toBe('rt-old');
  });

  it('flags invalid_grant so callers can ask the user to reconnect', async () => {
    const { fetch } = scriptedFetch(() => json({ error: 'invalid_grant', error_description: 'Invalid refresh token' }, 400));
    const error = await refreshTokens(client, 'rt-dead', fetch).catch(e => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect(error.isInvalidGrant).toBe(true);
    expect(error.message).toMatch(/Run the Paperclip setup again/);
  });
});

describe('createOAuthApp', () => {
  it('sends the same request as `smartthings apps:create` for an OAuth-In app', async () => {
    const { fetch, calls } = scriptedFetch(() => json({
      app: { appId: 'app-1', appName: 'paperclip-homebridge-x' }, oauthClientId: 'cid', oauthClientSecret: 'csecret',
    }));
    const app = await createOAuthApp(' pat-token ', {}, fetch);

    expect(calls[0].url).toBe('https://api.smartthings.com/v1/apps');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer pat-token');
    const body = JSON.parse(calls[0].body!);
    expect(body).toMatchObject({
      appType: 'API_ONLY',
      classifications: ['CONNECTED_SERVICE'],
      principalType: 'LOCATION',
      singleInstance: true,
      oauth: { scope: ['r:devices:*', 'x:devices:*', 'r:locations:*'], redirectUris: ['https://httpbin.org/get'] },
    });
    expect(body.appName).toMatch(/^paperclip-homebridge-[0-9a-f-]{36}$/);
    expect(app).toEqual({ appId: 'app-1', appName: 'paperclip-homebridge-x', clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://httpbin.org/get' });
  });

  it('explains a token without app permissions', async () => {
    const { fetch } = scriptedFetch(() => json({ error: { code: 'Forbidden' } }, 403));
    await expect(createOAuthApp('pat', {}, fetch)).rejects.toThrow(/missing the "Apps" permissions/);
  });

  it('explains an expired token', async () => {
    const { fetch } = scriptedFetch(() => json({}, 401));
    await expect(createOAuthApp('pat', {}, fetch)).rejects.toThrow(/only last 24 hours/);
  });
});
