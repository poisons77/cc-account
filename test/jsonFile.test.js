import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { readJson, readJsonOr, writeJsonAtomic } from '../src/jsonFile.js';

const posix = process.platform !== 'win32';
let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-account-json-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJsonAtomic round-trips through readJson', () => {
  const file = path.join(dir, 'round-trip.json');
  const value = { email: 'me@example.com', nested: { plan: 'max' }, list: [1, 2, 3] };

  writeJsonAtomic(file, value);

  assert.deepEqual(readJson(file), value);
});

test('writeJsonAtomic creates missing parent directories', () => {
  const file = path.join(dir, 'deep', 'deeper', 'meta.json');

  writeJsonAtomic(file, { ok: true });

  assert.deepEqual(readJson(file), { ok: true });
});

test('writeJsonAtomic leaves no temp file behind', () => {
  const file = path.join(dir, 'clean.json');

  writeJsonAtomic(file, { ok: true });

  const strays = fs.readdirSync(dir).filter((entry) => entry.includes('.tmp-'));
  assert.deepEqual(strays, []);
});

test('writeJsonAtomic replaces an existing file wholesale', () => {
  const file = path.join(dir, 'replaced.json');

  writeJsonAtomic(file, { first: true, dropped: 'yes' });
  writeJsonAtomic(file, { second: true });

  assert.deepEqual(readJson(file), { second: true });
});

test('readJsonOr falls back on a missing file', () => {
  assert.equal(readJsonOr(path.join(dir, 'absent.json')), null);
  assert.deepEqual(readJsonOr(path.join(dir, 'absent.json'), { fallback: true }), {
    fallback: true,
  });
});

test('readJsonOr falls back on malformed JSON rather than throwing', () => {
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{ not json');

  assert.deepEqual(readJsonOr(file, {}), {});
});

test('readJson propagates a parse error, so callers choose the fallback', () => {
  const file = path.join(dir, 'broken-strict.json');
  fs.writeFileSync(file, '{ not json');

  assert.throws(() => readJson(file), SyntaxError);
});

test('a file holding a token is written 0600', { skip: !posix }, () => {
  const file = path.join(dir, 'mode.json');

  writeJsonAtomic(file, { token: 'secret' });

  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('the mode is overridable for files that hold no token', { skip: !posix }, () => {
  const file = path.join(dir, 'open-mode.json');

  writeJsonAtomic(file, { public: true }, 0o644);

  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
});
