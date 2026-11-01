import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { EXPIRY_URGENT_MS, EXPIRY_WARNING_MS, expiryLevel } from '../src/accounts.js';
import { alerts } from '../src/alerts.js';
import { holdOf, RANKING_MAX_AGE_SECS } from '../src/paceRotation.js';
import { applySetting } from '../src/settings.js';
import { sandbox } from './helpers.js';

let box;
let paths;

beforeEach(() => {
  box = sandbox();
  paths = box.paths;
});

afterEach(() => {
  box.restore();
});

const NOW = 1_800_000_000;
const spent = (name, freeAt) => ({ name, eligible: false, reason: 'spent', room: 0, spare: 0, freeAt });

const publishPace = (state) => {
  fs.mkdirSync(path.dirname(paths.paceState), { recursive: true });
  fs.writeFileSync(paths.paceState, JSON.stringify(state));
};

test('a login is a warning inside three days, urgent inside its last hour, then expired', () => {
  const now = Date.now();
  assert.equal(expiryLevel(null, now), null);
  assert.equal(expiryLevel(now + EXPIRY_WARNING_MS + 1, now), null);
  assert.equal(expiryLevel(now + EXPIRY_WARNING_MS - 1, now), 'warn');
  assert.equal(expiryLevel(now + EXPIRY_URGENT_MS - 1, now), 'urgent');
  assert.equal(expiryLevel(now, now), 'expired');
});

test('work holds only when no account is eligible, and names the first to free up', () => {
  assert.equal(holdOf([], NOW), null);
  assert.equal(holdOf([spent('work', NOW + 60), { name: 'personal', eligible: true }], NOW), null);

  const hold = holdOf(
    [spent('work', NOW + 7200), spent('personal', NOW + 3600), { name: 'third', eligible: false, reason: 'login', freeAt: null }],
    NOW,
  );
  assert.deepEqual(hold, { next: { name: 'personal', at: NOW + 3600 }, renew: ['third'] });
});

test('a spent window whose reset has passed is free now, before cc-pace re-ranks it', () => {
  assert.equal(holdOf([spent('work', NOW - 1), spent('personal', NOW + 3600)], NOW), null);
});

test('alerts pass on cc-pace\'s hold and forecast while they are fresh, and drop them once stale', () => {
  const forecast = { at: NOW, burn: 3.5, sustainable: 2, runsOutAt: NOW + 3600, resumesAt: NOW + 7200, accounts: [] };
  publishPace({ ranking: { at: NOW, accounts: [spent('work', NOW + 600), spent('personal', NOW + 900)] }, forecast });

  const fresh = alerts(paths, NOW * 1000);
  assert.deepEqual(fresh.hold, { next: { name: 'work', at: NOW + 600 }, renew: [] });
  assert.deepEqual(fresh.forecast, forecast);
  assert.equal(fresh.notices, true);

  const stale = alerts(paths, (NOW + RANKING_MAX_AGE_SECS + 1) * 1000);
  assert.equal(stale.hold, null);
  assert.equal(stale.forecast, null);
});

test('without cc-pace there is no hold and no forecast, only logins', () => {
  assert.deepEqual(alerts(paths), { logins: [], hold: null, forecast: null, notices: true });
});

test('turning session notices off is reported with the alerts', () => {
  applySetting(paths, 'sessionNotices', 'off');
  assert.equal(alerts(paths).notices, false);
});
