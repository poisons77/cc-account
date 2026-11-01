import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { readRotationState, statePath, updateRotationState } from '../src/rotationState.js';

let paths;

beforeEach(() => {
  paths = { store: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-account-state-')) };
});

afterEach(() => {
  fs.rmSync(paths.store, { recursive: true, force: true });
});

const backdateSwitch = () => {
  const state = readRotationState(paths);
  fs.writeFileSync(statePath(paths), JSON.stringify({ ...state, switchedAt: 1 }));
};

test('the state file lives in the store, beside the snapshots', () => {
  assert.equal(statePath(paths), path.join(paths.store, 'rotation-state.json'));
});

test('reading before anything is published gives an empty record', () => {
  assert.deepEqual(readRotationState(paths), {});
});

test('a published switch round-trips, with both clock forms', () => {
  updateRotationState(paths, { active: 'work', email: 'work@example.com' });

  const state = readRotationState(paths);
  assert.equal(state.active, 'work');
  assert.equal(state.email, 'work@example.com');
  assert.equal(typeof state.switchedAt, 'number');
  assert.ok(Math.abs(state.switchedAt - Date.now() / 1000) < 60);
  assert.ok(Date.parse(state.updatedAt));
});

test('an unresolved email is recorded as null, not left undefined', () => {
  updateRotationState(paths, { active: 'work', email: undefined });

  assert.equal(readRotationState(paths).email, null);
});

test('a later switch replaces the live account', () => {
  updateRotationState(paths, { active: 'work', email: 'work@example.com' });
  updateRotationState(paths, { active: 'personal', email: 'personal@example.com' });

  assert.equal(readRotationState(paths).active, 'personal');
});

test('re-publishing the same live account keeps the switch time', () => {
  updateRotationState(paths, { active: 'work', email: 'work@example.com' });
  backdateSwitch();

  updateRotationState(paths, { active: 'work', email: 'work@example.com' });

  assert.equal(readRotationState(paths).switchedAt, 1);
});

test('publishing logins alone leaves identity and switch time untouched', () => {
  updateRotationState(paths, { active: 'work', email: 'work@example.com' });
  backdateSwitch();

  updateRotationState(paths, { logins: { work: 2000000000, personal: null } });

  const state = readRotationState(paths);
  assert.equal(state.active, 'work');
  assert.equal(state.switchedAt, 1);
  assert.deepEqual(state.logins, { work: 2000000000, personal: null });
});
