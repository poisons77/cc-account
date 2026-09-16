import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';

import { saveAccount } from '../src/accounts.js';
import { expiringIn, login, sandbox } from './helpers.js';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cc-account.js');
const DAY_MS = 24 * 60 * 60 * 1000;

// Snapshots are written through the credential backend, which on macOS is the Keychain.
const needsFileBackend = {
  skip:
    process.platform === 'darwin' &&
    'the credential backend is the Keychain on macOS; the sandbox cannot replace it',
};

let box;

beforeEach(() => {
  box = sandbox();
});

afterEach(() => {
  box.restore();
});

// Piped, not a terminal: the CLI must warn without prompting.
const run = (...args) => execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

test('check --hook is silent while no login is close to expiry', needsFileBackend, () => {
  login(box.paths, 'work@example.com', expiringIn(20 * DAY_MS));
  saveAccount(box.paths, 'work');

  assert.equal(run('check', '--hook'), '');
});

test('check --hook tells the user, and tells Claude how to renew', needsFileBackend, () => {
  login(box.paths, 'work@example.com', expiringIn(20 * DAY_MS));
  saveAccount(box.paths, 'work');
  login(box.paths, 'personal@example.com', expiringIn(2 * DAY_MS - 60_000));
  saveAccount(box.paths, 'personal');

  const output = JSON.parse(run('check', '--hook'));

  assert.equal(
    output.systemMessage,
    "cc-account: 'personal' login expires in 2d. Renew: cc-account renew personal",
  );
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /expire soon: personal\./);
  assert.match(output.hookSpecificOutput.additionalContext, /renew <name>` with a 10-minute timeout/);
});

test('list shows each expiry and warns without prompting when piped', needsFileBackend, () => {
  login(box.paths, 'work@example.com', expiringIn(12 * DAY_MS - 60_000));
  saveAccount(box.paths, 'work');
  login(box.paths, 'personal@example.com', expiringIn(-DAY_MS));
  saveAccount(box.paths, 'personal');

  // Directory order is the filesystem's, so compare the lines as a set.
  const lines = run('list').trimEnd().split(/\r?\n/).sort();

  assert.deepEqual(lines, [
    "! 'personal' login expired. Renew: cc-account renew personal",
    '  work      work@example.com  [max]  login expires in 12d',
    '* personal  personal@example.com  [max]  login expired',
  ].sort());
});
