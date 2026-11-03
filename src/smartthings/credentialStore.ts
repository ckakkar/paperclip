import { promises as fs } from 'node:fs';
import path from 'node:path';

import { CREDENTIALS_FILE, STORAGE_DIR } from '../settings.js';

/**
 * Everything Paperclip needs to stay signed in to SmartThings. Lives next to the
 * Homebridge config (never inside config.json) with owner-only permissions, because
 * SmartThings rotates the refresh token on every renewal and this file holds the
 * only valid copy.
 */
export interface StoredCredentials {
  version: 1;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  appId?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  installedAppId?: string;
  locationName?: string;
  /** ISO timestamp of the last write, used to notice changes made by another process. */
  updatedAt?: string;
}

export class CredentialFileError extends Error {
  constructor(message: string, readonly filePath: string) {
    super(message);
    this.name = 'CredentialFileError';
  }
}

export class CredentialStore {
  readonly filePath: string;

  constructor(storagePath: string) {
    this.filePath = path.join(storagePath, STORAGE_DIR, CREDENTIALS_FILE);
  }

  /** Returns null when nothing has been stored yet. Throws when the file exists but cannot be used. */
  async read(): Promise<StoredCredentials | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new CredentialFileError(`Could not read ${this.filePath}: ${(error as Error).message}`, this.filePath);
    }

    try {
      const parsed = JSON.parse(raw) as StoredCredentials;
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('not an object');
      }
      return { ...parsed, version: 1 };
    } catch (error) {
      throw new CredentialFileError(
        `${this.filePath} is corrupt (${(error as Error).message}). Delete it and run the Paperclip setup again.`,
        this.filePath,
      );
    }
  }

  /** Atomic write: temp file, fsync, rename. A crash can never leave half a file behind. */
  async write(credentials: Omit<StoredCredentials, 'version' | 'updatedAt'>): Promise<StoredCredentials> {
    const data: StoredCredentials = { ...credentials, version: 1, updatedAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });

    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await fs.open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await fs.rename(tmpPath, this.filePath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return data;
  }

  /** Merges `changes` into whatever is stored now. */
  async update(changes: Partial<Omit<StoredCredentials, 'version' | 'updatedAt'>>): Promise<StoredCredentials> {
    const current = await this.read().catch(() => null);
    return this.write({ ...(current ?? {}), ...changes });
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }
}
