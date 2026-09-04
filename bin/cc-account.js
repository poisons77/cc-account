#!/usr/bin/env node
import { resolvePaths } from '../src/paths.js';
import { usesKeychain } from '../src/credentials.js';
import {
  authStatus,
  findByEmail,
  listAccounts,
  pickRotationTarget,
  saveAccount,
  useAccount,
} from '../src/accounts.js';
import { writeRotationState } from '../src/rotationState.js';

const HELP = `cc-account - switch the active Claude Code account.

  save [name]     Snapshot the logged-in account. Name defaults to the email local part.
  use <name>      Switch to a snapshot. Re-snapshots the outgoing account first.
  rotate          Switch to the account switched away from longest ago.
  list            Show snapshots; * marks the active one.
  current         Show who is logged in now.

Options:
  --creds-only    Swap credentials only, leaving oauthAccount untouched.

Running sessions pick up the new account on their next API call. No restart needed.`;

const paths = resolvePaths();
const [command = 'help', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
const [name] = rest.filter((arg) => !arg.startsWith('--'));

const die = (message) => {
  console.error(message);
  process.exit(1);
};

const describe = (status) =>
  `${status.email} [${status.subscriptionType ?? status.authMethod}]`;

function switchTo(target) {
  const result = useAccount(paths, target, { credsOnly: flags.has('--creds-only') });

  if (result.alreadyActive) {
    console.log(`Already on ${result.email}.`);
    return;
  }
  if (result.restashed) console.log(`Saved '${result.restashed}' before switching.`);

  if (!result.status?.loggedIn) {
    die(`Switched to '${target}' but auth status reports logged out.`);
  }

  console.log(`Now on '${target}'  ->  ${describe(result.status)}`);
  if (usesKeychain()) {
    console.log('macOS caches the Keychain read for ~30s; restart Claude Code to apply now.');
  }
}

try {
  switch (command) {
  case 'save': {
    const { name: saved, status } = saveAccount(paths, name);
    console.log(`Saved '${saved}'  <-  ${describe(status)}`);
    break;
  }

  case 'use': {
    if (!name) die('Usage: cc-account use <name>');
    switchTo(name);
    break;
  }

  case 'rotate': {
    switchTo(pickRotationTarget(paths));
    break;
  }

  case 'list': {
    const accounts = listAccounts(paths);
    if (accounts.length === 0) {
      console.log('No accounts saved. Run: cc-account save <name>');
      break;
    }
    const activeEmail = authStatus()?.email;
    const width = Math.max(...accounts.map((account) => account.name.length));
    for (const { name: accountName, meta } of accounts) {
      const marker = meta.email && meta.email === activeEmail ? '*' : ' ';
      const plan = meta.subscriptionType ?? meta.authMethod ?? '?';
      console.log(`${marker} ${accountName.padEnd(width)}  ${meta.email ?? '?'}  [${plan}]`);
    }
    break;
  }

  case 'current': {
    const status = authStatus();
    if (!status?.loggedIn) die('Logged out.');
    const known = findByEmail(paths, status.email);
    // Refresh the published identity while we have it: this is the one command that resolves
    // who is live, so it doubles as the way to re-sync after a manual `claude /login`.
    if (known) writeRotationState(paths, { active: known, email: status.email });
    console.log(`${describe(status)} via ${status.authMethod} ${known ? `'${known}'` : '(no snapshot)'}`);
    break;
  }

  default:
    console.log(HELP);
  }
} catch (error) {
  die(error.message);
}
