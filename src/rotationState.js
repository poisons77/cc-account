import path from 'node:path';

import { readJsonOr, writeJsonAtomic } from './jsonFile.js';

/**
 * A tiny record of which account is live, and until when each saved login works.
 *
 * The statusline payload carries no account identity, so a renderer cannot tell whose limits it
 * is looking at. This file is that missing signal: cc-account is the only component that can
 * resolve identity (via `claude auth status`), so it publishes the answer here on every switch -
 * including manual ones, which keeps the file correct when a human intervenes.
 *
 * `logins` maps each account to the unix second its login stops refreshing (null when unknown),
 * so a rotation engine can skip a target that would only fail. It is derived from the snapshots
 * and rewritten whenever one changes; `meta.json` stays the index.
 */
export const statePath = (paths) => path.join(paths.store, 'rotation-state.json');

export function readRotationState(paths) {
  return readJsonOr(statePath(paths), {});
}

/**
 * Merge `fields` into the published record. `switchedAt` moves only when `active` names a
 * different account: a renderer holds off deciding for a while after it, so a re-sync that
 * changes nothing must not restart that wait.
 */
export function updateRotationState(paths, fields) {
  const previous = readRotationState(paths);
  const next = { ...previous, ...fields, updatedAt: new Date().toISOString() };
  if ('email' in fields) next.email = fields.email ?? null;
  if ('active' in fields && fields.active !== previous.active) {
    next.switchedAt = Math.floor(Date.now() / 1000);
  }
  writeJsonAtomic(statePath(paths), next);
}
