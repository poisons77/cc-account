import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { BROWSER_COMMAND_ENV, browserCommand, writeBrowserShim } from './browser.js';
import {
  readCredentials,
  refreshTokenExpiry,
  usesKeychain,
  writeCredentials,
} from './credentials.js';
import { readJsonIfPresent, readJsonOr, writeFileAtomic, writeJsonAtomic } from './jsonFile.js';
import { confinedTo } from './paths.js';
import { writeRotationState } from './rotationState.js';

const CREDENTIALS_SNAPSHOT = '.credentials.json';
const ACCOUNT_SNAPSHOT = 'oauthAccount.json';
const META = 'meta.json';

/**
 * Names the `/cc-account` slash command spends on its own subcommands. An account called one of
 * these would be reachable from the CLI but not from the slash command, so it is refused at save
 * time rather than left as a trap to discover later.
 */
export const RESERVED_NAMES = ['rotate', 'current', 'renew'];

/** How far ahead of a login's expiry to start asking for a renewal. Claude Code warns at 3 days. */
export const EXPIRY_WARNING_MS = 3 * 24 * 60 * 60 * 1000;

const SHELL_SAFE = /^[\w@+=:,./-]+$/;

/**
 * Run the `claude` CLI, resolved the way a terminal resolves it. On Windows that takes the shell:
 * a direct spawn cannot run the npm `.cmd` shim and looks only for `.exe` files, so it would skip
 * a `claude.cmd` earlier on PATH and run whichever `claude.exe` comes later.
 */
function runClaude(args, options) {
  if (process.platform !== 'win32') return spawnSync('claude', args, options);
  const command = ['claude', ...args].map((arg) => {
    if (SHELL_SAFE.test(arg)) return arg;
    // Quotes do not stop cmd.exe expanding %VAR%, and a quote inside the argument ends them.
    if (/["%]/.test(arg)) throw new Error(`Cannot pass ${arg} to claude through the Windows shell.`);
    return `"${arg}"`;
  });
  return spawnSync(command.join(' '), { ...options, shell: true });
}

/**
 * Ask the CLI who is logged in, under `env`. Returns null when it is unavailable. Logged out still
 * prints JSON, with a non-zero exit.
 */
export function authStatus(env = process.env) {
  const { stdout } = runClaude(['auth', 'status', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** The email an `authStatus` result is logged in as, or null. A logged-out result names nobody. */
export const loggedInEmail = (status) => (status?.loggedIn ? (status.email ?? null) : null);

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

/** The snapshot's `meta.json`, or an error naming the accounts that do exist. */
function requireSnapshot(paths, name) {
  const dir = accountDir(paths, name);
  if (!fs.existsSync(path.join(dir, CREDENTIALS_SNAPSHOT))) {
    const known = listAccounts(paths).map((account) => account.name);
    const hint = known.length ? ` Known: ${known.join(', ')}` : ' No accounts saved yet.';
    throw new Error(`Unknown account '${name}'.${hint}`);
  }
  return readJsonOr(path.join(dir, META), {});
}

/**
 * Every account, marked active when its email is `activeEmail`, with the epoch milliseconds its
 * login stops refreshing (null when unknown). The active account is read from the live
 * credentials, since a manual `/login` renews those without touching the snapshot - except from
 * the Keychain, which can raise an access dialog on every run, session start included.
 */
export function accountsWithExpiry(paths, activeEmail) {
  return listAccounts(paths).map((account) => {
    const active = Boolean(activeEmail) && account.meta.email === activeEmail;
    let blob = null;
    try {
      blob = active && !usesKeychain()
        ? readCredentials(paths)
        : fs.readFileSync(path.join(accountDir(paths, account.name), CREDENTIALS_SNAPSHOT), 'utf8');
    } catch {
      /* no readable blob, so no known expiry */
    }
    return { ...account, active, expiresAt: refreshTokenExpiry(blob) };
  });
}

/** The accounts whose login expires within `EXPIRY_WARNING_MS`, or has already expired. */
export const expiringAccounts = (paths, activeEmail, now = Date.now()) =>
  accountsWithExpiry(paths, activeEmail).filter(
    (account) => account.expiresAt !== null && account.expiresAt - now < EXPIRY_WARNING_MS,
  );

/**
 * Which account to rotate to. `savedAt` is rewritten every time an account is switched away
 * from, so the oldest one has had the longest to recover its rate-limit window.
 */
export function pickRotationTarget(paths) {
  const accounts = listAccounts(paths);
  if (accounts.length === 0) throw new Error('No accounts saved. Run: cc-account save <name>');

  const activeEmail = loggedInEmail(authStatus());
  const candidates = accounts.filter((account) => account.meta.email !== activeEmail);
  if (candidates.length === 0) {
    throw new Error(`Only one account saved (${accounts[0].name}); nothing to rotate to.`);
  }

  const stamp = (account) => Date.parse(account.meta.savedAt ?? '') || 0;
  return candidates.sort((a, b) => stamp(a) - stamp(b))[0].name;
}

/**
 * Write a snapshot. A snapshot already holding another email is refused: overwriting it would put
 * one account's token under another account's name, and the original is only recoverable through
 * a browser login. The per-account browser setting survives the rewrite.
 *
 * `keepSavedAt` holds on to the time the account was last switched away from, which `rotate`
 * orders by, for a write that is not a switch.
 */
function writeSnapshot(paths, name, { blob, oauthAccount, status }, { keepSavedAt = false } = {}) {
  if (RESERVED_NAMES.includes(name)) {
    throw new Error(
      `'${name}' is a /cc-account subcommand and cannot name an account. Pick another name.`,
    );
  }

  const dir = accountDir(paths, name);
  const previous = readJsonOr(path.join(dir, META), {});
  if (previous.email && previous.email !== status.email) {
    throw new Error(
      `'${name}' holds ${previous.email}, but ${status.email} is logged in. Nothing was changed. ` +
        `Save ${status.email} under another name first: cc-account save <another-name>`,
    );
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  writeFileAtomic(path.join(dir, CREDENTIALS_SNAPSHOT), blob);

  if (oauthAccount) {
    writeJsonAtomic(path.join(dir, ACCOUNT_SNAPSHOT), oauthAccount);
  }

  writeJsonAtomic(path.join(dir, META), {
    email: status.email,
    authMethod: status.authMethod,
    apiProvider: status.apiProvider,
    subscriptionType: status.subscriptionType ?? null,
    orgName: status.orgName ?? null,
    savedAt: (keepSavedAt && previous.savedAt) || new Date().toISOString(),
    ...(previous.browser && { browser: previous.browser }),
  });
}

export function saveAccount(paths, name) {
  const status = authStatus();
  if (!status?.loggedIn) throw new Error('Not logged in. Run `claude auth login` first.');

  const blob = readCredentials(paths);
  if (!blob) throw new Error('No stored credentials found to snapshot.');

  const resolved = name || slugify(status.email);
  writeSnapshot(paths, resolved, {
    blob,
    oauthAccount: readJsonOr(paths.configJson, {}).oauthAccount,
    status,
  });

  return { name: resolved, status };
}

/**
 * Make a login live as account `name`: tokens, identity, caches, published state. Both writes are
 * atomic. Only the oauthAccount key of .claude.json is replaced, so unrelated state in that file -
 * MCP server logins in particular - survives.
 */
function installLogin(paths, name, { blob, oauthAccount }, { credsOnly = false } = {}) {
  // Read before anything is written: a .claude.json that exists but cannot be read stops the
  // switch here, instead of after the tokens have moved, and is never replaced by `{}`.
  const config = !credsOnly && oauthAccount ? readJsonIfPresent(paths.configJson, {}) : null;

  writeCredentials(paths, blob);

  if (config) {
    config.oauthAccount = oauthAccount;
    writeJsonAtomic(paths.configJson, config);
  }

  for (const cache of paths.authCaches) {
    fs.rmSync(cache, { force: true });
  }

  const status = authStatus();
  // Publish who is live now, so a renderer that cannot resolve identity still knows.
  writeRotationState(paths, { active: name, email: status?.email });
  return status;
}

/**
 * Swap in a saved account. Deliberately does not require Claude Code to be
 * closed: it re-reads credentials on its next API call.
 */
export function useAccount(paths, name, { credsOnly = false } = {}) {
  const target = requireSnapshot(paths, name);
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

  const dir = accountDir(paths, name);
  const login = {
    blob: fs.readFileSync(path.join(dir, CREDENTIALS_SNAPSHOT), 'utf8'),
    oauthAccount: readJsonOr(path.join(dir, ACCOUNT_SNAPSHOT)),
  };
  const status = installLogin(paths, name, login, { credsOnly });
  return { alreadyActive: false, restashed, status };
}

/** Set the command `renew` opens this account's sign-in page with, or clear it with null. */
export function setBrowser(paths, name, command) {
  const metaFile = path.join(accountDir(paths, name), META);
  const { browser, ...meta } = requireSnapshot(paths, name);
  writeJsonAtomic(metaFile, command ? { ...meta, browser: command } : meta);
}

/**
 * Sign an account in again, which is the only thing that moves its expiry. The login runs in a
 * throwaway config dir, so the live session is never touched while it is in progress, and its
 * result is kept only if the browser signed in the account being renewed. Renewing the live
 * account also installs the new login, or the next switch away would re-snapshot the old one over
 * it.
 *
 * `onLogin(command, email)` runs just before the login starts; `command` is null when no browser
 * was found.
 */
export function renewAccount(paths, name, { onLogin = () => {} } = {}) {
  if (usesKeychain()) {
    throw new Error(
      'renew is not available on macOS: a login there writes to the shared Keychain, which ' +
        'cc-account cannot keep apart from the live account.',
    );
  }

  const meta = requireSnapshot(paths, name);
  if (!meta.email) throw new Error(`'${name}' has no email on record to sign in as.`);

  const command = browserCommand(paths, meta);
  sweepStaleScratch(paths);
  const scratch = fs.mkdtempSync(paths.loginScratch);
  try {
    const confined = confinedTo(scratch);
    onLogin(command, meta.email);
    runClaude(['auth', 'login', '--email', meta.email], {
      stdio: 'inherit',
      env: {
        ...confined.env,
        BROWSER: writeBrowserShim(scratch),
        [BROWSER_COMMAND_ENV]: JSON.stringify(command ?? []),
      },
    });

    const status = authStatus(confined.env);
    if (!status?.loggedIn) {
      throw new Error(`The login for '${name}' did not complete. Nothing was changed.`);
    }
    if (status.email !== meta.email) {
      throw new Error(
        `The browser signed in ${status.email}, not ${meta.email}. Nothing was changed. ` +
          `Sign in there as ${meta.email}, or give '${name}' its own browser: ` +
          `cc-account browser ${name} <command>`,
      );
    }

    const blob = readCredentials(confined.paths);
    if (!blob) throw new Error(`The login for '${name}' left no credentials. Nothing was changed.`);

    const login = { blob, oauthAccount: readJsonOr(confined.paths.configJson, {}).oauthAccount };

    // Live first, then the snapshot. If renew dies in between, the next switch away re-snapshots
    // the new live login; the other order would have it re-snapshot the old one over the new.
    const active = loggedInEmail(authStatus()) === meta.email;
    if (active) installLogin(paths, name, login);
    writeSnapshot(paths, name, { ...login, status }, { keepSavedAt: true });

    return { status, active, expiresAt: refreshTokenExpiry(blob) };
  } finally {
    removeScratch(scratch);
  }
}

/** How old a login dir must be before a later renew treats it as abandoned. */
const STALE_SCRATCH_MS = 60 * 60 * 1000;

/**
 * Remove a throwaway login dir. It can hold a fresh token, so a busy file is retried; a failure
 * never replaces renew's own result, and the next renew sweeps what is left.
 */
function removeScratch(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* swept by the next renew */
  }
}

/** A renew killed mid-login never reaches its `finally`, so each renew clears the leftovers first. */
function sweepStaleScratch(paths, now = Date.now()) {
  const parent = path.dirname(paths.loginScratch);
  const prefix = path.basename(paths.loginScratch);
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const dir = path.join(parent, entry.name);
    try {
      if (now - fs.statSync(dir).mtimeMs > STALE_SCRATCH_MS) removeScratch(dir);
    } catch {
      /* already gone */
    }
  }
}
