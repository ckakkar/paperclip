#!/usr/bin/env node
/**
 * homebridge-paperclip command-line helper.
 *
 *   npx homebridge-paperclip setup      connect to SmartThings without the Homebridge UI
 *   npx homebridge-paperclip devices    list the air conditioners Paperclip can see
 *   npx homebridge-paperclip status X   print the raw SmartThings status of a device (for bug reports)
 *   npx homebridge-paperclip doctor     check the saved sign-in and the connection
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { buildProfile, describeProfile, isAirConditioner } from './ac/profile.js';
import { DEFAULT_REDIRECT_URI, type Log } from './settings.js';
import { SmartThingsClient } from './smartthings/client.js';
import { CredentialStore } from './smartthings/credentialStore.js';
import { buildAuthorizeUrl, createOAuthApp, exchangeCode, extractAuthCode, oauthAppDefinition } from './smartthings/oauth.js';
import { TokenManager } from './smartthings/tokenManager.js';
import { PLUGIN_VERSION } from './version.js';

const HELP = `homebridge-paperclip ${PLUGIN_VERSION}

Usage: homebridge-paperclip <command> [options]

Commands:
  setup             Connect Paperclip to your SmartThings account
  devices           List the air conditioners Paperclip can control
  status <device>   Print a device's raw SmartThings status (device ID or name)
  doctor            Check the saved sign-in and the SmartThings connection
  app-definition    Print a SmartThings app definition for "smartthings apps:create -i"
  disconnect        Delete the saved SmartThings sign-in

Options:
  -U, --storage <path>     Homebridge storage folder (default: ~/.homebridge)
  --pat <token>            Personal access token, used once to create the OAuth app (setup)
  --client-id <id>         Use an OAuth app you already created (setup)
  --client-secret <secret> Its client secret (setup)
  --redirect-uri <url>     Redirect URI registered on that app (default: ${DEFAULT_REDIRECT_URI})
  -v, --verbose            Log every SmartThings request
  -h, --help               Show this help
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'storage': { type: 'string', short: 'U' },
      'pat': { type: 'string' },
      'client-id': { type: 'string' },
      'client-secret': { type: 'string' },
      'redirect-uri': { type: 'string' },
      'verbose': { type: 'boolean', short: 'v' },
      'help': { type: 'boolean', short: 'h' },
    },
  });

  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return command ? 0 : 1;
  }

  const storage = path.resolve(expandHome(values.storage ?? process.env.HOMEBRIDGE_STORAGE_PATH ?? '~/.homebridge'));
  const store = new CredentialStore(storage);
  const log: Log = {
    debug: (m, ...p) => values.verbose && console.log(dim(m), ...p),
    info: (m, ...p) => console.log(m, ...p),
    warn: (m, ...p) => console.warn(`! ${m}`, ...p),
    error: (m, ...p) => console.error(`✗ ${m}`, ...p),
  };

  switch (command) {
    case 'setup':
      return setup(store, storage, values);
    case 'devices':
      return devices(store, log);
    case 'status':
      return status(store, log, rest.join(' '));
    case 'doctor':
      return doctor(store, storage, log);
    case 'app-definition':
      console.log(JSON.stringify(oauthAppDefinition(values['redirect-uri'] ?? DEFAULT_REDIRECT_URI), null, 2));
      return 0;
    case 'disconnect':
      await store.clear();
      console.log(`Deleted ${store.filePath}. Paperclip is no longer signed in to SmartThings.`);
      return 0;
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      return 1;
  }
}

async function setup(
  store: CredentialStore,
  storage: string,
  values: { 'pat'?: string; 'client-id'?: string; 'client-secret'?: string; 'redirect-uri'?: string },
): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!existsSync(storage)) {
      console.log(`! ${storage} does not exist yet. It will be created; pass --storage if Homebridge keeps its files elsewhere.`);
    }

    console.log(bold('\nPaperclip setup: connect to SmartThings\n'));

    let clientId = values['client-id']?.trim();
    let clientSecret = values['client-secret']?.trim();
    let redirectUri = values['redirect-uri']?.trim() || DEFAULT_REDIRECT_URI;
    let appId: string | undefined;

    if (!clientId || !clientSecret) {
      const existing = await store.read().catch(() => null);
      if (existing?.clientId && existing.clientSecret) {
        const reuse = (await rl.question(`Reuse the SmartThings app saved earlier (${mask(existing.clientId)})? [Y/n] `)).trim().toLowerCase();
        if (reuse === '' || reuse === 'y' || reuse === 'yes') {
          clientId = existing.clientId;
          clientSecret = existing.clientSecret;
          redirectUri = existing.redirectUri ?? redirectUri;
          appId = existing.appId;
        }
      }
    }

    if (!clientId || !clientSecret) {
      let pat = values.pat?.trim();
      if (!pat) {
        console.log('Step 1. Create a SmartThings personal access token (it is only used once, right now):');
        console.log(`   ${link('https://account.smartthings.com/tokens')}`);
        console.log('   Click "Generate new token", name it "paperclip", tick ALL the scopes, then Generate.\n');
        pat = (await rl.question('Paste the token here: ')).trim();
      }
      console.log('\nCreating the "Paperclip for Homebridge" app in your SmartThings account…');
      const app = await createOAuthApp(pat, { redirectUri });
      clientId = app.clientId;
      clientSecret = app.clientSecret;
      appId = app.appId;
      await store.write({ clientId, clientSecret, redirectUri, appId });
      console.log(`✓ App created (client ID ${mask(clientId)}). Saved to ${store.filePath}`);
      console.log('  You can delete the personal access token now; Paperclip does not keep it.\n');
    } else {
      await store.update({ clientId, clientSecret, redirectUri, appId, accessToken: undefined, refreshToken: undefined, expiresAt: undefined });
    }

    const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri });
    console.log('Step 2. Open this link, sign in with your Samsung account, pick the location with your AC and tap Authorize:');
    console.log(`   ${link(authorizeUrl)}\n`);
    console.log('   You will land on a page that starts with https://httpbin.org/get?code=…');
    const pasted = await rl.question('Paste that page\'s full address (or just the code) here: ');
    const code = extractAuthCode(pasted);

    const tokens = await exchangeCode({ clientId, clientSecret, redirectUri }, code);
    const client = new SmartThingsClient({ getAccessToken: async () => tokens.accessToken, onUnauthorized: async () => undefined });
    const all = await client.listDevices().catch(() => []);
    const acs = all.filter(isAirConditioner);
    const locationName = acs[0]?.locationId ? await client.getLocationName(acs[0].locationId) : undefined;

    await store.write({
      clientId, clientSecret, redirectUri, appId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      installedAppId: tokens.installedAppId,
      locationName,
    });

    console.log(`\n✓ Connected${locationName ? ` to "${locationName}"` : ''}. Saved to ${store.filePath}`);
    if (acs.length) {
      console.log(`  Air conditioners found: ${acs.map(d => d.label || d.name).join(', ')}`);
    } else {
      console.log(`  ! No air conditioners in this location (${all.length} other device(s)). Run setup again and pick another location.`);
    }
    console.log('  Paperclip picks this up within a minute; no Homebridge restart needed.\n');
    return 0;
  } finally {
    rl.close();
  }
}

async function connectedClient(store: CredentialStore, log: Log): Promise<SmartThingsClient | undefined> {
  const tokens = new TokenManager(log, store);
  const mode = await tokens.init();
  if (mode === 'none') {
    log.error(`Not connected. Run "homebridge-paperclip setup" first (looked in ${store.filePath}).`);
    return undefined;
  }
  return new SmartThingsClient(tokens, { log });
}

async function devices(store: CredentialStore, log: Log): Promise<number> {
  const client = await connectedClient(store, log);
  if (!client) {
    return 1;
  }
  const all = await client.listDevices();
  const acs = all.filter(isAirConditioner);
  console.log(`${all.length} SmartThings device(s), ${acs.length} air conditioner(s):\n`);
  for (const device of acs) {
    const status = await client.getStatus(device.deviceId);
    const profile = buildProfile(device, status);
    console.log(`${bold(device.label || device.name || '?')}  ${dim(device.deviceId)}`);
    console.log(`  model: ${device.ocf?.modelNumber?.split('|')[0] ?? device.deviceManufacturerCode ?? 'unknown'}`);
    console.log(`  ${describeProfile(profile)}\n`);
  }
  return 0;
}

async function status(store: CredentialStore, log: Log, query: string): Promise<number> {
  const client = await connectedClient(store, log);
  if (!client) {
    return 1;
  }
  const all = await client.listDevices();
  const q = query.trim().toLowerCase();
  const device = q
    ? all.find(d => d.deviceId.toLowerCase() === q || (d.label ?? '').toLowerCase() === q || (d.name ?? '').toLowerCase() === q)
    : all.find(isAirConditioner);
  if (!device) {
    log.error(q ? `No device matches "${query}".` : 'No air conditioner found.');
    return 1;
  }
  const deviceStatus = await client.getStatus(device.deviceId);
  console.log(JSON.stringify({ device, status: deviceStatus }, null, 2));
  return 0;
}

async function doctor(store: CredentialStore, storage: string, log: Log): Promise<number> {
  let ok = true;
  const check = (pass: boolean, message: string) => {
    console.log(`${pass ? '✓' : '✗'} ${message}`);
    ok &&= pass;
  };

  check(Number(process.versions.node.split('.')[0]) >= 22, `Node.js ${process.versions.node}`);
  check(existsSync(storage), `Homebridge storage folder ${storage}`);

  const creds = await store.read().catch(error => {
    check(false, (error as Error).message);
    return null;
  });
  check(Boolean(creds?.clientId && creds.clientSecret), 'SmartThings app credentials saved');
  check(Boolean(creds?.refreshToken), 'SmartThings sign-in saved');
  if (!creds?.refreshToken) {
    console.log('\nRun "homebridge-paperclip setup" or use the Paperclip settings page in the Homebridge UI.');
    return 1;
  }

  const client = await connectedClient(store, log);
  try {
    const all = await client!.listDevices();
    const acs = all.filter(isAirConditioner);
    check(true, `SmartThings reachable, ${all.length} device(s)`);
    check(acs.length > 0, `${acs.length} air conditioner(s): ${acs.map(d => d.label || d.name).join(', ') || 'none'}`);
    for (const device of acs) {
      const health = await client!.getHealth(device.deviceId).catch(() => undefined);
      check(health?.state !== 'OFFLINE', `${device.label || device.name}: ${health?.state ?? 'health unknown'}`);
    }
  } catch (error) {
    check(false, (error as Error).message);
  }
  return ok ? 0 : 1;
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p;
}

function mask(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : '••••';
}

const tty = process.stdout.isTTY;
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const link = (s: string) => (tty ? `\x1b[4m${s}\x1b[0m` : s);

main().then(
  code => process.exit(code),
  error => {
    console.error(`✗ ${(error as Error).message}`);
    process.exit(1);
  },
);
