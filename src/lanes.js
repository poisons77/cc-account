import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  accountDir,
  browserLogin,
  expiryLevel,
  listAccounts,
  refuseOnKeychain,
  requireSnapshot,
  runClaude,
} from './accounts.js';
import { accessToken, refreshTokenExpiry } from './credentials.js';
import { readJsonOr, writeFileAtomic } from './jsonFile.js';
import { confinedTo } from './paths.js';

/**
 * A lane is a second login of a saved account, in a Claude Code config dir of its own inside the
 * account's store dir. It serves that account's connectors to every session, whichever account is
 * live, and never touches the snapshot: two copies of one login would refresh apart and one would
 * end up on a dead token.
 */
export const laneDir = (paths, name) => path.join(accountDir(paths, name), 'lane');

/** The paths of a `claude` run confined to the lane of `name`. */
export const lanePaths = (paths, name) => confinedTo(laneDir(paths, name)).paths;

/** The lane's credential file as it is on disk, or null when it has none. */
export function laneBlob(paths, name) {
  try {
    return fs.readFileSync(lanePaths(paths, name).credentialsFile, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Who the lane of `name` is signed in as and when its login stops refreshing (epoch milliseconds),
 * or null when the account has no lane.
 */
export function laneStatus(paths, name) {
  const blob = laneBlob(paths, name);
  if (blob === null) return null;
  return {
    dir: laneDir(paths, name),
    email: readJsonOr(lanePaths(paths, name).configJson, {})?.oauthAccount?.emailAddress ?? null,
    expiresAt: refreshTokenExpiry(blob),
  };
}

/**
 * The lanes whose login ends within the warning window, or has ended, each with its account's
 * `meta` and the level `expiryLevel` gives it. A lane's login runs on its own 30-day clock.
 */
export const expiringLanes = (paths, now = Date.now()) =>
  listAccounts(paths).flatMap(({ name, meta }) => {
    const lane = laneStatus(paths, name);
    const level = lane && expiryLevel(lane.expiresAt, now);
    return level ? [{ name, meta, expiresAt: lane.expiresAt, level, lane: true }] : [];
  });

/**
 * An account name goes into the commands every session runs for its connectors, through a shell,
 * so a name with anything else in it could run a command of its own there.
 */
const NAME_SAFE = /^[A-Za-z0-9._-]+$/;

export function refuseUnsafeName(name) {
  if (!NAME_SAFE.test(name)) {
    throw new Error(
      `'${name}' cannot lend connectors: every session runs commands with the account's name in ` +
        "them, so it may hold only letters, digits, '.', '_' and '-'. Save the account under such a name.",
    );
  }
}

/**
 * Present while the lane is being signed in again. The new login's email is known only once the
 * sign-in ends, and until then the lane's token may already be another account's: the lane serves
 * nothing while this exists. A sign-in killed midway leaves it, and the lane stays shut until a
 * sign-in as the account's own email completes.
 */
const signingInFile = (paths, name) => path.join(laneDir(paths, name), '.signing-in');

/**
 * Refuse a lane that must not serve: none yet, mid sign-in, or signed in as anyone but the
 * account. A lane serves an account's connectors to every session, so serving another account's
 * login would open that account's data.
 */
export function assertLaneServes(paths, name) {
  const meta = requireSnapshot(paths, name);
  const status = laneStatus(paths, name);
  if (!status) throw new Error(`'${name}' has no lane yet. Sign it in: cc-account lane ${name}`);
  if (fs.existsSync(signingInFile(paths, name))) {
    throw new Error(
      `The lane of '${name}' is being signed in again, or a sign-in stopped halfway. ` +
        `Its connectors are back once it is signed in as ${meta.email}: cc-account lane ${name}`,
    );
  }
  if (!meta.email || status.email !== meta.email) {
    throw new Error(
      `The lane of '${name}' is signed in as ${status.email}, not ${meta.email}. ` +
        `Sign it in again: cc-account lane ${name}`,
    );
  }
}

/**
 * Sign the lane of `name` in through the browser: the first time, or again to move its expiry. A
 * first sign-in lands beside the lane and takes its place only once it is the account's own email.
 * A renewal signs in in place, which keeps the lane's servers and their logins (goematic's among
 * them), with the lane shut while it runs; a wrong account leaves it shut until signed in again.
 */
export function ensureLane(paths, name, { onLogin = () => {} } = {}) {
  refuseOnKeychain('A lane');
  refuseUnsafeName(name);

  const meta = requireSnapshot(paths, name);
  if (!meta.email) throw new Error(`'${name}' has no email on record to sign in as.`);

  const login = (dir) =>
    browserLogin(paths, { email: meta.email, browser: meta.browser, label: `the lane of '${name}'`, onLogin, dir });
  const wrongAccount = (signedInAs, consequence) =>
    new Error(`The browser signed in ${signedInAs}, not ${meta.email}. ${consequence}`);

  const dir = laneDir(paths, name);
  if (!laneStatus(paths, name)) {
    const fresh = `${dir}.new`;
    fs.rmSync(fresh, { recursive: true, force: true });
    fs.mkdirSync(fresh, { recursive: true, mode: 0o700 });
    try {
      const signedInAs = login(fresh).status.email;
      if (signedInAs !== meta.email) throw wrongAccount(signedInAs, `Nothing was changed. Sign in there as ${meta.email}.`);
      // A lane dir with no login left in it (signed out inside, or only caches) gives way.
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(fresh, dir);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
    return { name, renewed: false, ...laneStatus(paths, name) };
  }

  const before = laneBlob(paths, name);
  const marker = signingInFile(paths, name);
  writeFileAtomic(marker, '');
  try {
    const signedInAs = login(dir).status.email;
    if (signedInAs !== meta.email) {
      throw wrongAccount(signedInAs, `The connectors of '${name}' stop until its lane is signed in again as ${meta.email}: cc-account lane ${name}`);
    }
  } catch (error) {
    // Untouched by the failed sign-in: the old login is still the account's own, so it serves on.
    if (laneBlob(paths, name) === before) fs.rmSync(marker, { force: true });
    throw error;
  }
  fs.rmSync(marker, { force: true });

  // The old login still answers when a renewal is abandoned, so only a new token proves one.
  const renewed =
    accessToken(laneBlob(paths, name))?.token !== accessToken(before)?.token ||
    refreshTokenExpiry(laneBlob(paths, name)) !== refreshTokenExpiry(before);
  if (!renewed) throw new Error(`The sign-in for the lane of '${name}' did not complete. Nothing was changed.`);
  return { name, renewed: true, ...laneStatus(paths, name) };
}

/**
 * Token renewal. Claude Code renews a lane's tokens itself whenever it connects the lane's servers,
 * so cc-account only starts that and never writes a token. A renewal takes about 6 s and Claude Code
 * gives a headers helper 10 s, so a token is renewed in the background from half an hour before
 * its end, and inline only in its last minutes; a helper killed past its 10 s is simply run again.
 */
const RENEW_AHEAD_MS = 30 * 60 * 1000;
const RENEW_NOW_MS = 5 * 60 * 1000;
// A background renewal Claude Code finds too early to act on changes nothing; trying again on
// every connection in that half hour would start a process each time.
const RETRY_AFTER_MS = 5 * 60 * 1000;
// One renewal per lane at a time, so sessions starting together do not each spend 6 s on it. A
// renewal is never killed, so only a lock far older than any renewal is one a crash left.
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_WAIT_MS = 8 * 1000;
const LOCK_POLL_MS = 200;
const RENEWER = fileURLToPath(new URL('./renewLane.js', import.meta.url));

const lockFile = (paths, name) => path.join(laneDir(paths, name), '.renew.lock');
const triedFile = (paths, name) => path.join(laneDir(paths, name), '.renew-tried');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const isStale = (file) => Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS;

/**
 * Take the lock, or false when another renewal holds it. A lock a crash left is first moved aside
 * under a name of this process's own: only one of two processes finding it can move it, and a
 * fresh lock moved by mistake is put back.
 */
function takeLock(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.closeSync(fs.openSync(file, 'wx', 0o600));
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const aside = `${file}.${process.pid}-${Date.now()}`;
    try {
      if (!isStale(file)) return false;
      fs.renameSync(file, aside);
      if (!isStale(aside)) {
        if (!fs.existsSync(file)) fs.renameSync(aside, file);
        return false;
      }
      fs.rmSync(aside, { force: true });
    } catch {
      /* released or taken over meanwhile: try again */
    }
  }
  return false;
}

/**
 * Have Claude Code renew the lane's tokens: by connecting `server` when given, else every server of
 * the lane, which renews the claude.ai login with them. When another renewal is running, `wait`
 * waits for it instead of starting a second one. True when this call ran the renewal.
 */
export function renewLane(paths, name, server, { wait = true } = {}) {
  // A sign-in in progress writes the same files; a renewal then could undo it.
  if (fs.existsSync(signingInFile(paths, name))) return false;
  const file = lockFile(paths, name);
  if (!takeLock(file)) {
    for (let waited = 0; wait && fs.existsSync(file) && waited < LOCK_WAIT_MS; waited += LOCK_POLL_MS) {
      sleep(LOCK_POLL_MS);
    }
    return false;
  }
  try {
    // Never killed: one stopped halfway could leave the lane on a refresh token already replaced.
    runClaude(server ? ['mcp', 'get', server] : ['mcp', 'list'], {
      stdio: 'ignore',
      env: confinedTo(laneDir(paths, name)).env,
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
  return true;
}

function renewInBackground(paths, name, server) {
  const tried = triedFile(paths, name);
  try {
    if (Date.now() - fs.statSync(tried).mtimeMs < RETRY_AFTER_MS) return;
  } catch {
    /* never tried */
  }
  writeFileAtomic(tried, '');
  spawn(process.execPath, [RENEWER, name, ...(server ? [server] : [])], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

/**
 * The request headers that let a session use a connector of account `name` through its lane: the
 * claude.ai login's token for a claude.ai connector (with the session id Anthropic's proxy
 * requires), or the lane's own login to `server` for a server added in Claude Code. Only from a
 * lane that serves (see `assertLaneServes`).
 */
export function laneHeaders(paths, name, server, { now = Date.now() } = {}) {
  assertLaneServes(paths, name);

  const read = () => accessToken(laneBlob(paths, name), server);
  let token = read();
  if (!token) {
    throw new Error(
      server
        ? `The lane of '${name}' has no login to ${server}. Sign in to it: cc-account attach ${name} ${server}`
        : `The lane of '${name}' holds no claude.ai token. Sign it in again: cc-account lane ${name}`,
    );
  }

  const left = token.expiresAt === null ? Infinity : token.expiresAt - now;
  if (left < RENEW_NOW_MS) {
    renewLane(paths, name, server);
    token = read() ?? token;
  } else if (left < RENEW_AHEAD_MS) {
    renewInBackground(paths, name, server);
  }

  return {
    Authorization: `Bearer ${token.token}`,
    ...(server ? {} : { 'X-Mcp-Client-Session-Id': randomUUID() }),
  };
}
