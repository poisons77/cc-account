import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';

import { listAccounts, saveAccount } from '../src/accounts.js';
import { ensureLane, laneDir, laneHeaders, lanePaths, laneStatus } from '../src/lanes.js';
import { login, readJson, sandbox } from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/cc-account.js', import.meta.url));
const MINUTE_MS = 60 * 1000;

/** A lane signs in through `claude auth login`, which the sandbox fakes only off macOS. */
const needsLane = { skip: process.platform === 'darwin' && 'a lane is refused on macOS, as renew is' };

let box;
let paths;

beforeEach(() => {
  box = sandbox();
  paths = box.paths;
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
});

afterEach(() => {
  box.restore();
});

test('a first lane signs the account in on its own, beside the live login and the snapshot', needsLane, () => {
  const liveBefore = fs.readFileSync(paths.credentialsFile, 'utf8');
  const snapshotBefore = fs.readFileSync(path.join(paths.store, 'work', '.credentials.json'), 'utf8');

  const result = ensureLane(paths, 'work');

  assert.equal(result.renewed, false);
  assert.equal(result.email, 'work@example.com');
  assert.ok(result.expiresAt > Date.now());
  assert.equal(laneStatus(paths, 'work').email, 'work@example.com');
  assert.equal(fs.readFileSync(paths.credentialsFile, 'utf8'), liveBefore);
  assert.equal(fs.readFileSync(path.join(paths.store, 'work', '.credentials.json'), 'utf8'), snapshotBefore);
  assert.equal(fs.existsSync(`${laneDir(paths, 'work')}.new`), false);
  // The lane sits inside the account's dir, so it is never listed as an account of its own.
  assert.deepEqual(listAccounts(paths).map((account) => account.name), ['work']);
  assert.deepEqual(fs.readdirSync(box.tmp), [], 'the throwaway shim dir is removed');
});

test('a first lane signed in as another account is not kept', needsLane, () => {
  process.env.FAKE_BROWSER_ACCOUNT = 'personal@example.com';

  assert.throws(
    () => ensureLane(paths, 'work'),
    /The browser signed in personal@example\.com, not work@example\.com\. Nothing was changed\./,
  );
  assert.equal(laneStatus(paths, 'work'), null);
  assert.equal(fs.existsSync(`${laneDir(paths, 'work')}.new`), false);
});

test('an abandoned first lane leaves nothing behind', needsLane, () => {
  process.env.FAKE_BROWSER_ACCOUNT = '';

  assert.throws(() => ensureLane(paths, 'work'), /did not complete\. Nothing was changed\./);
  assert.equal(laneStatus(paths, 'work'), null);
  assert.equal(fs.existsSync(`${laneDir(paths, 'work')}.new`), false);
});

test('renewing a lane signs in in place and keeps its servers and their logins', needsLane, () => {
  ensureLane(paths, 'work');
  const files = lanePaths(paths, 'work');
  const goematic = { serverName: 'goematic', accessToken: 'goematic-token', expiresAt: Date.now() + 3600_000 };
  fs.writeFileSync(files.credentialsFile, JSON.stringify({ ...readJson(files.credentialsFile), mcpOAuth: { 'goematic|1': goematic } }));
  fs.writeFileSync(files.configJson, JSON.stringify({ ...readJson(files.configJson), mcpServers: { goematic: { type: 'http' } } }));
  const before = laneStatus(paths, 'work');
  process.env.FAKE_RENEWED_EXPIRY = String(before.expiresAt + 60_000);

  const result = ensureLane(paths, 'work');

  assert.equal(result.renewed, true);
  assert.equal(result.expiresAt, before.expiresAt + 60_000);
  assert.deepEqual(readJson(files.credentialsFile).mcpOAuth, { 'goematic|1': goematic });
  assert.deepEqual(readJson(files.configJson).mcpServers, { goematic: { type: 'http' } });
});

test('an abandoned lane renewal says so, and the lane still serves its old login', needsLane, () => {
  ensureLane(paths, 'work');
  const before = laneStatus(paths, 'work');
  process.env.FAKE_BROWSER_ACCOUNT = '';

  assert.throws(() => ensureLane(paths, 'work'), /The sign-in for the lane of 'work' did not complete/);
  assert.deepEqual(laneStatus(paths, 'work'), before);
});

test('a lane renewal signed in as another account says the connectors stop', needsLane, () => {
  ensureLane(paths, 'work');
  process.env.FAKE_BROWSER_ACCOUNT = 'personal@example.com';

  assert.throws(
    () => ensureLane(paths, 'work'),
    /The connectors of 'work' stop until its lane is signed in again as work@example\.com: cc-account lane work/,
  );
  assert.equal(laneStatus(paths, 'work').email, 'personal@example.com');
});

test('a lane needs a saved account', needsLane, () => {
  assert.throws(() => ensureLane(paths, 'gone'), /Unknown account 'gone'/);
});

/** Give the lane a claude.ai token and a goematic login, each ending `msLeft` from now. */
function laneTokens(msLeft) {
  const file = lanePaths(paths, 'work').credentialsFile;
  const end = Date.now() + msLeft;
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...readJson(file),
      claudeAiOauth: { ...readJson(file).claudeAiOauth, accessToken: 'old-claude', expiresAt: end },
      mcpOAuth: { 'goematic|1': { accessToken: 'old-goematic', expiresAt: end } },
    }),
  );
}

const renewals = () => (fs.existsSync(process.env.FAKE_RENEW_LOG) ? fs.readFileSync(process.env.FAKE_RENEW_LOG, 'utf8').trim().split('\n') : []);

/** Run `cc-account header` as Claude Code does, in its own process. */
function header(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'header', ...args], { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('a fresh token is handed out at once, with the session id the proxy requires', needsLane, () => {
  ensureLane(paths, 'work');
  laneTokens(2 * 60 * MINUTE_MS);
  process.env.FAKE_RENEW_LOG = path.join(box.root, 'renewals.log');

  const headers = laneHeaders(paths, 'work');

  assert.equal(headers.Authorization, 'Bearer old-claude');
  assert.match(headers['X-Mcp-Client-Session-Id'], /^[0-9a-f-]{36}$/);
  assert.deepEqual(laneHeaders(paths, 'work', 'goematic'), { Authorization: 'Bearer old-goematic' });
  assert.deepEqual(renewals(), []);
});

test('an expired token is renewed before it is handed out', needsLane, () => {
  ensureLane(paths, 'work');
  laneTokens(-MINUTE_MS);
  process.env.FAKE_RENEW_LOG = path.join(box.root, 'renewals.log');

  const headers = laneHeaders(paths, 'work', 'goematic');

  assert.match(headers.Authorization, /^Bearer renewed-/);
  assert.deepEqual(renewals(), ['get goematic']);
  assert.equal(fs.existsSync(path.join(laneDir(paths, 'work'), '.renew.lock')), false);
});

test('a token in its last half hour is handed out at once and renewed in the background', needsLane, async () => {
  ensureLane(paths, 'work');
  laneTokens(10 * MINUTE_MS);
  process.env.FAKE_RENEW_LOG = path.join(box.root, 'renewals.log');

  const headers = laneHeaders(paths, 'work');

  assert.equal(headers.Authorization, 'Bearer old-claude');
  for (let waited = 0; renewals().length === 0 && waited < 15_000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(renewals(), ['list']);
});

test('two sessions asking at once share one renewal', needsLane, async () => {
  ensureLane(paths, 'work');
  laneTokens(-MINUTE_MS);
  process.env.FAKE_RENEW_LOG = path.join(box.root, 'renewals.log');
  process.env.FAKE_RENEW_MS = '1500';

  const [first, second] = await Promise.all([header('work', 'goematic'), header('work', 'goematic')]);

  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(renewals(), ['get goematic']);
  assert.equal(JSON.parse(first.stdout).Authorization, JSON.parse(second.stdout).Authorization);
  assert.match(JSON.parse(first.stdout).Authorization, /^Bearer renewed-/);
});

test('a lane signed in as another account hands out nothing', needsLane, async () => {
  ensureLane(paths, 'work');
  process.env.FAKE_BROWSER_ACCOUNT = 'personal@example.com';
  assert.throws(() => ensureLane(paths, 'work'));

  // Shut from the moment the sign-in began, before its email was known, and still shut after.
  assert.throws(() => laneHeaders(paths, 'work'), /is being signed in again, or a sign-in stopped halfway/);
  const result = await header('work');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');

  // A lane whose login is another account's is refused on its own as well.
  fs.rmSync(path.join(laneDir(paths, 'work'), '.signing-in'));
  assert.throws(() => laneHeaders(paths, 'work'), /The lane of 'work' is signed in as personal@example\.com, not work@example\.com/);
});

test('a sign-in killed midway leaves the lane shut; one that changed nothing leaves it serving', needsLane, () => {
  ensureLane(paths, 'work');
  fs.writeFileSync(path.join(laneDir(paths, 'work'), '.signing-in'), '');
  assert.throws(() => laneHeaders(paths, 'work'), /a sign-in stopped halfway/);

  ensureLane(paths, 'work');
  assert.match(laneHeaders(paths, 'work').Authorization, /^Bearer access-for-work/);

  process.env.FAKE_BROWSER_ACCOUNT = '';
  assert.throws(() => ensureLane(paths, 'work'), /did not complete/);
  assert.match(laneHeaders(paths, 'work').Authorization, /^Bearer /);
});

test('a lane is refused to an account whose name a shell would read as more than a name', needsLane, () => {
  const metaFile = path.join(paths.store, 'work', 'meta.json');
  fs.cpSync(path.join(paths.store, 'work'), path.join(paths.store, 'work&calc'), { recursive: true });
  assert.ok(fs.existsSync(metaFile));

  assert.throws(() => ensureLane(paths, 'work&calc'), /may hold only letters, digits, '\.', '_' and '-'/);
});

test('a lane dir with no login left in it gives way to a first sign-in', needsLane, () => {
  fs.mkdirSync(laneDir(paths, 'work'), { recursive: true });
  fs.writeFileSync(path.join(laneDir(paths, 'work'), 'chrome-tools.json'), '{}');

  assert.equal(ensureLane(paths, 'work').email, 'work@example.com');
});

test('a background renewal is tried once per five minutes, not on every connection', needsLane, async () => {
  ensureLane(paths, 'work');
  laneTokens(10 * MINUTE_MS);
  process.env.FAKE_RENEW_LOG = path.join(box.root, 'renewals.log');
  process.env.FAKE_RENEW_MS = '400';

  laneHeaders(paths, 'work');
  laneTokens(10 * MINUTE_MS);
  laneHeaders(paths, 'work');
  for (let waited = 0; renewals().length === 0 && waited < 15_000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.equal(renewals().length, 1);
});

test('a connector of an account with no lane, or a server with no login, says how to fix it', needsLane, () => {
  assert.throws(() => laneHeaders(paths, 'work'), /'work' has no lane yet\. Sign it in: cc-account lane work/);
  ensureLane(paths, 'work');
  assert.throws(
    () => laneHeaders(paths, 'work', 'goematic'),
    /The lane of 'work' has no login to goematic\. Sign in to it: cc-account attach work goematic/,
  );
});

test('a lane is refused on macOS, where its login would land in the shared Keychain', {
  skip: process.platform !== 'darwin' && 'macOS only',
}, () => {
  assert.throws(() => ensureLane(paths, 'work'), /A lane is not available on macOS/);
});
