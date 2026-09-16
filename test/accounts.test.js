import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  accountsWithExpiry,
  authStatus,
  EXPIRY_WARNING_MS,
  expiringAccounts,
  findByEmail,
  listAccounts,
  loggedInEmail,
  pickRotationTarget,
  renewAccount,
  RESERVED_NAMES,
  saveAccount,
  setBrowser,
  slugify,
  useAccount,
} from '../src/accounts.js';
import { readRotationState } from '../src/rotationState.js';
import {
  expiringIn,
  login,
  logout,
  readFile,
  readJson,
  recordArgs,
  sandbox,
} from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const posix = process.platform !== 'win32';

/**
 * On macOS the credential backend is the login Keychain, not a file under the
 * config dir, so the sandbox cannot stand in for it - `readCredentials` would
 * miss and `writeCredentials` would touch the real Keychain. Everything that
 * moves a token is skipped there; what remains covers the index and the guards.
 */
const needsFileBackend = {
  skip:
    process.platform === 'darwin' &&
    'the credential backend is the Keychain on macOS; the sandbox cannot replace it',
};

/** `renew` refuses macOS before it reads anything, so its own guards are unreachable there. */
const needsRenew = {
  skip: process.platform === 'darwin' && 'renew is refused outright on macOS',
};

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

test('save writes the three snapshot files and indexes the account', needsFileBackend, () => {
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

test('the credential blob is copied verbatim, never parsed', needsFileBackend, () => {
  const blob = '{"unknownFutureField":1,\n  "email":"work@example.com"}';
  fs.writeFileSync(paths.credentialsFile, blob);
  fs.writeFileSync(paths.configJson, JSON.stringify({ oauthAccount: { emailAddress: 'x' } }));

  saveAccount(paths, 'work');

  assert.equal(readFile(path.join(snapshotDir('work'), '.credentials.json')), blob);
});

test('save defaults the name to the email local part', needsFileBackend, () => {
  login(paths, 'work@example.com');

  assert.equal(saveAccount(paths).name, 'work');
});

test('save refuses a name the slash command would swallow', needsFileBackend, () => {
  login(paths, 'work@example.com');

  for (const reserved of RESERVED_NAMES) {
    assert.throws(
      () => saveAccount(paths, reserved),
      new RegExp(`'${reserved}' is a /cc-account subcommand`),
    );
    assert.equal(fs.existsSync(snapshotDir(reserved)), false);
  }
});

test('a reserved name is refused even when it comes from the email', needsFileBackend, () => {
  login(paths, 'rotate@example.com');

  assert.throws(() => saveAccount(paths), /cannot name an account/);
});

test('save refuses when logged out', () => {
  assert.throws(() => saveAccount(paths, 'work'), /Not logged in/);
});

test('findByEmail resolves a snapshot, and returns null for a stranger', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');

  assert.equal(findByEmail(paths, 'work@example.com'), 'work');
  assert.equal(findByEmail(paths, 'nobody@example.com'), null);
  assert.equal(findByEmail(paths, undefined), null);
});

test('rotate picks the account switched away from longest ago', needsFileBackend, () => {
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

test('rotate refuses with nothing saved, and with only the active account saved', needsFileBackend, () => {
  assert.throws(() => pickRotationTarget(paths), /No accounts saved/);

  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  assert.throws(() => pickRotationTarget(paths), /nothing to rotate to/);
});

test('an unknown account names the ones that exist', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');

  assert.throws(() => useAccount(paths, 'typo'), /Unknown account 'typo'\. Known: work/);
});

test('an unknown account on an empty store says so', () => {
  assert.throws(() => useAccount(paths, 'work'), /No accounts saved yet/);
});

test('switching to the account already active writes nothing', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  const before = readFile(paths.credentialsFile);

  const result = useAccount(paths, 'work');

  assert.deepEqual(result, { alreadyActive: true, email: 'work@example.com' });
  assert.equal(readFile(paths.credentialsFile), before);
  assert.deepEqual(readRotationState(paths), {});
});

test('use swaps tokens and identity, and re-snapshots the outgoing account', needsFileBackend, () => {
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

test('the outgoing snapshot is refreshed, not left on a retired token', needsFileBackend, () => {
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

test('an outgoing account with no snapshot gets one instead of costing a login', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com'); // never saved

  const result = useAccount(paths, 'work');

  assert.equal(result.restashed, 'personal');
  assert.equal(readJson(path.join(snapshotDir('personal'), 'meta.json')).email, 'personal@example.com');
});

test('only the oauthAccount key of .claude.json is replaced', needsFileBackend, () => {
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

test('--creds-only swaps the token and leaves identity alone', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');

  useAccount(paths, 'work', { credsOnly: true });

  assert.equal(readJson(paths.credentialsFile).email, 'work@example.com');
  assert.equal(readJson(paths.configJson).oauthAccount.emailAddress, 'personal@example.com');
});

test('the regenerable auth caches are dropped, so nothing reports the old account', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');
  for (const cache of paths.authCaches) fs.writeFileSync(cache, 'stale');

  useAccount(paths, 'work');

  for (const cache of paths.authCaches) assert.equal(fs.existsSync(cache), false);
});

test('a missing auth cache is not an error', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');

  assert.doesNotThrow(() => useAccount(paths, 'work'));
});

test('the switch publishes which account is live', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');

  useAccount(paths, 'work');

  const state = readRotationState(paths);
  assert.equal(state.active, 'work');
  assert.equal(state.email, 'work@example.com');
});

test('a switch away from a logged-out state needs no re-snapshot', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  logout(paths);

  const result = useAccount(paths, 'work');

  assert.equal(result.restashed, null);
  assert.equal(result.status.email, 'work@example.com');
});

test('save refuses to overwrite a snapshot that holds another account', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  const workBlob = readFile(path.join(snapshotDir('work'), '.credentials.json'));
  login(paths, 'personal@example.com');

  assert.throws(
    () => saveAccount(paths, 'work'),
    /'work' holds work@example\.com, but personal@example\.com is logged in\. Nothing was changed\. Save personal@example\.com under another name first: cc-account save <another-name>/,
  );
  assert.equal(readFile(path.join(snapshotDir('work'), '.credentials.json')), workBlob);
});

test('two emails sharing a local part stop the switch instead of overwriting', needsFileBackend, () => {
  login(paths, 'me@one.example');
  saveAccount(paths); // saved as 'me'
  login(paths, 'me@two.example'); // never saved; its default name is also 'me'

  assert.throws(() => useAccount(paths, 'me'), /'me' holds me@one\.example/);
  assert.equal(readJson(path.join(snapshotDir('me'), 'meta.json')).email, 'me@one.example');
});

test('the browser setting survives a re-save', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  setBrowser(paths, 'work', ['chrome', '--profile-directory=Profile 2']);

  saveAccount(paths, 'work');

  assert.deepEqual(readJson(path.join(snapshotDir('work'), 'meta.json')).browser, [
    'chrome',
    '--profile-directory=Profile 2',
  ]);
  setBrowser(paths, 'work', null);
  assert.equal('browser' in readJson(path.join(snapshotDir('work'), 'meta.json')), false);
});

test('expiry comes from each snapshot, and from the live login for the active account', needsFileBackend, () => {
  login(paths, 'work@example.com', expiringIn(10 * DAY_MS));
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com', expiringIn(2 * DAY_MS));
  saveAccount(paths, 'personal');
  // A manual /login renews the live account without touching its snapshot.
  const renewed = expiringIn(30 * DAY_MS);
  login(paths, 'personal@example.com', renewed);

  const byName = Object.fromEntries(
    accountsWithExpiry(paths, 'personal@example.com').map((account) => [account.name, account]),
  );

  assert.equal(byName.personal.active, true);
  assert.equal(byName.personal.expiresAt, renewed.claudeAiOauth.refreshTokenExpiresAt);
  assert.equal(byName.work.active, false);
  assert.ok(Math.abs(byName.work.expiresAt - (Date.now() + 10 * DAY_MS)) < 60_000);
});

test('only logins inside the warning window are expiring, expired ones included', needsFileBackend, () => {
  login(paths, 'soon@example.com', expiringIn(EXPIRY_WARNING_MS - DAY_MS));
  saveAccount(paths, 'soon');
  login(paths, 'gone@example.com', expiringIn(-DAY_MS));
  saveAccount(paths, 'gone');
  login(paths, 'fine@example.com', expiringIn(EXPIRY_WARNING_MS + DAY_MS));
  saveAccount(paths, 'fine');
  login(paths, 'unknown@example.com'); // a blob that carries no expiry
  saveAccount(paths, 'unknown');

  const names = expiringAccounts(paths, null).map((account) => account.name).sort();

  assert.deepEqual(names, ['gone', 'soon']);
});

test('renew replaces the snapshot login and leaves the live account alone', needsFileBackend, () => {
  login(paths, 'work@example.com', expiringIn(DAY_MS));
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');
  const liveBefore = readFile(paths.credentialsFile);

  const result = renewAccount(paths, 'work');

  const snapshot = readJson(path.join(snapshotDir('work'), '.credentials.json'));
  assert.equal(snapshot.refreshToken, 'renewed-for-work@example.com');
  assert.equal(result.expiresAt, snapshot.claudeAiOauth.refreshTokenExpiresAt);
  assert.ok(result.expiresAt > Date.now() + 20 * DAY_MS);
  assert.equal(result.active, false);
  assert.equal(result.status.email, 'work@example.com');
  assert.equal(readFile(paths.credentialsFile), liveBefore);
  assert.deepEqual(fs.readdirSync(box.tmp), [], 'the throwaway login dir is removed');
});

test('renewing the live account makes the new login live too', needsFileBackend, () => {
  login(paths, 'work@example.com', expiringIn(DAY_MS));
  saveAccount(paths, 'work');

  const result = renewAccount(paths, 'work');

  assert.equal(result.active, true);
  assert.equal(readJson(paths.credentialsFile).refreshToken, 'renewed-for-work@example.com');
  assert.equal(
    readFile(paths.credentialsFile),
    readFile(path.join(snapshotDir('work'), '.credentials.json')),
  );
});

test('renew keeps nothing when the browser signs in another account', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  const before = readFile(path.join(snapshotDir('work'), '.credentials.json'));
  process.env.FAKE_BROWSER_ACCOUNT = 'personal@example.com';

  assert.throws(
    () => renewAccount(paths, 'work'),
    /The browser signed in personal@example\.com, not work@example\.com\. Nothing was changed\./,
  );
  assert.equal(readFile(path.join(snapshotDir('work'), '.credentials.json')), before);
  assert.equal(findByEmail(paths, 'personal@example.com'), null);
  assert.deepEqual(fs.readdirSync(box.tmp), []);
});

test('an abandoned renew changes nothing', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  const before = readFile(path.join(snapshotDir('work'), '.credentials.json'));
  process.env.FAKE_BROWSER_ACCOUNT = '';

  assert.throws(() => renewAccount(paths, 'work'), /did not complete\. Nothing was changed\./);
  assert.equal(readFile(path.join(snapshotDir('work'), '.credentials.json')), before);
  assert.deepEqual(fs.readdirSync(box.tmp), []);
});

test('renew opens the sign-in page with the account\'s own browser, hinting its email', needsFileBackend, async () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  const out = path.join(box.root, 'opened.json');
  setBrowser(paths, 'work', [process.execPath, recordArgs, out, '--profile-directory=Profile 2']);

  let announced;
  renewAccount(paths, 'work', { onLogin: (command, email) => (announced = { command, email }) });

  assert.equal(announced.email, 'work@example.com');
  assert.equal(announced.command[0], process.execPath);
  // The browser is started detached, so it may land after renew returns.
  for (let waited = 0; !fs.existsSync(out) && waited < 10_000; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const [flag, url] = readJson(out);
  assert.equal(flag, '--profile-directory=Profile 2');
  // Whole, `&` included: a shell along the way would have cut it there.
  assert.match(url, /\?code=true&login_hint=work%40example\.com$/);
});

test('renew keeps the time the account was last switched away from, which rotate orders by', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  backdate('work', '2026-01-01T00:00:00.000Z');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');

  renewAccount(paths, 'work');

  assert.equal(readJson(path.join(snapshotDir('work'), 'meta.json')).savedAt, '2026-01-01T00:00:00.000Z');
});

test('renew clears login dirs a killed renew left behind, and only stale ones', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  const stale = fs.mkdtempSync(paths.loginScratch);
  fs.writeFileSync(path.join(stale, '.credentials.json'), 'leftover token');
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);
  const inProgress = fs.mkdtempSync(paths.loginScratch);

  renewAccount(paths, 'work');

  assert.deepEqual(fs.readdirSync(box.tmp), [path.basename(inProgress)]);
});

test('renew refuses an email the Windows shell would rewrite', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  const metaFile = path.join(snapshotDir('work'), 'meta.json');
  fs.writeFileSync(metaFile, JSON.stringify({ ...readJson(metaFile), email: '%USERNAME%@example.com' }));

  assert.throws(() => renewAccount(paths, 'work'), /Cannot pass %USERNAME%@example\.com to claude/);
});

test('a .claude.json that cannot be read stops a switch before anything is written', needsFileBackend, () => {
  login(paths, 'work@example.com');
  saveAccount(paths, 'work');
  login(paths, 'personal@example.com');
  saveAccount(paths, 'personal');
  fs.writeFileSync(paths.configJson, '{ "userID": "user-123", torn');
  const liveBefore = readFile(paths.credentialsFile);

  assert.throws(() => useAccount(paths, 'work'), SyntaxError);
  assert.equal(readFile(paths.credentialsFile), liveBefore);
  assert.equal(readFile(paths.configJson), '{ "userID": "user-123", torn');
});

test('a logged-out status names nobody, even if it carries an email', () => {
  assert.equal(loggedInEmail({ loggedIn: false, email: 'stale@example.com' }), null);
  assert.equal(loggedInEmail({ loggedIn: true, email: 'work@example.com' }), 'work@example.com');
  assert.equal(loggedInEmail(null), null);
});

test('renew refuses an unknown account', needsRenew, () => {
  assert.throws(() => renewAccount(paths, 'work'), /Unknown account 'work'/);
});

test('renew is refused on macOS, where the login would reach the shared Keychain', {
  skip: process.platform !== 'darwin' && 'only macOS uses the Keychain',
}, () => {
  assert.throws(() => renewAccount(paths, 'work'), /not available on macOS/);
});

test(
  'snapshots and the files inside them carry the documented modes',
  { skip: !posix || needsFileBackend.skip },
  () => {
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
  },
);
