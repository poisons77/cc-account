import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';

import { saveAccount } from '../src/accounts.js';
import { statePath } from '../src/rotationState.js';
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
  assert.match(output.hookSpecificOutput.additionalContext, /with the AskUserQuestion tool/);
  assert.match(output.hookSpecificOutput.additionalContext, /renew <name>` with a 10-minute timeout/);
});

test('status shows what cc-pace last saved of each account, and whether rotation would use it', needsFileBackend, () => {
  login(box.paths, 'work@example.com', expiringIn(20 * DAY_MS));
  saveAccount(box.paths, 'work');
  login(box.paths, 'personal@example.com', expiringIn(20 * DAY_MS));
  saveAccount(box.paths, 'personal');
  login(box.paths, 'spare@example.com', expiringIn(20 * DAY_MS));
  saveAccount(box.paths, 'spare');
  fs.writeFileSync(statePath(box.paths), JSON.stringify({ active: 'work' }));

  const now = Math.floor(Date.now() / 1000);
  const FUTURE = 4102444800; // Fri 1 Jan 2100 00:00 UTC
  const PAST = 1700000000; // Tue 14 Nov 2023 22:13 UTC
  fs.mkdirSync(path.dirname(box.paths.paceState), { recursive: true });
  fs.writeFileSync(
    box.paths.paceState,
    JSON.stringify({
      seen: {
        work: { at: now - 3 * 3600, buckets: { five_hour: { used: 40.4, resets: PAST }, seven_day: { used: 97, resets: FUTURE } } },
        personal: { at: now - 2 * 86400, buckets: { seven_day: { used: 95, resets: PAST } } },
      },
      ranking: {
        at: now,
        accounts: [
          { name: 'personal', eligible: true, reason: null },
          { name: 'work', eligible: false, reason: 'spent' },
        ],
      },
    }),
  );

  const output = execFileSync(process.execPath, [bin, 'status'], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  // Directory order is the filesystem's, so compare the lines as a set.
  assert.deepEqual(output.trimEnd().split(/\r?\n/).sort(), [
    '  personal  weekly 95%, reset Tue 14 Nov 22:13, full again  (read 2d ago)  usable',
    '  spare     no reading yet',
    '* work      5-hour 40%, reset Tue 14 Nov 22:13, full again; weekly 97%, resets Fri 1 Jan 00:00  (read 3h ago)  spent',
  ].sort());
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
