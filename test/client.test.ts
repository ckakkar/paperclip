import { describe, expect, it, vi } from 'vitest';

import { SmartThingsApiError, SmartThingsClient, parseRetryAfter } from '../src/smartthings/client.js';
import { json, scriptedFetch, windFreeDevice } from './fixtures.js';

function tokens(initial = 'tok-1', retry?: string) {
  return {
    getAccessToken: vi.fn(async () => initial),
    onUnauthorized: vi.fn(async () => retry),
  };
}

describe('SmartThingsClient', () => {
  it('follows pagination when listing devices', async () => {
    const { fetch, calls } = scriptedFetch(
      () => json({ items: [windFreeDevice({ deviceId: 'a' })], _links: { next: { href: 'https://api.smartthings.com/v1/devices?page=1' } } }),
      () => json({ items: [windFreeDevice({ deviceId: 'b' })], _links: { next: null } }),
    );
    const client = new SmartThingsClient(tokens(), { fetchImpl: fetch });
    const devices = await client.listDevices();
    expect(devices.map(d => d.deviceId)).toEqual(['a', 'b']);
    expect(calls[1].url).toBe('https://api.smartthings.com/v1/devices?page=1');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  });

  it('retries once with a renewed token after a 401', async () => {
    const provider = tokens('old', 'new');
    const { fetch, calls } = scriptedFetch(() => json({}, 401), () => json({ components: { main: {} } }));
    const client = new SmartThingsClient(provider, { fetchImpl: fetch });
    await client.getStatus('dev');
    expect(provider.onUnauthorized).toHaveBeenCalledWith('old');
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer new');
  });

  it('reports rate limits with the Retry-After delay', async () => {
    const { fetch } = scriptedFetch(() => json({ error: { code: 'TooManyRequests' } }, 429, { 'retry-after': '42' }));
    const client = new SmartThingsClient(tokens(), { fetchImpl: fetch });
    const error = await client.getStatus('dev').catch(e => e) as SmartThingsApiError;
    expect(error).toBeInstanceOf(SmartThingsApiError);
    expect(error.isRateLimited).toBe(true);
    expect(error.retryAfterMs).toBe(42_000);
  });

  it('sends commands to the main component and fails on FAILED results', async () => {
    const { fetch, calls } = scriptedFetch(
      () => json({ results: [{ id: '1', status: 'ACCEPTED' }] }),
      () => json({ results: [{ id: '1', status: 'FAILED' }] }),
    );
    const client = new SmartThingsClient(tokens(), { fetchImpl: fetch });
    await client.executeCommands('dev', [{ capability: 'switch', command: 'on' }]);
    expect(JSON.parse(calls[0].body!)).toEqual({ commands: [{ component: 'main', arguments: [], capability: 'switch', command: 'on' }] });
    await expect(client.executeCommands('dev', [{ capability: 'switch', command: 'off' }])).rejects.toThrow(/failed/);
  });

  it('turns network errors into status-0 API errors', async () => {
    const { fetch } = scriptedFetch(() => {
      throw new TypeError('fetch failed');
    });
    const client = new SmartThingsClient(tokens(), { fetchImpl: fetch });
    const error = await client.getStatus('dev').catch(e => e) as SmartThingsApiError;
    expect(error.status).toBe(0);
    expect(error.message).toMatch(/Could not reach SmartThings/);
  });
});

describe('parseRetryAfter', () => {
  it('handles seconds, dates and junk', () => {
    expect(parseRetryAfter('10')).toBe(10_000);
    expect(parseRetryAfter('999999')).toBe(15 * 60 * 1000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    const inAMinute = new Date(Date.now() + 60_000).toUTCString();
    expect(parseRetryAfter(inAMinute)).toBeGreaterThan(50_000);
  });
});
