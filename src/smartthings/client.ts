import { SMARTTHINGS_API_URL, silentLog, type Log } from '../settings.js';
import type { FetchLike } from './oauth.js';
import type { TokenProvider } from './tokenManager.js';
import type { Device, DeviceHealth, DeviceStatus } from './types.js';

export interface Command {
  component?: string;
  capability: string;
  command: string;
  arguments?: unknown[];
}

export class SmartThingsApiError extends Error {
  constructor(
    message: string,
    /** 0 for network errors and timeouts. */
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SmartThingsApiError';
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

export interface ClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  log?: Log;
}

const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

export class SmartThingsClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly log: Log;

  constructor(private readonly tokens: TokenProvider, options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? SMARTTHINGS_API_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? silentLog;
  }

  /** Every device the token can see, following pagination. */
  async listDevices(): Promise<Device[]> {
    const devices: Device[] = [];
    let next: string | undefined = `${this.baseUrl}/devices`;
    let pages = 0;
    while (next && pages < 50) {
      const page: { items?: Device[]; _links?: { next?: { href?: string } | null } } = await this.request('GET', next);
      devices.push(...(page.items ?? []));
      next = page._links?.next?.href ?? undefined;
      pages++;
    }
    return devices;
  }

  getDevice(deviceId: string): Promise<Device> {
    return this.request('GET', `/devices/${encodeURIComponent(deviceId)}`);
  }

  getStatus(deviceId: string): Promise<DeviceStatus> {
    return this.request('GET', `/devices/${encodeURIComponent(deviceId)}/status`);
  }

  getHealth(deviceId: string): Promise<DeviceHealth> {
    return this.request('GET', `/devices/${encodeURIComponent(deviceId)}/health`);
  }

  async getLocationName(locationId: string): Promise<string | undefined> {
    try {
      const location: { name?: string } = await this.request('GET', `/locations/${encodeURIComponent(locationId)}`);
      return location.name;
    } catch {
      return undefined;
    }
  }

  async executeCommands(deviceId: string, commands: Command[]): Promise<void> {
    const body = { commands: commands.map(c => ({ component: 'main', arguments: [], ...c })) };
    const result: { results?: { status?: string; id?: string }[] } =
      await this.request('POST', `/devices/${encodeURIComponent(deviceId)}/commands`, body);
    const failed = result.results?.filter(r => r.status === 'FAILED') ?? [];
    if (failed.length > 0) {
      throw new SmartThingsApiError(`SmartThings reported ${failed.length} of ${commands.length} command(s) as failed`, 200);
    }
  }

  private async request<T>(method: 'GET' | 'POST', pathOrUrl: string, body?: unknown): Promise<T> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;

    let token = await this.tokens.getAccessToken();
    let response = await this.send(method, url, token, body);

    if (response.status === 401) {
      const retryToken = await this.tokens.onUnauthorized(token);
      if (retryToken) {
        token = retryToken;
        response = await this.send(method, url, token, body);
      }
    }

    const text = await response.text();

    if (!response.ok) {
      const retryAfterMs = response.status === 429 ? parseRetryAfter(response.headers.get('retry-after')) : undefined;
      throw new SmartThingsApiError(describeFailure(method, url, response.status, text), response.status, retryAfterMs);
    }

    if (text === '') {
      return {} as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SmartThingsApiError(`SmartThings returned a response that is not JSON for ${method} ${shortPath(url)}`, response.status);
    }
  }

  private async send(method: string, url: string, token: string, body: unknown): Promise<Response> {
    this.log.debug(`SmartThings ${method} ${shortPath(url)}${body ? ` ${JSON.stringify(body)}` : ''}`);
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const err = error as Error;
      const reason = err.name === 'TimeoutError' ? `timed out after ${this.timeoutMs / 1000}s` : err.message;
      throw new SmartThingsApiError(`Could not reach SmartThings (${method} ${shortPath(url)}): ${reason}`, 0);
    }
  }
}

function shortPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/v1/, '') + parsed.search;
  } catch {
    return url;
  }
}

function describeFailure(method: string, url: string, status: number, text: string): string {
  let detail: string;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
    detail = parsed.error?.message ?? parsed.error?.code ?? '';
  } catch {
    detail = text.slice(0, 200);
  }

  const hints: Record<number, string> = {
    401: 'The SmartThings sign-in is no longer valid. Open Paperclip\'s settings and reconnect.',
    403: 'This SmartThings account does not allow that. If you just reconnected, make sure you picked the location that has your air conditioner.',
    404: 'SmartThings does not know this device any more. Was it removed from the SmartThings app?',
    409: 'The device is busy or offline in SmartThings.',
    422: 'SmartThings rejected the command for this device.',
    429: 'SmartThings rate limit hit; Paperclip will slow down.',
  };
  const hint = hints[status] ?? (status >= 500 ? 'SmartThings is having trouble; Paperclip will keep retrying.' : '');
  return `SmartThings ${method} ${shortPath(url)} failed with HTTP ${status}${detail ? ` (${detail})` : ''}.${hint ? ` ${hint}` : ''}`;
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
  }
  const date = Date.parse(header);
  if (Number.isNaN(date)) {
    return undefined;
  }
  const delay = date - Date.now();
  return delay > 0 ? Math.min(delay, MAX_RETRY_AFTER_MS) : undefined;
}
