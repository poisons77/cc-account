import { readJsonIfPresent, readJsonOr, writeJsonAtomic } from './jsonFile.js';

/**
 * How old cc-pace's ranking may be before `rotate` stops trusting it. cc-pace rewrites it at least
 * every ten minutes while any session renders; older than this, nothing has rendered for hours and
 * the usage it was built from no longer describes the accounts.
 */
export const RANKING_MAX_AGE_SECS = 6 * 3600;

const fresh = (published, now) =>
  typeof published?.at === 'number' && now - published.at <= RANKING_MAX_AGE_SECS;

/**
 * What cc-pace last published about every account: its ranking, best first, eligible or not, and
 * its forecast of when the quota of all accounts together runs out (null when it has none). Null
 * when there is no ranking or it is too old to act on. cc-pace owns the judgement - usage, pace,
 * resets and login expiry are all its inputs - and this reads the answer rather than recomputing it.
 */
export function paceOutlook(paths, now = Math.floor(Date.now() / 1000)) {
  const { ranking, forecast } = readJsonOr(paths.paceState, {}) ?? {};
  if (!Array.isArray(ranking?.accounts) || !fresh(ranking, now)) return null;
  return { accounts: ranking.accounts.filter(Boolean), forecast: fresh(forecast, now) ? forecast : null };
}

/**
 * What cc-pace last saved of each account's windows, by name: `{ at, buckets: { [window]: { used,
 * resets } } }`, with `at` the last render that account was live in. Empty without cc-pace.
 */
export function paceReadings(paths) {
  const { seen } = readJsonOr(paths.paceState, {}) ?? {};
  return seen && typeof seen === 'object' ? seen : {};
}

/**
 * The question cc-pace's rotation stopped on, while the account it was asked on is still live:
 * `{ reason: 'spent', name, used }` when it landed on an account already over its bar, or
 * `{ reason: 'unread', name, readAt }` when the account it would move to was last read too long
 * ago (`readAt` null for never). Null otherwise - leaving that account answers it.
 */
export function paceQuestion(paths, active) {
  const { ask } = readJsonOr(paths.paceState, {}) ?? {};
  return ask && typeof ask === 'object' && active && ask.on === active ? ask : null;
}

/** The accounts cc-pace ranks best first, eligible ones only, or null without a fresh ranking. */
export function paceRanking(paths, now) {
  const outlook = paceOutlook(paths, now);
  return outlook && outlook.accounts.filter((account) => account.eligible).map((account) => account.name);
}

/**
 * Whether no ranked account can take work: none eligible, and none whose spent window has already
 * reset - cc-pace re-ranks only when a session renders, so a `freeAt` in the past means free now.
 * Then: the account that frees up first, and the logins only a renewal brings back. Null otherwise.
 */
export function holdOf(accounts, now) {
  const freeNow = (account) => account.reason === 'spent' && typeof account.freeAt === 'number' && account.freeAt <= now;
  if (accounts.length === 0 || accounts.some((account) => account.eligible || freeNow(account))) return null;
  const [next] = accounts.filter((account) => typeof account.freeAt === 'number').sort((a, b) => a.freeAt - b.freeAt);
  return {
    next: next ? { name: next.name, at: next.freeAt } : null,
    renew: accounts.filter((account) => account.reason === 'login').map((account) => account.name),
  };
}

/** cc-pace's config, or `fallback` when there is none. One that exists but cannot be parsed throws. */
export const readPaceConfig = (paths, fallback = null) => readJsonIfPresent(paths.paceConfig, fallback);

/**
 * Edit the `rotation` block of cc-pace's config and write the file back. Only that block changes:
 * the rest of the file is cc-pace's and the user's. `change` returns the new block, or null to
 * leave the file untouched. Returns true when something was written.
 */
export function editRotation(paths, change) {
  const config = readPaceConfig(paths, null) ?? {};
  const next = change(config.rotation);
  if (!next) return false;
  config.rotation = next;
  writeJsonAtomic(paths.paceConfig, config, 0o644);
  return true;
}

/**
 * Keep cc-pace's `rotation.accounts` list in step with the store, so an account added here joins
 * the rotation and a removed one leaves it. With no cc-pace config, or one with no `accounts`
 * list - a primary-and-fallback rule names its accounts on purpose - nothing is written.
 */
function updateList(paths, change) {
  return editRotation(paths, (rotation) => {
    const accounts = rotation?.accounts;
    if (!Array.isArray(accounts)) return null;
    const next = change(accounts);
    return next.length === accounts.length ? null : { ...rotation, accounts: next };
  });
}

export const joinRotation = (paths, name) =>
  updateList(paths, (accounts) => (accounts.includes(name) ? accounts : [...accounts, name]));

export const leaveRotation = (paths, name) =>
  updateList(paths, (accounts) => accounts.filter((account) => account !== name));
