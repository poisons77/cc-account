import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { readCredentials, writeCredentials } from './credentials.js';
import { readJsonOr, writeJsonAtomic } from './jsonFile.js';
import { writeRotationState } from './rotationState.js';

const CREDENTIALS_SNAPSHOT = '.credentials.json';
const ACCOUNT_SNAPSHOT = 'oauthAccount.json';
const META = 'meta.json';

/**
 * Names the `/cc-account` slash command spends on its own subcommands. An account called one of
 * these would be reachable from the CLI but not from the slash command, so it is refused at save
 * time rather than left as a trap to discover later.
 */
export const RESERVED_NAMES = ['rotate', 'current'];

/** Ask the CLI who is logged in. Returns null when it is unavailable. */
export function authStatus() {
  const run = (options) =>
    execFileSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', ...options });
  try {
    return JSON.parse(run({ stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    // A .cmd or .ps1 shim on PATH needs a shell to resolve.
    try {
      return JSON.parse(run({ stdio: ['ignore', 'pipe', 'ignore'], shell: true }));
    } catch {
      return null;
    }
  }
}

export const slugify = (email) => String(email).split('@')[0].replace(/[^A-Za-z0-9._-]/g, '-');

const accountDir = (paths, name) => path.join(paths.store, name);

export function listAccounts(paths) {
  let entries;
  try {
    entries = fs.readdirSync(paths.store, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      meta: readJsonOr(path.join(paths.store, entry.name, META), {}),
    }));
}

export function findByEmail(paths, email) {
  if (!email) return null;
  return listAccounts(paths).find((account) => account.meta.email === email)?.name ?? null;
}

/**
 * Which account to rotate to. `savedAt` is rewritten every time an account is switched away
 * from, so the oldest one has had the longest to recover its rate-limit window.
 */
export function pickRotationTarget(paths) {
  const accounts = listAccounts(paths);
  if (accounts.length === 0) throw new Error('No accounts saved. Run: cc-account save <name>');

  const activeEmail = authStatus()?.email;
  const candidates = accounts.filter((account) => account.meta.email !== activeEmail);
  if (candidates.length === 0) {
    throw new Error(`Only one account saved (${accounts[0].name}); nothing to rotate to.`);
  }

  const stamp = (account) => Date.parse(account.meta.savedAt ?? '') || 0;
  return candidates.sort((a, b) => stamp(a) - stamp(b))[0].name;
}

export function saveAccount(paths, name) {
  const status = authStatus();
  if (!status?.loggedIn) throw new Error('Not logged in. Run `claude auth login` first.');

  const blob = readCredentials(paths);
  if (!blob) throw new Error('No stored credentials found to snapshot.');

  const resolved = name || slugify(status.email);
  if (RESERVED_NAMES.includes(resolved)) {
    throw new Error(
      `'${resolved}' is a /cc-account subcommand and cannot name an account. Pick another name.`,
    );
  }

  const dir = accountDir(paths, resolved);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  fs.writeFileSync(path.join(dir, CREDENTIALS_SNAPSHOT), blob, { mode: 0o600 });

  const config = readJsonOr(paths.configJson, {});
  if (config.oauthAccount) {
    writeJsonAtomic(path.join(dir, ACCOUNT_SNAPSHOT), config.oauthAccount);
  }

  writeJsonAtomic(path.join(dir, META), {
    email: status.email,
    authMethod: status.authMethod,
    apiProvider: status.apiProvider,
    subscriptionType: status.subscriptionType ?? null,
    orgName: status.orgName ?? null,
    savedAt: new Date().toISOString(),
  });

  return { name: resolved, status };
}

/**
 * Swap in a saved account. Deliberately does not require Claude Code to be
 * closed: it re-reads credentials on its next API call, and both writes here
 * are atomic. Only the oauthAccount key of .claude.json is replaced, so
 * unrelated state in that file - MCP server logins in particular - survives.
 */
export function useAccount(paths, name, { credsOnly = false } = {}) {
  const dir = accountDir(paths, name);
  const blobFile = path.join(dir, CREDENTIALS_SNAPSHOT);
  if (!fs.existsSync(blobFile)) {
    const known = listAccounts(paths).map((account) => account.name);
    const hint = known.length ? ` Known: ${known.join(', ')}` : ' No accounts saved yet.';
    throw new Error(`Unknown account '${name}'.${hint}`);
  }

  const target = readJsonOr(path.join(dir, META), {});
  const current = authStatus();

  if (current?.loggedIn && current.email && current.email === target.email) {
    return { alreadyActive: true, email: current.email };
  }

  // Refresh tokens rotate: without this the outgoing account keeps a snapshot
  // whose token the server has already retired. An account with no snapshot at
  // all gets one now - otherwise switching away from it costs a browser login.
  let restashed = null;
  if (current?.loggedIn) {
    restashed = saveAccount(paths, findByEmail(paths, current.email)).name;
  }

  writeCredentials(paths, fs.readFileSync(blobFile, 'utf8'));

  if (!credsOnly) {
    const snapshot = readJsonOr(path.join(dir, ACCOUNT_SNAPSHOT));
    if (snapshot) {
      const config = readJsonOr(paths.configJson, {});
      config.oauthAccount = snapshot;
      writeJsonAtomic(paths.configJson, config);
    }
  }

  for (const cache of paths.authCaches) {
    fs.rmSync(cache, { force: true });
  }

  const status = authStatus();
  // Publish who is live now, so a renderer that cannot resolve identity still knows.
  writeRotationState(paths, { active: name, email: status?.email });

  return { alreadyActive: false, restashed, status };
}
