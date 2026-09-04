import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { readRotationState, statePath, writeRotationState } from '../src/rotationState.js';

let paths;

beforeEach(() => {
  paths = { store: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-account-state-')) };
});

afterEach(() => {
  fs.rmSync(paths.store, { recursive: true, force: true });
});

test('the state file lives in the store, beside the snapshots', () => {
  assert.equal(statePath(paths), path.join(paths.store, 'rotation-state.json'));
});

test('reading before anything is published gives an empty record', () => {
  assert.deepEqual(readRotationState(paths), {});
});

test('a published switch round-trips, with both clock forms', () => {
  writeRotationState(paths, { active: 'work', email: 'work@example.com' });

  const state = readRotationState(paths);
  assert.equal(state.active, 'work');
  assert.equal(state.email, 'work@example.com');
  assert.equal(typeof state.switchedAt, 'number');
  assert.ok(Math.abs(state.switchedAt - Date.now() / 1000) < 60);
  assert.ok(Date.parse(state.updatedAt));
});

test('an unresolved email is recorded as null, not left undefined', () => {
  writeRotationState(paths, { active: 'work' });

  assert.equal(readRotationState(paths).email, null);
});

test('a later switch replaces the record rather than accumulating', () => {
  writeRotationState(paths, { active: 'work', email: 'work@example.com' });
  writeRotationState(paths, { active: 'personal', email: 'personal@example.com' });

  assert.equal(readRotationState(paths).active, 'personal');
});
