#!/usr/bin/env node
import path from 'node:path';
import readline from 'node:readline/promises';

import { resolvePaths } from '../src/paths.js';
import { usesKeychain } from '../src/credentials.js';
import {
  accountsWithExpiry,
  authStatus,
  EXPIRY_WARNING_MS,
  expiringAccounts,
  findByEmail,
  listAccounts,
  loggedInEmail,
  pickRotationTarget,
  renewAccount,
  saveAccount,
  setBrowser,
  useAccount,
} from '../src/accounts.js';
import { writeRotationState } from '../src/rotationState.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const WARNING_DAYS = EXPIRY_WARNING_MS / DAY_MS;

const HELP = `cc-account - switch the active Claude Code account.

  save [name]     Snapshot the logged-in account. Name defaults to the email local part.
  use <name>      Switch to a snapshot. Re-snapshots the outgoing account first.
  rotate          Switch to the account switched away from longest ago.
  list            Show snapshots and when each login expires; * marks the active one.
  current         Show who is logged in now.
  renew <name>    Sign an account in again through the browser, which resets its expiry.
  browser <name> [command...]
                  The browser renew opens for that account, such as a Chrome profile.
                  With no command, show it; --reset returns to a private window.
  check           Warn about logins that expire within ${WARNING_DAYS} days. --hook prints SessionStart JSON.

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

function expiryLabel(expiresAt) {
  const left = expiresAt - Date.now();
  if (left <= 0) return 'login expired';
  // Rounded up, as Claude Code's own banner counts: 2d16h left reads as 3d.
  const span = left > DAY_MS ? `${Math.ceil(left / DAY_MS)}d` : `${Math.ceil(left / HOUR_MS)}h`;
  return `login expires in ${span}`;
}

// `renew` cannot run on macOS, where the login it starts would reach the shared Keychain.
const canRenew = !usesKeychain();

const expiryNotice = (account) => `'${account.name}' ${expiryLabel(account.expiresAt)}`;

const expiryWarning = (account) =>
  `${expiryNotice(account)}. ` +
  (canRenew
    ? `Renew: cc-account renew ${account.name}`
    : `Sign in as ${account.meta.email} with /login, then: cc-account save ${account.name}`);

function renew(target) {
  const result = renewAccount(paths, target, {
    onLogin: (browser, email) => {
      console.log(
        browser
          ? `Opening ${path.basename(browser[0])} to sign in as ${email}.`
          : `No browser found to open privately. Open the link below in a private window and sign in as ${email}.`,
      );
    },
  });
  const until = result.expiresAt ? `, good until ${new Date(result.expiresAt).toISOString().slice(0, 10)}` : '';
  console.log(`Renewed '${target}'  ->  ${describe(result.status)}${until}`);
  if (result.active) console.log('It is the live account, so the new login is live too.');
}

/**
 * Name every login close to expiry. In a terminal, offer to renew each one on the spot; anywhere
 * else - a scheduled switch, the slash command - the warning carries the command instead.
 */
async function offerRenewals(activeEmail) {
  const due = expiringAccounts(paths, activeEmail);
  const interactive = canRenew && process.stdin.isTTY && process.stdout.isTTY;

  if (!interactive) {
    for (const account of due) console.log(`! ${expiryWarning(account)}`);
    return;
  }

  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const account of due) {
      console.log(`! ${expiryNotice(account)}. Renew it now? A browser window opens.`);
      console.log('  1: Renew    2: Not now    0: Leave the rest');

      const answer = (await prompt.question('  > ')).trim().toLowerCase();
      if (answer === '0') return;
      if (answer !== '1' && answer !== 'y') continue;

      // The command this follows has already done its work, so a failed renew is reported here
      // rather than thrown, and the exit code stays with the command the user asked for.
      try {
        renew(account.name);
      } catch (error) {
        console.error(`! ${error.message}`);
      }
    }
  } finally {
    prompt.close();
  }
}

/** SessionStart hook output: a line for the user, and for Claude the way to act on it. */
function hookOutput(due) {
  const names = due.map((account) => account.name).join(', ');
  const action = canRenew
    ? 'ask whether to renew each one now. For each one they accept, run ' +
      `\`node "${process.argv[1]}" renew <name>\` with a 10-minute timeout: it opens a browser ` +
      'for the sign-in and waits for it. Report its output.'
    : 'explain that each one needs a /login as that account, followed by `cc-account save <name>`.';
  return {
    systemMessage: due.map((account) => `cc-account: ${expiryWarning(account)}`).join('\n'),
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `cc-account: these saved Claude Code logins expire soon: ${names}. In your first reply, ` +
        `tell the user and ${action}`,
    },
  };
}

async function switchTo(target) {
  const result = useAccount(paths, target, { credsOnly: flags.has('--creds-only') });

  if (result.alreadyActive) {
    console.log(`Already on ${result.email}.`);
    await offerRenewals(result.email);
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
  await offerRenewals(result.status.email);
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
    await switchTo(name);
    break;
  }

  case 'rotate': {
    await switchTo(pickRotationTarget(paths));
    break;
  }

  case 'list': {
    const activeEmail = loggedInEmail(authStatus());
    const accounts = accountsWithExpiry(paths, activeEmail);
    if (accounts.length === 0) {
      console.log('No accounts saved. Run: cc-account save <name>');
      break;
    }
    const width = Math.max(...accounts.map((account) => account.name.length));
    for (const { name: accountName, meta, active, expiresAt } of accounts) {
      const marker = active ? '*' : ' ';
      const plan = meta.subscriptionType ?? meta.authMethod ?? '?';
      const expiry = expiresAt === null ? '' : `  ${expiryLabel(expiresAt)}`;
      console.log(`${marker} ${accountName.padEnd(width)}  ${meta.email ?? '?'}  [${plan}]${expiry}`);
    }
    await offerRenewals(activeEmail);
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

  case 'renew': {
    if (!name) die('Usage: cc-account renew <name>');
    renew(name);
    break;
  }

  case 'browser': {
    // Taken verbatim: a browser command carries flags of its own, such as --profile-directory.
    const [target, ...browser] = rest;
    if (!target || target.startsWith('--')) {
      die('Usage: cc-account browser <name> [command... | --reset]');
    }
    if (browser.length === 0) {
      const account = listAccounts(paths).find((candidate) => candidate.name === target);
      if (!account) die(`Unknown account '${target}'.`);
      console.log(account.meta.browser?.join(' ') ?? 'a private window');
    } else if (browser.length === 1 && browser[0] === '--reset') {
      setBrowser(paths, target, null);
      console.log(`'${target}' signs in through a private window.`);
    } else {
      setBrowser(paths, target, browser);
      console.log(`'${target}' signs in with: ${browser.join(' ')}`);
    }
    break;
  }

  case 'check': {
    if (!flags.has('--hook')) {
      const due = expiringAccounts(paths, loggedInEmail(authStatus()));
      if (due.length === 0) console.log(`No login expires within ${WARNING_DAYS} days.`);
      for (const account of due) console.log(`! ${expiryWarning(account)}`);
      break;
    }
    // A session is starting: stay silent unless there is something to act on, and never fail it.
    try {
      const due = expiringAccounts(paths, loggedInEmail(authStatus()));
      if (due.length > 0) console.log(JSON.stringify(hookOutput(due)));
    } catch {
      /* a missing warning costs less than a broken session start */
    }
    break;
  }

  default:
    console.log(HELP);
  }
} catch (error) {
  die(error.message);
}
