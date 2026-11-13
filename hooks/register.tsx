// The /cc-account slash command. Registered from code rather than a commands/ file, because Claude
// Code prefixes a file-based plugin command with the plugin name, which here would read
// /cc-account:cc-account. The command runs the bundled CLI directly and shows its output;
// `/cc-account config` opens a settings pane instead, drawn from `cc-account config --json`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Alerts, Setting, SettingsMenu } from './types'

const COMMAND = 'cc-account'
const PANE = 'cc-account-config'
// renew and add wait for a sign-in in the browser.
const BROWSER_MS = 10 * 60 * 1000
const CLI_MS = 2 * 60 * 1000

// The first word picks the subcommand; anything else is an account name to switch to. These words
// are RESERVED_NAMES in src/accounts.js, so no account can carry one.
const SUBCOMMANDS = new Set(['rotate', 'current', 'status', 'renew', 'add', 'remove', 'config'])
const BROWSER_SUBCOMMANDS = new Set(['renew', 'add'])

// How often each session asks whether a login is ending or every account is out of quota.
const ALERTS_MS = 60 * 1000
const NOTICE_MS = 15 * 1000
const RESUMED = 'An account has quota again: work can resume.'

// The limits every account follows unless it has its own.
const ALL = 'all'
const SAME = 'same'
const PANE_TITLE = 'cc-account settings'
// Labels longer than this are not padded: one long label would push every value off the pane.
const LABEL_COLUMN = 44

// Change a tag when its fields change: it declines what an earlier version stored.
const menu = atom(
  { plugin: 'cc-account', key: 'menu' } as const,
  { settings: [], error: null, path: [] } as SettingsMenu,
  { shape: 'menu-3' },
)
const alerts = atom(
  { plugin: 'cc-account', key: 'alerts' } as const,
  { logins: [], hold: null, question: null, notices: true } as Alerts,
  { shape: 'alerts-2' },
)

function cli($: EngineInterface, argv: string[], timeoutMs = CLI_MS) {
  return $.process.run(['node', `${$.plugin.root}/bin/cc-account.js`, ...argv], { timeoutMs })
}

/** Read the settings again; `error` is the refusal of the change that led here, if any. */
async function reload($: EngineInterface, error: string | null = null) {
  const result = await cli($, ['config', '--json'])
  let settings: SettingsMenu['settings'] = []
  try {
    settings = JSON.parse(result.stdout)
  } catch {
    error = result.stderr.trim() || 'cc-account could not read the settings.'
  }
  await update($, menu, prior => ({ ...prior, settings, error }))
}

/** Every account, then each account in the rotation, in the CLI's order. */
const scopesOf = (settings: Setting[]) => [
  ...new Set(settings.flatMap(setting => (setting.scope ? [setting.scope] : []))),
]

const scopeName = (scope: string) => (scope === ALL ? 'All accounts' : scope)

/** A setting's value as the person reads it: its option's label, or the free text's meaning. */
const shownValue = (setting: Setting) =>
  setting.options?.find(option => option.value === setting.value)?.label ?? (setting.value || setting.placeholder || '')

// How a limit row is named inside a one-line summary, by the end of its key.
const LIMIT_NAMES: [string, string][] = [
  ['seven_day.lateWithinSecs', 'within'],
  ['seven_day.lateAt', 'near reset'],
  ['seven_day', 'weekly'],
  ['five_hour', '5-hour'],
]

/** One scope's limits on one line: what it sets, or that it follows every account. */
function limitsSummary(settings: Setting[], scope: string) {
  const parts = settings
    .filter(setting => setting.scope === scope && setting.value !== SAME)
    .map(setting => {
      const name = LIMIT_NAMES.find(([end]) => setting.key.endsWith(end))?.[1] ?? setting.label.trim()
      return `${name} ${shownValue(setting)}`
    })
  return parts.length > 0 ? parts.join(' · ') : 'as all accounts'
}

/** The row a screen was opened from, to put the focus back on when it closes. */
function rowOf(screen: string) {
  const [kind, rest] = [screen.slice(0, screen.indexOf(':')), screen.slice(screen.indexOf(':') + 1)]
  return kind === 'limits' ? `scope:${rest}` : `row:${rest}`
}

/**
 * Put the focus ring on the pane's element keyed `key`. Best effort: a pane that does not hold the
 * keys right now refuses, and the ring then starts on the screen's first row.
 */
function focusOn($: EngineInterface, key: string) {
  $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

/** Open a screen over the current one and put the focus on `focus`, drawn there. */
async function forward($: EngineInterface, screen: string, focus: string) {
  await update($, menu, prior => ({ ...prior, error: null, path: [...prior.path, screen] }))
  focusOn($, focus)
}

/** Close the innermost screen; the one closed, or undefined on the main list. */
async function back($: EngineInterface) {
  let closed: string | undefined
  await update($, menu, prior => {
    closed = prior.path.at(-1)
    return { ...prior, error: null, path: prior.path.slice(0, -1) }
  })
  return closed
}

/** Back a screen, the focus on the row that screen was opened from. */
async function backToRow($: EngineInterface) {
  const closed = await back($)
  if (closed !== undefined) focusOn($, rowOf(closed))
}

/** Apply one change through the CLI, which owns every rule about it; back a screen once it took. */
async function change($: EngineInterface, key: string, value: string) {
  const result = await cli($, ['config', 'set', key, value])
  const refused = result.exitCode === 0 ? null : result.stderr.trim() || `Could not set ${key}.`
  await reload($, refused)
  if (!refused) await backToRow($)
}

/** The pane as a dialog: it takes the keys, the arrows walk its rows, and Esc reaches `ui.close`. */
function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true })
}

/** A row's label padded into a column, so the values line up. */
const column = (label: string) => (label.length < LABEL_COLUMN ? label.padEnd(LABEL_COLUMN) : `${label}  `)

/**
 * Ask the CLI again, and tell this session when every account has just run out of quota or one has
 * just come back. Every session runs this, so each one tells itself: no session wakes another's
 * model, which would spend the very quota that is gone.
 */
async function refresh($: EngineInterface) {
  const result = await cli($, ['check', '--json'])
  let next: Alerts
  try {
    next = JSON.parse(result.stdout)
  } catch {
    return
  }
  let previous: Alerts | undefined
  await update($, alerts, prior => {
    previous = prior
    return next
  })
  if (!next.notices) return
  if (next.question && next.question.at !== previous?.question?.at) {
    $.ui.toast(next.question.text, { timeoutMs: NOTICE_MS })
  }
  if (next.hold && !previous?.hold) $.ui.toast(next.hold.text, { timeoutMs: NOTICE_MS })
  if (!next.hold && previous?.hold) $.ui.toast(RESUMED, { timeoutMs: NOTICE_MS })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void refresh($)
    $.clock.every(ALERTS_MS, () => void refresh($))
    await $.command.register({
      name: COMMAND,
      description:
        'Switch the active Claude Code account, rotate to the next one, add, renew or remove a login, change the rotation settings, or show which is in use and what each account has left',
      argumentHint: '[rotate | current | status | config | add [account-name] | renew account-name | remove account-name | account-name]',
    })
    return started
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)

    if (words.length === 1 && words[0] === 'config') {
      await update($, menu, prior => ({ ...prior, path: [] }))
      await reload($)
      await openPane($)
      return { text: 'Settings opened: arrows move, Enter opens, Esc goes back. Each change is saved at once.' }
    }

    const [first, ...others] = words
    const argv: [string, ...string[]] =
      first === undefined ? ['list'] : SUBCOMMANDS.has(first) ? [first, ...others] : ['use', ...words]
    const opensBrowser = BROWSER_SUBCOMMANDS.has(argv[0])
    if (opensBrowser) $.ui.toast('A browser window is opening: sign in there to continue.')
    const result = await cli($, argv, opensBrowser ? BROWSER_MS : CLI_MS)
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
    return { text: text || `cc-account ${argv[0]} exited with code ${result.exitCode}.` }
  }).catch(() => ({ text: 'cc-account did not finish. Run it in a terminal to see why.' }))

  // Red above the prompt for as long as it holds: a login in its last hour, no account with quota,
  // or a rotation stopped until someone picks an account.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { logins, hold, question, notices } = await read($, alerts)
    const lines = [
      ...(question ? [question.text] : []),
      ...(notices && hold ? [hold.text] : []),
      ...logins.filter(login => login.level !== 'warn').map(login => login.text),
    ]
    if (e.props.hasSurvey || lines.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text key={line} color="red" bold>
            ! {line}
          </Text>
        ))}
      </Box>
    )
  })

  // Esc on an inner screen goes back one, as in Claude Code's own menus; on the main list it closes.
  // Esc has handed the keys to the prompt by now, so the pane asks for them again.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person') return next(e)
    const closed = await back($)
    if (closed === undefined) return next(e)
    await openPane($)
    focusOn($, rowOf(closed))
    // Answered without `next`: the pane stays open.
    return { value: undefined }
  })

  // A list in the manner of /plugins: one row per setting with its value, Enter opens it, and the
  // screen it opens lists the choices with the current one ticked.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input, Button } = $.ui.resolve(e)
    const { settings, error, path } = await read($, menu)
    const scopes = scopesOf(settings)
    const screen = path.at(-1) ?? ''
    const kind = screen.slice(0, screen.indexOf(':'))
    const target = screen.slice(screen.indexOf(':') + 1)
    const setting = settings.find(candidate => candidate.key === target)

    const listRow = (key: string, label: string, value: string, onPress: () => void, isFirst: boolean) => (
      <Button key={key} plain autoFocus={isFirst ? true : undefined} onPress={onPress}>
        {column(label)}
        <Text dimColor>{value}</Text>
      </Button>
    )
    const settingRow = (row: Setting, index: number) =>
      listRow(
        `row:${row.key}`,
        row.label,
        shownValue(row),
        () =>
          void (row.options
            ? forward($, `pick:${row.key}`, `opt:${row.value}`)
            : forward($, `edit:${row.key}`, `input:${row.key}`)),
        index === 0,
      )
    const heading = (text: string) => (
      <Text key={`heading:${text}`} bold>
        {text}
      </Text>
    )

    let body
    if (kind === 'pick' && setting?.options) {
      body = [
        heading(setting.label.trim()),
        ...setting.options.map(option => (
          <Button
            key={`opt:${option.value}`}
            plain
            autoFocus={option.value === setting.value ? true : undefined}
            onPress={() => void change($, setting.key, option.value)}
          >
            {option.value === setting.value ? '✔ ' : '  '}
            {option.label}
          </Button>
        )),
      ]
    } else if (kind === 'edit' && setting) {
      body = [
        heading(setting.label.trim()),
        <Input
          key={`input:${setting.key}`}
          value={setting.value}
          placeholder={setting.placeholder}
          submitLabel="save"
          onSubmit={value => void change($, setting.key, value)}
        />,
      ]
    } else if (kind === 'limits' && scopes.includes(target)) {
      body = [
        heading(`Limits for ${scopeName(target)}`),
        <Text key="limits-note" dimColor>
          {target === ALL
            ? 'Every account follows these, unless it sets its own.'
            : 'What this account sets wins over all accounts; the rest follows them.'}
        </Text>,
        ...settings.filter(row => row.scope === target).map(settingRow),
      ]
    } else {
      // The main list; also what a screen gone since it opened shows, such as an account's limits
      // after it left the rotation.
      const general = settings.filter(row => !row.scope && !row.key.startsWith('browser.'))
      const browsers = settings.filter(row => row.key.startsWith('browser.'))
      body = [
        heading('Rotation'),
        ...general.map(settingRow),
        ...(scopes.length > 0
          ? [
              heading('Limits'),
              ...scopes.map(scope =>
                listRow(
                  `scope:${scope}`,
                  scopeName(scope),
                  limitsSummary(settings, scope),
                  () => void forward($, `limits:${scope}`, `row:${settings.find(row => row.scope === scope)?.key}`),
                  false,
                ),
              ),
            ]
          : []),
        ...(browsers.length > 0 ? [heading('Sign-in'), ...browsers.map((row, index) => settingRow(row, index + 1))] : []),
      ]
    }

    const inner = path.length > 0
    return (
      <Box flexDirection="column">
        {body}
        {error && <Text color="red">{error}</Text>}
        <Text dimColor>{`↑↓ move · Enter ${inner ? 'select' : 'open'} · Esc ${inner ? 'back' : 'close'}`}</Text>
        {inner ? (
          <Button key="back" plain dimColor onPress={() => void backToRow($)}>
            ← Back
          </Button>
        ) : (
          <Button key="close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })}>
            Close
          </Button>
        )}
      </Box>
    )
  })
}
