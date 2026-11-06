import { expiringAccounts, expiryLevel } from './accounts.js';
import { holdOf, paceOutlook, paceQuestion } from './paceRotation.js';
import { readRotationState } from './rotationState.js';
import { sessionNotices } from './settings.js';

/**
 * Everything a session should be told, in one read cheap enough to repeat every minute: no
 * `claude` process is started, so the live account is the one last published to cc-pace.
 *
 * - `logins`: each login within three days of its end, with its `meta` and level (see `expiryLevel`).
 * - `hold`: when no account can take work, which frees up first; null otherwise, and always null
 *   without cc-pace, which is the only one that knows usage.
 * - `forecast`: cc-pace's forecast for all accounts together, passed on as published, or null.
 * - `question`: what cc-pace's rotation stopped to ask (see `paceQuestion`), or null.
 * - `notices`: whether sessions are told about `hold` at all.
 */
export function alerts(paths, now = Date.now()) {
  const outlook = paceOutlook(paths, Math.floor(now / 1000));
  const live = readRotationState(paths);
  return {
    logins: expiringAccounts(paths, live.email ?? null, now).map(({ name, meta, expiresAt }) => ({
      name,
      meta,
      expiresAt,
      level: expiryLevel(expiresAt, now),
    })),
    hold: outlook && holdOf(outlook.accounts, Math.floor(now / 1000)),
    forecast: outlook?.forecast ?? null,
    question: paceQuestion(paths, live.active ?? null),
    notices: sessionNotices(paths),
  };
}
