#!/usr/bin/env node
import path from 'node:path';
import readline from 'node:readline/promises';

import { alerts } from '../src/alerts.js';
import { paceOutlook, paceQuestion, paceReadings } from '../src/paceRotation.js';
import { resolvePaths } from '../src/paths.js';
import { readRotationState } from '../src/rotationState.js';
import { applySetting, describeSettings } from '../src/settings.js';
import { usesKeychain } from '../src/credentials.js';
import {
  accountsWithExpiry,
  addAccount,
  authStatus,
  EXPIRY_WARNING_MS,
  expiringAccounts,
  findByEmail,
  listAccounts,
  loggedInEmail,
  pickRotationTarget,
  publishLogins,
  removeAccount,
  renewAccount,
  saveAccount,
  setBrowser,
  useAccount,
} from '../src/accounts.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const WARNING_DAYS = EXPIRY_WARNING_MS / DAY_MS;

const HELP = `cc-account - switch the active Claude Code account.

  add [name]      Sign a new account in through a private browser window and save it.
                  The live account stays logged in. Name defaults to the email local part.
  save [name]     Snapshot the logged-in account. Name defaults to the email local part.
  remove <name>   Delete a snapshot. The live account cannot be removed.
  use <name>      Switch to a snapshot. Re-snapshots the outgoing account first.
  rotate          Switch to the account cc-pace ranks best, or without cc-pace,
                  the one switched away from longest ago.
  list            Show snapshots and when each login expires; * marks the active one.
                  With cc-pace, also each account's use and the forecast for all of them.
  current         Show who is logged in now.
  status          With cc-pace, each account's last saved use, when it resets, when it was
                  read, and whether rotation would switch into it; * marks the active one.
  renew <name>    Sign an account in again through the browser, which resets its expiry.
  browser <name> [command...]
                  The browser renew opens for that account, such as a Chrome profile.
                  With no command, show it; --reset returns to a private window.
  check           Warn about logins that expire within ${WARNING_DAYS} days. --hook prints SessionStart JSON;
                  --json prints every alert for the plugin, usage included with cc-pace.
  config          Show the rotation and sign-in settings. --json for the menu.
  config set <key> <value>
                  Change one; the key is shown in brackets beside each setting.

Options:
  --creds-only    Swap credentials only, leaving oauthAccount untouched.

Running sessions pick up the new account on their next API call. No restart needed.
add, save and remove keep cc-pace's rotation.accounts list in step, when it has one.`;

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

/** Announce the browser a login is about to open. `email` is unset when adding a new account. */
function announceLogin(browser, email) {
  const who = email ?? 'the account to add';
  console.log(
    browser
      ? `Opening ${path.basename(browser[0])} to sign in as ${who}.`
      : `No browser found to open privately. Open the link below in a private window and sign in as ${who}.`,
  );
}

/** A moment in the local time zone, as a person plans around it: `Sun 8 Nov 07:00`. */
const when = (secs) =>
  new Date(secs * 1000).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).replace(',', '');

const WINDOW_NAMES = { five_hour: '5-hour', seven_day: 'weekly' };

/** One account's use of the forecast window, as cc-pace last saw it. */
function usageLabel(forecast, accountName) {
  const usage = forecast?.accounts?.find((entry) => entry.name === accountName);
  if (!usage) return '';
  const window = WINDOW_NAMES[forecast.window] ?? forecast.window;
  if (typeof usage.used !== 'number') return `  ${window} use not seen yet`;
  return `  ${window} ${Math.round(usage.used)}%${usage.resets ? `, resets ${when(usage.resets)}` : ''}`;
}

/** How long ago, coarsely: `just now`, `25m ago`, `3h ago`, `2d ago`. */
function ago(secs) {
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** Every window cc-pace saved of one account, and when it read them. */
function readingLabel(seen, now) {
  const windows = Object.entries(seen?.buckets ?? {});
  if (windows.length === 0) return 'no reading yet';
  const parts = windows.map(([key, { used, resets }]) => {
    const reset = resets > now ? `resets ${when(resets)}` : `reset ${when(resets)}, full again`;
    return `${WINDOW_NAMES[key] ?? key} ${Math.round(used)}%, ${reset}`;
  });
  return `${parts.join('; ')}  (read ${ago(now - seen.at)})`;
}

const VERDICTS = { spent: 'spent', login: 'login ending' };

/** Whether cc-pace's ranking would switch into the account, or '' when it does not rank it. */
function verdictLabel(ranked) {
  if (!ranked) return '';
  return `  ${ranked.eligible ? 'usable' : (VERDICTS[ranked.reason] ?? ranked.reason)}`;
}

/** cc-pace's forecast for all accounts together, in one line. */
function forecastLine(forecast) {
  if (!forecast) return null;
  const sustain = `${forecast.sustainable} accounts sustain ${forecast.sustainable.toFixed(1)}x`;
  if (typeof forecast.burn !== 'number') return `${sustain}; the current burn is not measured yet.`;
  const pace = `Burning ${forecast.burn.toFixed(2)}x; ${sustain}.`;
  if (!forecast.runsOutAt) return `${pace} At this pace the quota lasts until the resets.`;
  const back = forecast.resumesAt ? `, back ${when(forecast.resumesAt)}` : '';
  return `${pace} At this pace every account runs out ${when(forecast.runsOutAt)}${back}.`;
}

/** What cc-pace's rotation stopped to ask, and how to answer it. */
function questionText(question, now = Math.floor(Date.now() / 1000)) {
  const { reason, name: target, used, readAt } = question;
  if (reason === 'spent') {
    return `Rotation stopped: '${target}' was already at ${used}% when it switched there. ` +
      'Pick an account with /cc-account <name>; /cc-account status compares them.';
  }
  const age = typeof readAt === 'number' ? `was last read ${ago(now - readAt)}` : 'has never been read';
  return `Rotation stopped: '${target}' ${age}, so its use is unknown. ` +
    `Switch anyway with /cc-account ${target}, or pick another; /cc-account status compares them.`;
}

function holdText(hold) {
  const next = hold.next ? ` '${hold.next.name}' frees up ${when(hold.next.at)}.` : '';
  const renew = hold.renew.length ? ` Renew to bring back: ${hold.renew.join(', ')}.` : '';
  return `All accounts are out of quota: hold off on new work.${next}${renew}`;
}

const goodUntil = (expiresAt) =>
  expiresAt ? `, good until ${new Date(expiresAt).toISOString().slice(0, 10)}` : '';

const ROTATION_NOTES = {
  joined: (account) => `'${account}' joins the cc-pace rotation.`,
  left: (account) => `'${account}' leaves the cc-pace rotation.`,
  unreadable: (account) =>
    `! cc-pace's config could not be read, so its rotation list was not updated for '${account}'.`,
};

function reportRotation(rotation, account) {
  if (rotation) console.log(ROTATION_NOTES[rotation](account));
}

function renew(target) {
  const result = renewAccount(paths, target, { onLogin: announceLogin });
  console.log(`Renewed '${target}'  ->  ${describe(result.status)}${goodUntil(result.expiresAt)}`);
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
    ? 'ask whether to renew each one now, with the AskUserQuestion tool: one question per login, ' +
      'options "Renew now" and "Later". For each one they accept, run ' +
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
  case 'add': {
    const result = addAccount(paths, name, { onLogin: announceLogin });
    console.log(`Added '${result.name}'  <-  ${describe(result.status)}${goodUntil(result.expiresAt)}`);
    reportRotation(result.rotation, result.name);
    if (!result.active) console.log(`Switch to it: cc-account use ${result.name}`);
    break;
  }

  case 'save': {
    const { name: saved, status, rotation } = saveAccount(paths, name);
    console.log(`Saved '${saved}'  <-  ${describe(status)}`);
    reportRotation(rotation, saved);
    break;
  }

  case 'remove': {
    if (!name) die('Usage: cc-account remove <name>');
    const { email, rotation } = removeAccount(paths, name);
    console.log(`Removed '${name}'${email ? `  (${email})` : ''}`);
    reportRotation(rotation, name);
    break;
  }

  case 'use': {
    if (!name) die('Usage: cc-account use <name>');
    await switchTo(name);
    break;
  }

  case 'rotate': {
    const target = pickRotationTarget(paths);
    console.log(
      target.by === 'cc-pace'
        ? `cc-pace ranks '${target.name}' best: most room, at the best pace, with a working login.`
        : `'${target.name}' was switched away from longest ago.`,
    );
    await switchTo(target.name);
    break;
  }

  case 'list': {
    const activeEmail = loggedInEmail(authStatus());
    const accounts = accountsWithExpiry(paths, activeEmail);
    if (accounts.length === 0) {
      console.log('No accounts saved. Run: cc-account save <name>');
      break;
    }
    const { forecast, hold } = alerts(paths);
    const width = Math.max(...accounts.map((account) => account.name.length));
    for (const { name: accountName, meta, active, expiresAt } of accounts) {
      const marker = active ? '*' : ' ';
      const plan = meta.subscriptionType ?? meta.authMethod ?? '?';
      const expiry = expiresAt === null ? '' : `  ${expiryLabel(expiresAt)}`;
      console.log(
        `${marker} ${accountName.padEnd(width)}  ${meta.email ?? '?'}  [${plan}]${usageLabel(forecast, accountName)}${expiry}`,
      );
    }
    const outlook = forecastLine(forecast);
    if (outlook) console.log(`\n${outlook}`);
    if (hold) console.log(`! ${holdText(hold)}`);
    await offerRenewals(activeEmail);
    break;
  }

  case 'status': {
    // Read from the files cc-pace and cc-account publish, so no `claude` process is started.
    const accounts = listAccounts(paths);
    if (accounts.length === 0) {
      console.log('No accounts saved. Run: cc-account save <name>');
      break;
    }
    const now = Math.floor(Date.now() / 1000);
    const readings = paceReadings(paths);
    const ranking = new Map((paceOutlook(paths, now)?.accounts ?? []).map((ranked) => [ranked.name, ranked]));
    const { active } = readRotationState(paths);
    const width = Math.max(...accounts.map((account) => account.name.length));
    for (const { name: accountName } of accounts) {
      const marker = accountName === active ? '*' : ' ';
      console.log(
        `${marker} ${accountName.padEnd(width)}  ${readingLabel(readings[accountName], now)}${verdictLabel(ranking.get(accountName))}`,
      );
    }
    const question = paceQuestion(paths, active);
    if (question) console.log(`\n! ${questionText(question, now)}`);
    break;
  }

  case 'current': {
    const status = authStatus();
    if (!status?.loggedIn) die('Logged out.');
    const known = findByEmail(paths, status.email);
    // Refresh the published identity while we have it: this is the one command that resolves
    // who is live, so it doubles as the way to re-sync after a manual `claude /login`.
    if (known) publishLogins(paths, status.email, { active: known, email: status.email });
    console.log(`${describe(status)} via ${status.authMethod} ${known ? `'${known}'` : '(no snapshot)'}`);
    break;
  }

  case 'config': {
    // Taken verbatim after the key: a browser command carries flags of its own.
    const [action, key, ...value] = rest;
    if (action === 'set') {
      if (!key || value.length === 0) die('Usage: cc-account config set <key> <value>');
      applySetting(paths, key, value.join(' '));
      console.log(`Set ${key}.`);
      break;
    }
    const settings = describeSettings(paths);
    if (flags.has('--json')) {
      console.log(JSON.stringify(settings));
      break;
    }
    const width = Math.max(...settings.map((setting) => setting.label.length));
    for (const setting of settings) {
      const picked = setting.options?.find((option) => option.value === setting.value);
      const shown = picked?.label ?? (setting.value || setting.placeholder);
      console.log(`${setting.label.padEnd(width)}  ${shown}   [${setting.key}]`);
    }
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
    if (flags.has('--json')) {
      // The plugin polls this every minute in every session, so it starts no `claude` process.
      const state = alerts(paths);
      console.log(
        JSON.stringify({
          ...state,
          logins: state.logins.map(({ meta, ...account }) => ({ ...account, text: expiryWarning({ meta, ...account }) })),
          hold: state.hold && { ...state.hold, text: holdText(state.hold) },
          forecast: state.forecast && { ...state.forecast, text: forecastLine(state.forecast) },
          question: state.question && { ...state.question, text: questionText(state.question) },
        }),
      );
      break;
    }
    if (!flags.has('--hook')) {
      const due = expiringAccounts(paths, loggedInEmail(authStatus()));
      if (due.length === 0) console.log(`No login expires within ${WARNING_DAYS} days.`);
      for (const account of due) console.log(`! ${expiryWarning(account)}`);
      break;
    }
    // A session is starting: stay silent unless there is something to act on, and never fail it.
    // It is also the re-sync point for a login renewed by hand with /login.
    try {
      const activeEmail = loggedInEmail(authStatus());
      publishLogins(paths, activeEmail);
      const due = expiringAccounts(paths, activeEmail);
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
