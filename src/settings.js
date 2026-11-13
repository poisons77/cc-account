import fs from 'node:fs';

import { listAccounts, setBrowser } from './accounts.js';
import { readJsonOr, writeJsonAtomic } from './jsonFile.js';
import { editRotation, readPaceConfig, withoutLimits } from './paceRotation.js';

/**
 * Every setting `/cc-account config` shows, described once so the menu pane, `cc-account config`
 * and the tests read the same list. Each setting has a key, a label, the current value, and
 * either a fixed set of options (a pick) or none (free text). Values are always strings: they
 * travel through a command line and a Select.
 *
 * Rotation settings live in cc-pace's config, which runs the rotation; the browser settings live
 * in each account's `meta.json`, which `renew` and `add` read; the rest in `paths.settings`.
 */

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

const OFF = { value: 'off', label: 'off' };
const percents = (values) => values.map((n) => ({ value: String(n), label: `${n}%` }));
function spanLabel(secs) {
  if (secs === 0) return 'none';
  if (secs % DAY === 0) return `${secs / DAY}d`;
  if (secs % HOUR === 0) return `${secs / HOUR}h`;
  return `${secs / MIN}m`;
}
const spans = (values) => values.map((secs) => ({ value: String(secs), label: spanLabel(secs) }));
const YES_NO = [
  { value: 'on', label: 'yes' },
  { value: 'off', label: 'no' },
];

// cc-pace's defaults, so the menu shows what the engine actually does when a key is absent.
const DEFAULT_AT = 95;
const DEFAULT_GRACE = 60;
const DEFAULT_LATE_WITHIN = 36 * HOUR;

/**
 * Every watched window as `{ key: { at, lateAt?, lateWithinSecs? } }`, from any of the shapes
 * cc-pace accepts: `bucket`, a `buckets` list, or a `buckets` object of numbers or objects.
 */
function windowsOf(rotation) {
  const at = typeof rotation?.at === 'number' ? rotation.at : DEFAULT_AT;
  const buckets = rotation?.buckets;
  if (buckets && typeof buckets === 'object' && !Array.isArray(buckets)) {
    return Object.fromEntries(
      Object.entries(buckets).map(([key, spec]) => [
        key,
        spec && typeof spec === 'object' ? { at, ...spec } : { at: typeof spec === 'number' ? spec : at },
      ]),
    );
  }
  if (Array.isArray(buckets) && buckets.length) return Object.fromEntries(buckets.map((key) => [key, { at }]));
  return { [rotation?.bucket ?? 'five_hour']: { at } };
}

/** A window's bars in cc-pace's shape: a plain number when `at` is all there is. */
const compact = (spec) => (Object.keys(spec).length === 1 && 'at' in spec ? spec.at : spec);

/** Write windows back in cc-pace's object shape, a plain number wherever nothing else is set. */
function withWindows(rotation, windows) {
  const { bucket, at, ...rest } = rotation;
  const buckets = Object.fromEntries(Object.entries(windows).map(([key, spec]) => [key, compact(spec)]));
  return { ...rest, buckets };
}

/** One account's own bars from cc-pace's `perAccount`, as `{ key: { at?, lateAt?, lateWithinSecs? } }`. */
function overridesOf(rotation, name) {
  const own = rotation?.perAccount?.[name];
  if (!own || typeof own !== 'object') return {};
  return Object.fromEntries(
    Object.entries(own).map(([key, spec]) => [
      key,
      spec && typeof spec === 'object' ? { ...spec } : typeof spec === 'number' ? { at: spec } : {},
    ]),
  );
}

/** Write one account's own bars back, dropping every window, account and block left empty. */
function withOverrides(rotation, name, windows) {
  const own = Object.fromEntries(
    Object.entries(windows)
      .filter(([, spec]) => Object.keys(spec).length > 0)
      .map(([key, spec]) => [key, compact(spec)]),
  );
  const rest = withoutLimits(rotation, name);
  return Object.keys(own).length > 0 ? { ...rest, perAccount: { ...rest.perAccount, [name]: own } } : rest;
}

/** Change one window of one account's own bars. */
function editOverride(block, name, key, change) {
  const own = overridesOf(block, name);
  own[key] = { ...(own[key] ?? {}) };
  change(own[key]);
  return withOverrides(block, name, own);
}

/** The accounts the rotation draws on, in the order the config names them. */
function membersOf(rotation, mode) {
  if (mode === 'peers') return rotation.accounts;
  if (mode === 'primary-fallback') return [rotation.primary, rotation.fallback];
  return [];
}

export function modeOf(rotation) {
  if (!rotation || rotation.enabled === false) return 'off';
  if (Array.isArray(rotation.accounts) && rotation.accounts.length > 1) return 'peers';
  if (rotation.primary && rotation.fallback) return 'primary-fallback';
  return 'off';
}

const saved = (paths) => listAccounts(paths).map((account) => account.name);

/** The rotation block a mode needs, keeping every other setting already chosen. */
function withMode(rotation, mode, names) {
  const { enabled, ...rest } = rotation;
  if (mode === 'off') return { ...rest, enabled: false };
  if (names.length < 2) throw new Error('Rotation needs at least two saved accounts.');
  if (mode === 'peers') {
    return { ...rest, accounts: Array.isArray(rest.accounts) && rest.accounts.length > 1 ? rest.accounts : names };
  }
  // cc-pace reads an `accounts` list first, so primary-and-fallback needs it gone.
  const { accounts, ...pair } = rest;
  return { ...pair, primary: pair.primary ?? names[0], fallback: pair.fallback ?? names[1] };
}

// The bars the menu offers, for every account and for one alike.
const FIVE_HOUR_BARS = [80, 85, 90, 95, 98];
const WEEKLY_BARS = [80, 85, 90, 95, 98, 99];
const LATE_BARS = [95, 96, 97, 98, 99, 100];
const NEAR_SPANS = [12 * HOUR, DAY, 36 * HOUR, 2 * DAY, 3 * DAY];

// Limit rows carry the scope they belong to, so the menu can show one scope at a time: every
// account, or a single one whose own bars win over the shared ones.
const ALL = 'all';
const SAME = 'same';
const same = (shared) => ({ value: SAME, label: `as all accounts (${shared})` });

/**
 * One account's own limits. Each row reads `same` until the account sets that field itself, and
 * picking `same` again drops the field, so the account follows the shared value once more.
 */
function accountLimits(rotation, windows, name) {
  const own = overridesOf(rotation, name);
  const sharedWeekly = windows.seven_day;
  const ownWeekly = own.seven_day ?? {};
  const field = (key, at) => ({
    get: () => (own[key]?.[at] === undefined ? SAME : String(own[key][at])),
    set: (block, value) =>
      editOverride(block, name, key, (spec) => {
        if (value === SAME) delete spec[at];
        else spec[at] = Number(value);
      }),
  });

  const rows = [];
  for (const [key, label, bars] of [
    ['five_hour', '5-hour', FIVE_HOUR_BARS],
    ['seven_day', 'weekly', WEEKLY_BARS],
  ]) {
    if (!windows[key]) continue;
    rows.push({
      key: `limits.${name}.${key}`,
      label: `'${name}' switches at ${label} use`,
      scope: name,
      options: [same(`${windows[key].at}%`), ...percents(bars)],
      ...field(key, 'at'),
    });
  }
  if (!sharedWeekly) return rows;

  const sharedLate = sharedWeekly.lateAt;
  rows.push({
    key: `limits.${name}.seven_day.lateAt`,
    label: `  Near the weekly reset, '${name}' switches at`,
    scope: name,
    options: [same(sharedLate === undefined ? 'off' : `${sharedLate}%`), OFF, ...percents(LATE_BARS)],
    get: () => (ownWeekly.lateAt === undefined ? SAME : ownWeekly.lateAt === false ? 'off' : String(ownWeekly.lateAt)),
    set: (block, value) =>
      editOverride(block, name, 'seven_day', (spec) => {
        delete spec.lateAt;
        if (value === 'off') {
          spec.lateAt = false;
          delete spec.lateWithinSecs;
        } else if (value !== SAME) {
          spec.lateAt = Number(value);
          // cc-pace needs both halves; with no shared window to take, the account gets its own.
          if (sharedWeekly.lateWithinSecs === undefined) spec.lateWithinSecs ??= DEFAULT_LATE_WITHIN;
        }
      }),
  });

  const lateAt = ownWeekly.lateAt === undefined ? sharedLate : ownWeekly.lateAt;
  if (typeof lateAt !== 'number') return rows;
  const sharedWithin = sharedWeekly.lateWithinSecs;
  rows.push({
    key: `limits.${name}.seven_day.lateWithinSecs`,
    label: `  "Near" means within`,
    scope: name,
    // Without a shared window there is nothing to follow: the account's own is the only one.
    options: [...(sharedWithin === undefined ? [] : [same(spanLabel(sharedWithin))]), ...spans(NEAR_SPANS)],
    ...field('seven_day', 'lateWithinSecs'),
  });
  return rows;
}

/** One rotation setting: how it reads from the block, and the block a picked value makes. */
function rotationSettings(rotation, names) {
  const mode = modeOf(rotation);
  const windows = windowsOf(rotation);
  const fiveHour = windows.five_hour;
  const weekly = windows.seven_day;
  const accountOptions = names.map((name) => ({ value: name, label: name }));

  const window = (key) => ({
    get: () => (windows[key] ? String(windows[key].at) : 'off'),
    set: (block, value) => {
      const next = { ...windowsOf(block) };
      if (value === 'off') delete next[key];
      else next[key] = { ...(next[key] ?? {}), at: Number(value) };
      if (Object.keys(next).length === 0) throw new Error('At least one window must stay watched.');
      // A window nobody watches has no bars to override: its per-account entries go with it.
      let result = withWindows(block, next);
      if (value === 'off') {
        for (const name of Object.keys(block.perAccount ?? {})) {
          const own = overridesOf(result, name);
          delete own[key];
          result = withOverrides(result, name, own);
        }
      }
      return result;
    },
  });

  const lateKey = (field, empty) => ({
    get: () => (weekly?.[field] === undefined ? empty : String(weekly[field])),
    set: (block, value) => {
      const next = { ...windowsOf(block) };
      if (!next.seven_day) throw new Error('Watch the weekly window first.');
      const spec = { ...next.seven_day };
      let result = block;
      if (field === 'lateAt' && value === 'off') {
        // An account with a late bar of its own took its window from these shared halves: it keeps it.
        for (const name of Object.keys(block.perAccount ?? {})) {
          if (typeof overridesOf(block, name).seven_day?.lateAt !== 'number' || spec.lateWithinSecs === undefined) continue;
          result = editOverride(result, name, 'seven_day', (own) => {
            own.lateWithinSecs ??= spec.lateWithinSecs;
          });
        }
        delete spec.lateAt;
        delete spec.lateWithinSecs;
      } else {
        spec[field] = Number(value);
        // cc-pace needs both halves: a later bar with no window to apply it in describes nothing.
        spec.lateWithinSecs ??= DEFAULT_LATE_WITHIN;
        spec.lateAt ??= 99;
      }
      next.seven_day = spec;
      return withWindows(result, next);
    },
  });

  const number = (field, fallback) => ({
    get: () => String(typeof rotation?.[field] === 'number' ? rotation[field] : fallback),
    set: (block, value) => {
      const { [field]: dropped, ...rest } = block;
      return value === 'off' ? rest : { ...rest, [field]: Number(value) };
    },
  });

  const settings = [
    {
      key: 'mode',
      label: 'Automatic rotation',
      options: [
        { value: 'off', label: 'off' },
        { value: 'peers', label: 'between all accounts' },
        { value: 'primary-fallback', label: 'primary, fallback while it refills' },
      ],
      get: () => mode,
      set: (block, value) => withMode(block, value, names),
    },
  ];

  if (mode === 'peers') {
    for (const name of names) {
      settings.push({
        key: `account.${name}`,
        label: `  ${name} in rotation`,
        options: YES_NO,
        get: () => (rotation.accounts.includes(name) ? 'on' : 'off'),
        set: (block, value) => {
          const accounts = block.accounts.filter((account) => account !== name);
          if (value === 'on') accounts.push(name);
          if (accounts.length < 2) throw new Error('Peer rotation needs at least two accounts.');
          return { ...block, accounts };
        },
      });
    }
    settings.push({
      key: 'askIfUnreadSecs',
      label: '  Ask before switching into an account last read more than',
      options: [OFF, ...spans([12 * HOUR, DAY, 2 * DAY, 3 * DAY])],
      ...number('askIfUnreadSecs', 'off'),
    });
  }

  if (mode === 'primary-fallback') {
    settings.push(
      {
        key: 'primary',
        label: '  Primary',
        options: accountOptions,
        get: () => rotation.primary,
        set: (block, value) => ({ ...block, primary: value }),
      },
      {
        key: 'fallback',
        label: '  Fallback',
        options: accountOptions,
        get: () => rotation.fallback,
        set: (block, value) => ({ ...block, fallback: value }),
      },
      {
        key: 'returnGraceSeconds',
        label: '  Wait after the primary refills',
        options: spans([0, MIN, 5 * MIN, 15 * MIN]),
        ...number('returnGraceSeconds', DEFAULT_GRACE),
      },
    );
  }

  if (mode === 'off') return settings;

  settings.push(
    {
      key: 'five_hour',
      label: 'Switch at 5-hour use',
      scope: ALL,
      options: [OFF, ...percents(FIVE_HOUR_BARS)],
      ...window('five_hour'),
    },
    {
      key: 'seven_day',
      label: 'Switch at weekly use',
      scope: ALL,
      options: [OFF, ...percents(WEEKLY_BARS)],
      ...window('seven_day'),
    },
  );

  if (weekly) {
    settings.push(
      {
        key: 'seven_day.lateAt',
        label: '  Near the weekly reset, switch at',
        scope: ALL,
        options: [OFF, ...percents(LATE_BARS)],
        ...lateKey('lateAt', 'off'),
      },
    );
    if (weekly.lateAt !== undefined) {
      settings.push({
        key: 'seven_day.lateWithinSecs',
        label: '  "Near" means within',
        scope: ALL,
        options: spans(NEAR_SPANS),
        ...lateKey('lateWithinSecs', String(DEFAULT_LATE_WITHIN)),
      });
    }
  }

  for (const name of membersOf(rotation, mode)) settings.push(...accountLimits(rotation, windows, name));

  settings.push(
    {
      key: 'switchAheadSecs',
      label: 'Switch early when the burn rate hits 100% within',
      options: [OFF, ...spans([5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN])],
      ...number('switchAheadSecs', 'off'),
    },
    {
      key: 'ascii',
      label: 'Plain ASCII status marks',
      options: YES_NO,
      get: () => (rotation.ascii ? 'on' : 'off'),
      set: (block, value) => {
        const { ascii, ...rest } = block;
        return value === 'on' ? { ...rest, ascii: true } : rest;
      },
    },
  );
  return settings;
}

/**
 * Words of a command typed as one line. Double quotes keep spaces inside a word, anywhere in it:
 * `--profile-directory="Profile 2"` is one argument, as a shell would pass it.
 */
export function splitCommand(line) {
  const words = [];
  let word = null;
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      word ??= '';
    } else if (!quoted && /\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + char;
    }
  }
  if (quoted) throw new Error(`Unclosed quote in: ${line}`);
  if (word !== null) words.push(word);
  return words;
}

/** The browser `renew` opens for each account, as free text; empty means a private window. */
function browserSettings(paths) {
  return listAccounts(paths).map((account) => ({
    key: `browser.${account.name}`,
    label: `Browser that signs in '${account.name}'`,
    placeholder: 'a private window',
    get: () => account.meta.browser?.map((word) => (/\s/.test(word) ? `"${word}"` : word)).join(' ') ?? '',
    apply: (value) => {
      const words = splitCommand(value);
      setBrowser(paths, account.name, words.length ? words : null);
    },
  }));
}

const SESSION_NOTICES = 'sessionNotices';

/** Whether every session is told when no account can take work, and again when one can. On unless turned off. */
export const sessionNotices = (paths) => readJsonOr(paths.settings, {})?.[SESSION_NOTICES] !== false;

/** Settings that belong to cc-account itself, kept in `paths.settings`. */
function ownSettings(paths) {
  return [
    {
      key: SESSION_NOTICES,
      label: 'Tell every session when all accounts run out, and when work can resume',
      options: YES_NO,
      get: () => (sessionNotices(paths) ? 'on' : 'off'),
      apply: (value) => {
        fs.mkdirSync(paths.store, { recursive: true, mode: 0o700 });
        writeJsonAtomic(paths.settings, { ...readJsonOr(paths.settings, {}), [SESSION_NOTICES]: value === 'on' });
      },
    },
  ];
}

function allSettings(paths) {
  const rotation = readPaceConfig(paths, null)?.rotation;
  return [...rotationSettings(rotation, saved(paths)), ...ownSettings(paths), ...browserSettings(paths)];
}

/**
 * What the menu draws: every setting with its value, its options when it is a pick, and for free
 * text what an empty value means.
 */
export function describeSettings(paths) {
  return allSettings(paths).map(({ key, label, scope, options, placeholder, get }) => ({
    key,
    label,
    value: get() ?? '',
    ...(scope && { scope }),
    ...(options && { options }),
    ...(placeholder && { placeholder }),
  }));
}

/** Change one setting. A pick must be one of its options; free text is taken as typed. */
export function applySetting(paths, key, value) {
  const setting = allSettings(paths).find((candidate) => candidate.key === key);
  if (!setting) throw new Error(`Unknown setting '${key}'.`);
  if (setting.options && !setting.options.some((option) => option.value === value)) {
    const allowed = setting.options.map((option) => option.value).join(', ');
    throw new Error(`'${value}' is not a choice for ${key}. Choose one of: ${allowed}`);
  }
  if (setting.apply) {
    setting.apply(value);
    return;
  }
  editRotation(paths, (rotation) => setting.set(rotation ?? {}, value));
}
