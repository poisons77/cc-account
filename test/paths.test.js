import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { resolvePaths } from '../src/paths.js';

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
