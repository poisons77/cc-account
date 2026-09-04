import path from 'node:path';

import { readJsonOr, writeJsonAtomic } from './jsonFile.js';

/**
 * A tiny record of which account is live, written on every switch.
 *
 * The statusline payload carries no account identity, so a renderer cannot tell whose limits it
 * is looking at. This file is that missing signal: cc-account is the only component that can
 * resolve identity (via `claude auth status`), so it publishes the answer here on every switch —
 * including manual ones, which keeps the file correct when a human intervenes.
 */
export const statePath = (paths) => path.join(paths.store, 'rotation-state.json');

export function readRotationState(paths) {
  return readJsonOr(statePath(paths), {});
}

export function writeRotationState(paths, { active, email }) {
  writeJsonAtomic(statePath(paths), {
    active,
    email: email ?? null,
    switchedAt: Math.floor(Date.now() / 1000),
    updatedAt: new Date().toISOString(),
  });
}
