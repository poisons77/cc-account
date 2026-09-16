import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { browserCommand, writeBrowserShim } from '../src/browser.js';
import { refreshTokenExpiry } from '../src/credentials.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-account-browser-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an account\'s own browser wins over any private window', () => {
  const installed = path.join(dir, 'chrome');
  fs.writeFileSync(installed, '');
  const paths = { privateBrowsers: [[installed, '--incognito']] };

  assert.deepEqual(browserCommand(paths, { browser: ['firefox', '-P', 'work'] }), ['firefox', '-P', 'work']);
});

test('without one, the first installed browser opens privately', () => {
  const installed = path.join(dir, 'msedge');
  fs.writeFileSync(installed, '');
  const paths = {
    privateBrowsers: [
      [path.join(dir, 'chrome-not-installed'), '--incognito'],
      [installed, '--inprivate'],
    ],
  };

  assert.deepEqual(browserCommand(paths, {}), [installed, '--inprivate']);
});

test('with no browser installed there is no command, and Claude Code prints the link', () => {
  const paths = { privateBrowsers: [[path.join(dir, 'nothing'), '--incognito']] };

  assert.equal(browserCommand(paths, { browser: [] }), null);
});

test('the BROWSER shim is an executable that starts the opener', () => {
  const shim = writeBrowserShim(dir);
  const body = fs.readFileSync(shim, 'utf8');

  assert.match(body, /openBrowser\.js/);
  assert.ok(body.includes(process.execPath));
  if (process.platform === 'win32') {
    assert.equal(path.extname(shim), '.cmd');
  } else {
    assert.equal(fs.statSync(shim).mode & 0o777, 0o700);
  }
});

test('refreshTokenExpiry reads the date a login stops refreshing', () => {
  const blob = JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: 1_790_000_000_000 } });

  assert.equal(refreshTokenExpiry(blob), 1_790_000_000_000);
});

test('refreshTokenExpiry is null for a blob that does not say, or is not JSON', () => {
  assert.equal(refreshTokenExpiry(JSON.stringify({ claudeAiOauth: {} })), null);
  assert.equal(refreshTokenExpiry(JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: 'soon' } })), null);
  assert.equal(refreshTokenExpiry('not json'), null);
  // Seconds, not milliseconds: would read as 1970 and flag every login as expired.
  assert.equal(refreshTokenExpiry(JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: 1_790_000_000 } })), null);
  assert.equal(refreshTokenExpiry(null), null);
});
