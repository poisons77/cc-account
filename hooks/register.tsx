// The /cc-account slash command. Registered from code rather than a commands/ file, because Claude
// Code prefixes a file-based plugin command with the plugin name, which here would read
// /cc-account:cc-account. The command runs the bundled CLI directly and shows its output;
// `/cc-account config` opens a settings pane instead, drawn from `cc-account config --json`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Alerts, SettingsMenu } from './types'

const COMMAND = 'cc-account'
const PANE = 'cc-account-config'
// renew and add wait for a sign-in in the browser.
const BROWSER_MS = 10 * 60 * 1000
const CLI_MS = 2 * 60 * 1000

// The first word picks the subcommand; anything else is an account name to switch to. These words
// are RESERVED_NAMES in src/accounts.js, so no account can carry one.
const SUBCOMMANDS = new Set(['rotate', 'current', 'renew', 'add', 'remove', 'config'])
const BROWSER_SUBCOMMANDS = new Set(['renew', 'add'])

// How often each session asks whether a login is ending or every account is out of quota.
const ALERTS_MS = 60 * 1000
const NOTICE_MS = 15 * 1000
const RESUMED = 'An account has quota again: work can resume.'

// Change a tag when its fields change: it declines what an earlier version stored.
const menu = atom({ plugin: 'cc-account', key: 'menu' } as const, { settings: [], error: null } as SettingsMenu, {
  shape: 'menu-1',
})
const alerts = atom({ plugin: 'cc-account', key: 'alerts' } as const, { logins: [], hold: null, notices: true } as Alerts, {
  shape: 'alerts-1',
})

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
  await update($, menu, () => ({ settings, error }))
}

/** Apply one change through the CLI, which owns every rule about it, then redraw. */
async function change($: EngineInterface, key: string, value: string) {
  const result = await cli($, ['config', 'set', key, value])
  await reload($, result.exitCode === 0 ? null : result.stderr.trim() || `Could not set ${key}.`)
}

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
        'Switch the active Claude Code account, rotate to the next one, add, renew or remove a login, change the rotation settings, or show which is in use',
      argumentHint: '[rotate | current | config | add [account-name] | renew account-name | remove account-name | account-name]',
    })
    return started
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)

    if (words.length === 1 && words[0] === 'config') {
      await reload($)
      await $.ui.open({ id: PANE, title: 'cc-account settings', focus: true, closeOnEscape: true })
      return { text: 'Settings opened: arrows move, Enter picks, Esc closes. Each change is saved at once.' }
    }

    const argv = words.length === 0 ? ['list'] : SUBCOMMANDS.has(words[0]) ? words : ['use', ...words]
    const opensBrowser = BROWSER_SUBCOMMANDS.has(argv[0])
    if (opensBrowser) $.ui.toast('A browser window is opening: sign in there to continue.')
    const result = await cli($, argv, opensBrowser ? BROWSER_MS : CLI_MS)
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
    return { text: text || `cc-account ${argv[0]} exited with code ${result.exitCode}.` }
  }).catch(() => ({ text: 'cc-account did not finish. Run it in a terminal to see why.' }))

  // Red above the prompt for as long as it holds: a login in its last hour, or no account with quota.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { logins, hold, notices } = await read($, alerts)
    const lines = [
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Select, Input, Button } = $.ui.resolve(e)
    const { settings, error } = await read($, menu)

    return (
      <Box flexDirection="column">
        {settings.map((setting, index) =>
          setting.options ? (
            <Select
              key={setting.key}
              label={setting.label}
              options={setting.options}
              value={setting.value}
              autoFocus={index === 0 ? true : undefined}
              onSelect={value => void change($, setting.key, value)}
            />
          ) : (
            <Input
              key={setting.key}
              label={setting.label}
              value={setting.value}
              placeholder={setting.placeholder}
              submitLabel="save"
              onSubmit={value => void change($, setting.key, value)}
            />
          ),
        )}
        {error && <Text color="red">{error}</Text>}
        <Button key="close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })}>
          Close
        </Button>
      </Box>
    )
  })
}
