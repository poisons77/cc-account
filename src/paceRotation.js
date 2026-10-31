import { readJsonIfPresent, writeJsonAtomic } from './jsonFile.js';

/**
 * Keep cc-pace's `rotation.accounts` list in step with the store, so an account added here joins
 * the rotation and a removed one leaves it. Only that list is touched: the rest of the file is
 * cc-pace's and the user's. With no cc-pace config, or one with no `accounts` list - a
 * primary-and-fallback rule names its accounts on purpose - nothing is written.
 *
 * Returns true when the list changed. A config that exists but cannot be parsed throws, rather
 * than being written back over.
 */
function updateList(paths, change) {
  const config = readJsonIfPresent(paths.paceConfig, null);
  const accounts = config?.rotation?.accounts;
  if (!Array.isArray(accounts)) return false;

  const next = change(accounts);
  if (next.length === accounts.length) return false;

  config.rotation.accounts = next;
  writeJsonAtomic(paths.paceConfig, config, 0o644);
  return true;
}

export const joinRotation = (paths, name) =>
  updateList(paths, (accounts) => (accounts.includes(name) ? accounts : [...accounts, name]));

export const leaveRotation = (paths, name) =>
  updateList(paths, (accounts) => accounts.filter((account) => account !== name));
