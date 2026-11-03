import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { silentLog } from '../src/settings.js';
import { CredentialStore } from '../src/smartthings/credentialStore.js';
import { AuthRequiredError, TokenManager } from '../src/smartthings/tokenManager.js';
import { json, scriptedFetch } from './fixtures.js';

let dir: string;
let store: CredentialStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'paperclip-test-'));
  store = new CredentialStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const app = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://httpbin.org/get' };

describe('CredentialStore', () => {
  it('writes owner-only files atomically and reads them back', async () => {
    await store.write({ ...app, refreshToken: 'rt' });
    const mode = (await stat(store.filePath)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(store.filePath).toBe(path.join(dir, 'paperclip', 'credentials.json'));
    expect(await store.read()).toMatchObject({ ...app, refreshToken: 'rt', version: 1 });
  });

  it('returns null when nothing is stored and throws on a corrupt file', async () => {
    expect(await store.read()).toBeNull();
    await store.write(app);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(store.filePath, '{not json');
    await expect(store.read()).rejects.toThrow(/corrupt/);
  });
});

describe('TokenManager', () => {
  it('reports "none" until credentials exist', async () => {
    const tokens = new TokenManager(silentLog, store);
    expect(await tokens.init()).toBe('none');
    await expect(tokens.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('uses a stored access token while it is valid', async () => {
    await store.write({ ...app, accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 });
    const { fetch, calls } = scriptedFetch();
    const tokens = new TokenManager(silentLog, store, {}, fetch);
    expect(await tokens.init()).toBe('oauth');
    expect(await tokens.getAccessToken()).toBe('at');
    expect(calls).toHaveLength(0);
  });

  it('renews an expiring token once for concurrent callers and saves the rotated refresh token', async () => {
    await store.write({ ...app, accessToken: 'old', refreshToken: 'rt-1', expiresAt: Date.now() + 60_000 });
    const { fetch, calls } = scriptedFetch(() => json({ access_token: 'new', refresh_token: 'rt-2', expires_in: 86400 }));
    const tokens = new TokenManager(silentLog, store, {}, fetch);
    await tokens.init();

    const results = await Promise.all([tokens.getAccessToken(), tokens.getAccessToken(), tokens.getAccessToken()]);
    expect(results).toEqual(['new', 'new', 'new']);
    expect(calls).toHaveLength(1);
    expect(new URLSearchParams(calls[0].body).get('refresh_token')).toBe('rt-1');

    const saved = JSON.parse(await readFile(store.filePath, 'utf8'));
    expect(saved).toMatchObject({ accessToken: 'new', refreshToken: 'rt-2' });
  });

  it('seeds from config but prefers the stored (rotated) refresh token', async () => {
    const { fetch, calls } = scriptedFetch(
      () => json({ access_token: 'a1', refresh_token: 'rt-rotated', expires_in: 1 }),
      () => json({ access_token: 'a2', refresh_token: 'rt-rotated-2', expires_in: 86400 }),
    );
    const tokens = new TokenManager(silentLog, store, { clientId: 'cid', clientSecret: 'secret', refreshToken: 'rt-config' }, fetch);
    expect(await tokens.init()).toBe('oauth');
    expect(await tokens.getAccessToken()).toBe('a1');
    expect(new URLSearchParams(calls[0].body).get('refresh_token')).toBe('rt-config');

    // a1 expires immediately, so the next call refreshes with the rotated token from disk.
    expect(await tokens.getAccessToken()).toBe('a2');
    expect(new URLSearchParams(calls[1].body).get('refresh_token')).toBe('rt-rotated');
  });

  it('picks up a reconnect made by another process after a 401', async () => {
    await store.write({ ...app, accessToken: 'stale', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 });
    const tokens = new TokenManager(silentLog, store, {}, scriptedFetch().fetch);
    await tokens.init();
    expect(await tokens.getAccessToken()).toBe('stale');

    await store.write({ ...app, accessToken: 'fresh', refreshToken: 'rt-new', expiresAt: Date.now() + 3600_000 });
    expect(await tokens.onUnauthorized('stale')).toBe('fresh');
  });

  it('turns invalid_grant into a reconnect instruction', async () => {
    await store.write({ ...app, refreshToken: 'dead' });
    const log = { ...silentLog, error: vi.fn() };
    const { fetch } = scriptedFetch(() => json({ error: 'invalid_grant' }, 400));
    const tokens = new TokenManager(log, store, {}, fetch);
    await tokens.init();
    await expect(tokens.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/Reconnect/));
  });

  it('falls back to a personal access token with a warning', async () => {
    const log = { ...silentLog, warn: vi.fn() };
    const tokens = new TokenManager(log, store, { accessToken: ' pat ' });
    expect(await tokens.init()).toBe('pat');
    expect(await tokens.getAccessToken()).toBe('pat');
    expect(await tokens.getAccessToken()).toBe('pat');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(await tokens.onUnauthorized('pat')).toBeUndefined();
  });
});
