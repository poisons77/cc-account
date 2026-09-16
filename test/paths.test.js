import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { confinedTo, resolvePaths } from '../src/paths.js';

const home = path.join(path.sep, 'home', 'someone');

test('without an override, .claude.json sits at the home root', () => {
  const paths = resolvePaths({}, home);

  assert.equal(paths.configDir, path.join(home, '.claude'));
  assert.equal(paths.configJson, path.join(home, '.claude.json'));
  assert.equal(paths.credentialsFile, path.join(home, '.claude', '.credentials.json'));
  assert.equal(paths.store, path.join(home, '.claude-accounts'));
});

test('CLAUDE_CONFIG_DIR moves both files, identity included', () => {
  // Resolved, so on Windows it gains the current drive letter.
  const dir = path.resolve(path.join(path.sep, 'elsewhere', 'cfg'));
  const paths = resolvePaths({ CLAUDE_CONFIG_DIR: dir }, home);

  assert.equal(paths.configDir, dir);
  assert.equal(paths.configJson, path.join(dir, '.claude.json'));
  assert.equal(paths.credentialsFile, path.join(dir, '.credentials.json'));
});

test('a relative CLAUDE_CONFIG_DIR is resolved to an absolute path', () => {
  const paths = resolvePaths({ CLAUDE_CONFIG_DIR: 'cfg' }, home);

  assert.equal(paths.configDir, path.resolve('cfg'));
});

test('CC_ACCOUNT_HOME relocates the store and nothing else', () => {
  const store = path.join(path.sep, 'mnt', 'snapshots');
  const paths = resolvePaths({ CC_ACCOUNT_HOME: store }, home);

  assert.equal(paths.store, store);
  assert.equal(paths.configDir, path.join(home, '.claude'));
});

test('the auth caches live beside the config, and are the regenerable pair', () => {
  const paths = resolvePaths({}, home);

  assert.deepEqual(paths.authCaches, [
    path.join(home, '.claude', 'daemon-auth-status.json'),
    path.join(home, '.claude', 'daemon-auth-cooldown'),
  ]);
});

test('resolvePaths is pure: same inputs, equal output, no ambient reads', () => {
  assert.deepEqual(resolvePaths({}, home), resolvePaths({}, home));
});

test('the renew login dir is made under the temp dir, never inside the store', () => {
  const tmp = path.join(path.sep, 'tmp');
  const paths = resolvePaths({}, home, tmp);

  assert.equal(paths.loginScratch, path.join(tmp, 'cc-account-login-'));
});

test('on Windows the private-window browsers come from the install dirs, Chrome first', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
  };
  const browsers = resolvePaths(env, home, '/tmp', 'win32').privateBrowsers;

  assert.deepEqual(browsers[0], [path.join('C:\\Program Files', 'Google/Chrome/Application/chrome.exe'), '--incognito']);
  assert.ok(browsers.some(([exe, flag]) => exe.endsWith('msedge.exe') && flag === '--inprivate'));
  assert.ok(browsers.some(([exe, flag]) => exe.endsWith('firefox.exe') && flag === '--private-window'));
});

test('an unset install dir contributes no browser candidates', () => {
  const browsers = resolvePaths({}, home, '/tmp', 'win32').privateBrowsers;

  assert.deepEqual(browsers, []);
});

test('on Linux the private-window browsers are looked up on PATH', () => {
  const env = { PATH: ['/usr/bin', '/snap/bin'].join(path.delimiter) };
  const browsers = resolvePaths(env, home, '/tmp', 'linux').privateBrowsers;

  assert.deepEqual(browsers[0], [path.join('/usr/bin', 'google-chrome'), '--incognito']);
  assert.ok(browsers.some(([exe, flag]) => exe === path.join('/snap/bin', 'firefox') && flag === '--private-window'));
});

test('macOS has no private-window browsers, as renew is not available there', () => {
  assert.deepEqual(resolvePaths({ PATH: '/usr/bin' }, home, '/tmp', 'darwin').privateBrowsers, []);
});

test('confinedTo points the config at the dir and keeps the rest of the environment', () => {
  const dir = path.resolve(path.join(path.sep, 'scratch', 'login'));
  const { env, paths } = confinedTo(dir, { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/live' });

  assert.equal(env.CLAUDE_CONFIG_DIR, dir);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(paths.credentialsFile, path.join(dir, '.credentials.json'));
  assert.equal(paths.configJson, path.join(dir, '.claude.json'));
});
