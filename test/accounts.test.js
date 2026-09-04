import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  authStatus,
  findByEmail,
  listAccounts,
  pickRotationTarget,
  saveAccount,
  slugify,
  useAccount,
} from '../src/accounts.js';
import { readRotationState } from '../src/rotationState.js';
import { login, logout, readFile, readJson, sandbox } from './helpers.js';

const posix = process.platform !== 'win32';
let box;
let paths;

beforeEach(() => {
  box = sandbox();
  paths = box.paths;
});

afterEach(() => {
  box.restore();
});

const snapshotDir = (name) => path.join(paths.store, name);
const backdate = (name, iso) => {
  const file = path.join(snapshotDir(name), 'meta.json');
  fs.writeFileSync(file, JSON.stringify({ ...readJson(file), savedAt: iso }, null, 2));
};

test('authStatus reaches the CLI even when it is a .cmd shim', () => {
  login(paths, 'work@example.com');

  assert.deepEqual(authStatus(), {
    loggedIn: true,
    email: 'work@example.com',
    authMethod: 'claudeai',
    apiProvider: 'anthropic',
    subscriptionType: 'max',
    orgName: null,
  });
});

test('authStatus reports logged out rather than throwing', () => {
  assert.deepEqual(authStatus(), { loggedIn: false });
});

test('slugify takes the email local part and drops what a directory cannot hold', () => {
  assert.equal(slugify('me@example.com'), 'me');
  assert.equal(slugify('first.last+tag@example.com'), 'first.last-tag');
  assert.equal(slugify('a/b@example.com'), 'a-b');
});

test('listAccounts is empty when the store does not exist yet', () => {
  assert.deepEqual(listAccounts(paths), []);
});

test('save writes the three snapshot files and indexes the account', () => {
  login(paths, 'work@example.com');

  const { name } = saveAccount(paths, 'work');

  assert.equal(name, 'work');
  assert.deepEqual(fs.readdirSync(snapshotDir('work')).sort(), [
    '.credentials.json',
    'meta.json',
    'oauthAccount.json',
  ]);

  const meta = readJson(path.join(snapshotDir('work'), 'meta.json'));
  assert.equal(meta.email, 'work@example.com');
  assert.equal(meta.subscriptionType, 'max');
  assert.equal(meta.authMethod, 'claudeai');
  assert.ok(Date.parse(meta.savedAt));
});

test('the credential blob is copied verbatim, never parsed', () => {
  const blob = '{"unknownFutureField":1,\n  "email":"work@example.com"}';
  fs.writeFileSync(paths.credentialsFile, blob);
  fs.writeFileSync(paths.configJson, JSON.stringify({ oauthAccount: { emailAddress: 'x' } }));

  saveAccount(paths, 'work');

  assert.equal(readFile(path.join(snapshotDir('work'), '.credentials.json')), blob);
});

test('save defaults the name to the email local part', () => {
  login(paths, 'work@example.com');

  assert.equal(saveAccount(paths).name, 'work');
});

test('save refuses when logged out', () => {
  assert.throws(() => saveAccount(paths, 'work'), /Not logged in/);
});

test('findByEmail resolves a snapshot, and returns null for a stranger', () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');

  assert.equal(findByEmail(paths, 'work@example.com'), 'work');
  assert.equal(findByEmail(paths, 'nobody@example.com'), null);
  assert.equal(findByEmail(paths, undefined), null);
});

test('rotate picks the account switched away from longest ago', () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');
  login(paths, 'third@example.com');
  saveAccount(paths, 'third');

  backdate('work', '2026-01-01T00:00:00.000Z');
  backdate('personal', '2026-06-01T00:00:00.000Z');

  // third is active, so the oldest of the other two wins.
  assert.equal(pickRotationTarget(paths), 'work');
});

test('rotate refuses with nothing saved, and with only the active account saved', () => {
  assert.throws(() => pickRotationTarget(paths), /No accounts saved/);

  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  assert.throws(() => pickRotationTarget(paths), /nothing to rotate to/);
});

test('an unknown account names the ones that exist', () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');

  assert.throws(() => useAccount(paths, 'typo'), /Unknown account 'typo'\. Known: work/);
});

test('an unknown account on an empty store says so', () => {
  assert.throws(() => useAccount(paths, 'work'), /No accounts saved yet/);
});

test('switching to the account already active writes nothing', () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  const before = readFile(paths.credentialsFile);

  const result = useAccount(paths, 'work');

  assert.deepEqual(result, { alreadyActive: true, email: 'work@example.com' });
  assert.equal(readFile(paths.credentialsFile), before);
  assert.deepEqual(readRotationState(paths), {});
});

test('use swaps tokens and identity, and re-snapshots the outgoing account', () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');

  const workBlob = readFile(path.join(snapshotDir('work'), '.credentials.json'));

  const result = useAccount(paths, 'work');

  assert.equal(result.alreadyActive, false);
  assert.equal(result.restashed, 'personal');
  assert.equal(result.status.email, 'work@example.com');
  assert.equal(readFile(paths.credentialsFile), workBlob);
  assert.equal(readJson(paths.configJson).oauthAccount.emailAddress, 'work@example.com');
});

test('the outgoing snapshot is refreshed, not left on a retired token', () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');

  // The live session refreshed its token since the snapshot was taken.
  login(paths, 'personal@example.com', { refreshToken: 'rotated-token' });

  useAccount(paths, 'work');

  const stashed = readJson(path.join(snapshotDir('personal'), '.credentials.json'));
  assert.equal(stashed.refreshToken, 'rotated-token');
});

test('an outgoing account with no snapshot gets one instead of costing a login', () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com'); // never saved

  const result = useAccount(paths, 'work');

  assert.equal(result.restashed, 'personal');
  assert.equal(readJson(path.join(snapshotDir('personal'), 'meta.json')).email, 'personal@example.com');
});

test('only the oauthAccount key of .claude.json is replaced', () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');

  const config = readJson(paths.configJson);
  config.userID = 'user-123';
  config.mcpServers = { github: { token: 'keep-me' } };
  config.projects = { '/tmp/thing': { history: ['one'] } };
  fs.writeFileSync(paths.configJson, JSON.stringify(config, null, 2));

  useAccount(paths, 'work');

  const after = readJson(paths.configJson);
  assert.equal(after.userID, 'user-123');
  assert.deepEqual(after.mcpServers, { github: { token: 'keep-me' } });
  assert.deepEqual(after.projects, { '/tmp/thing': { history: ['one'] } });
  assert.equal(after.oauthAccount.emailAddress, 'work@example.com');
});

test('--creds-only swaps the token and leaves identity alone', () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');

  useAccount(paths, 'work', { credsOnly: true });

  assert.equal(readJson(paths.credentialsFile).email, 'work@example.com');
  assert.equal(readJson(paths.configJson).oauthAccount.emailAddress, 'personal@example.com');
});

test('the regenerable auth caches are dropped, so nothing reports the old account', () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');
  for (const cache of paths.authCaches) fs.writeFileSync(cache, 'stale');

  useAccount(paths, 'work');

  for (const cache of paths.authCaches) assert.equal(fs.existsSync(cache), false);
});

test('a missing auth cache is not an error', () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');

  assert.doesNotThrow(() => useAccount(paths, 'work'));
});

test('the switch publishes which account is live', () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');

  useAccount(paths, 'work');

  const state = readRotationState(paths);
  assert.equal(state.active, 'work');
  assert.equal(state.email, 'work@example.com');
});

test('a switch away from a logged-out state needs no re-snapshot', () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  logout(paths);

  const result = useAccount(paths, 'work');

  assert.equal(result.restashed, null);
  assert.equal(result.status.email, 'work@example.com');
});

test('snapshots and the files inside them carry the documented modes', { skip: !posix }, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');
  useAccount(paths, 'work');

  const mode = (file) => fs.statSync(file).mode & 0o777;
  assert.equal(mode(snapshotDir('work')), 0o700);
  assert.equal(mode(path.join(snapshotDir('work'), '.credentials.json')), 0o600);
  assert.equal(mode(path.join(snapshotDir('work'), 'oauthAccount.json')), 0o600);
  assert.equal(mode(paths.credentialsFile), 0o600);
});
