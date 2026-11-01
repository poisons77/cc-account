import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { saveAccount } from '../src/accounts.js';
import { applySetting, describeSettings, splitCommand } from '../src/settings.js';
import { login, readFile, readJson, sandbox } from './helpers.js';

/** Saving an account moves a token, which the sandbox cannot stand in for on macOS. */
const needsFileBackend = {
  skip:
    process.platform === 'darwin' &&
    'the credential backend is the Keychain on macOS; the sandbox cannot replace it',
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

const saveAll = (...names) => {
  for (const name of names) {
    login(paths, `${name}@example.com`);
    saveAccount(paths, name);
  }
};

const writePace = (config) => {
  fs.mkdirSync(path.dirname(paths.paceConfig), { recursive: true });
  fs.writeFileSync(paths.paceConfig, JSON.stringify(config));
};

const rotation = () => readJson(paths.paceConfig).rotation;
const value = (key) => describeSettings(paths).find((setting) => setting.key === key)?.value;
const keys = () => describeSettings(paths).map((setting) => setting.key);

test('with no cc-pace config, rotation reads as off and only the switch is offered', () => {
  assert.deepEqual(keys(), ['mode', 'sessionNotices']);
  assert.equal(value('mode'), 'off');
});

test('session notices are on until turned off, and live in cc-account\'s own settings file', () => {
  assert.equal(value('sessionNotices'), 'on');

  applySetting(paths, 'sessionNotices', 'off');

  assert.equal(value('sessionNotices'), 'off');
  assert.deepEqual(readJson(paths.settings), { sessionNotices: false });
  assert.equal(fs.existsSync(paths.paceConfig), false);
});

test('turning rotation on between peers lists every saved account', needsFileBackend, () => {
  saveAll('work', 'personal');

  applySetting(paths, 'mode', 'peers');

  assert.deepEqual(rotation().accounts, ['personal', 'work']);
  assert.equal(value('mode'), 'peers');
  assert.ok(keys().includes('account.work'));
});

test('rotation is refused with fewer than two saved accounts', needsFileBackend, () => {
  saveAll('work');

  assert.throws(() => applySetting(paths, 'mode', 'peers'), /at least two saved accounts/);
  assert.equal(fs.existsSync(paths.paceConfig), false);
});

test('turning rotation off keeps every other choice, so turning it back on restores them', needsFileBackend, () => {
  saveAll('work', 'personal');
  writePace({ rotation: { accounts: ['work', 'personal'], buckets: { five_hour: 90 } } });

  applySetting(paths, 'mode', 'off');
  assert.equal(rotation().enabled, false);
  assert.deepEqual(rotation().buckets, { five_hour: 90 });

  applySetting(paths, 'mode', 'peers');
  assert.equal('enabled' in rotation(), false);
  assert.deepEqual(rotation().accounts, ['work', 'personal']);
});

test('primary-and-fallback drops the peer list, which cc-pace would otherwise read first', needsFileBackend, () => {
  saveAll('work', 'personal');
  writePace({ rotation: { accounts: ['work', 'personal'] } });

  applySetting(paths, 'mode', 'primary-fallback');

  assert.equal('accounts' in rotation(), false);
  assert.equal(rotation().primary, 'personal');
  assert.equal(rotation().fallback, 'work');
  applySetting(paths, 'primary', 'work');
  assert.equal(rotation().primary, 'work');
});

test('an account leaves and rejoins the peer list without reordering the rest', needsFileBackend, () => {
  saveAll('work', 'personal', 'third');
  writePace({ rotation: { accounts: ['third', 'work', 'personal'] } });

  applySetting(paths, 'account.work', 'off');
  assert.deepEqual(rotation().accounts, ['third', 'personal']);

  assert.throws(() => applySetting(paths, 'account.third', 'off'), /at least two accounts/);

  applySetting(paths, 'account.work', 'on');
  assert.deepEqual(rotation().accounts, ['third', 'personal', 'work']);
});

test('thresholds read from any shape cc-pace accepts and write back as one object', needsFileBackend, () => {
  saveAll('work', 'personal');
  writePace({ rotation: { accounts: ['work', 'personal'], buckets: ['five_hour', 'seven_day'], at: 90 } });

  assert.equal(value('five_hour'), '90');
  assert.equal(value('seven_day'), '90');

  applySetting(paths, 'five_hour', '95');

  assert.deepEqual(rotation().buckets, { five_hour: 95, seven_day: 90 });
  assert.equal('at' in rotation(), false);
});

test('the later weekly bar is set and cleared together with its window', needsFileBackend, () => {
  saveAll('work', 'personal');
  writePace({ rotation: { accounts: ['work', 'personal'], buckets: { seven_day: 95 } } });

  applySetting(paths, 'seven_day.lateAt', '99');
  assert.deepEqual(rotation().buckets.seven_day, { at: 95, lateAt: 99, lateWithinSecs: 129600 });

  applySetting(paths, 'seven_day.lateWithinSecs', '86400');
  assert.equal(rotation().buckets.seven_day.lateWithinSecs, 86400);

  applySetting(paths, 'seven_day.lateAt', 'off');
  assert.equal(rotation().buckets.seven_day, 95);
});

test('the last watched window cannot be switched off', needsFileBackend, () => {
  saveAll('work', 'personal');
  writePace({ rotation: { accounts: ['work', 'personal'], buckets: { five_hour: 95 } } });

  assert.throws(() => applySetting(paths, 'five_hour', 'off'), /At least one window/);
});

test('a value outside the choices, or an unknown key, changes nothing', needsFileBackend, () => {
  saveAll('work', 'personal');
  writePace({ rotation: { accounts: ['work', 'personal'] } });
  const before = readFile(paths.paceConfig);

  assert.throws(() => applySetting(paths, 'five_hour', '77'), /not a choice for five_hour/);
  assert.throws(() => applySetting(paths, 'nonsense', '1'), /Unknown setting/);
  assert.equal(readFile(paths.paceConfig), before);
});

test('the rest of the cc-pace config survives every change', needsFileBackend, () => {
  saveAll('work', 'personal');
  writePace({ segments: ['limits'], rotation: { accounts: ['work', 'personal'], command: 'cc-account' } });

  applySetting(paths, 'switchAheadSecs', '600');
  applySetting(paths, 'ascii', 'on');

  const config = readJson(paths.paceConfig);
  assert.deepEqual(config.segments, ['limits']);
  assert.equal(config.rotation.command, 'cc-account');
  assert.equal(config.rotation.switchAheadSecs, 600);
  assert.equal(config.rotation.ascii, true);

  applySetting(paths, 'switchAheadSecs', 'off');
  assert.equal('switchAheadSecs' in rotation(), false);
});

test('a cc-pace config that cannot be read is reported, never written over', () => {
  fs.mkdirSync(path.dirname(paths.paceConfig), { recursive: true });
  fs.writeFileSync(paths.paceConfig, '{ "rotation": torn');

  assert.throws(() => describeSettings(paths));
  assert.equal(readFile(paths.paceConfig), '{ "rotation": torn');
});

test('the sign-in browser is free text, and empty returns to a private window', needsFileBackend, () => {
  saveAll('work');

  applySetting(paths, 'browser.work', '"C:/Program Files/chrome.exe" --profile-directory="Profile 2"');
  assert.deepEqual(readJson(path.join(paths.store, 'work', 'meta.json')).browser, [
    'C:/Program Files/chrome.exe',
    '--profile-directory=Profile 2',
  ]);
  // Shown back in a form that sets the same command again.
  assert.equal(value('browser.work'), '"C:/Program Files/chrome.exe" "--profile-directory=Profile 2"');

  applySetting(paths, 'browser.work', '');
  assert.equal(value('browser.work'), '');
});

test('splitCommand keeps quoted spaces and refuses an unclosed quote', () => {
  assert.deepEqual(splitCommand('  firefox   -P  "my profile" '), ['firefox', '-P', 'my profile']);
  assert.deepEqual(splitCommand('a ""'), ['a', '']);
  assert.throws(() => splitCommand('chrome "open'), /Unclosed quote/);
});
