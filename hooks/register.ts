// The /cc-account slash command. Registered from code rather than a commands/ file, because Claude
// Code prefixes a file-based plugin command with the plugin name, which here would read
// /cc-account:cc-account. The command runs the bundled CLI directly and shows its output.

import type { Register } from 'claude-code'

const COMMAND = 'cc-account'
// renew and add wait for a sign-in in the browser.
const BROWSER_MS = 10 * 60 * 1000
const CLI_MS = 2 * 60 * 1000

// The first word picks the subcommand; anything else is an account name to switch to. These words
// are RESERVED_NAMES in src/accounts.js, so no account can carry one.
const SUBCOMMANDS = new Set(['rotate', 'current', 'renew', 'add', 'remove'])
const BROWSER_SUBCOMMANDS = new Set(['renew', 'add'])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Switch the active Claude Code account, rotate to the next one, add, renew or remove a login, or show which is in use',
      argumentHint: '[rotate | current | add [account-name] | renew account-name | remove account-name | account-name]',
    })
    return started
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const argv = words.length === 0 ? ['list'] : SUBCOMMANDS.has(words[0]) ? words : ['use', ...words]
    const opensBrowser = BROWSER_SUBCOMMANDS.has(argv[0])
    if (opensBrowser) $.ui.toast('A browser window is opening: sign in there to continue.')
    const result = await $.process.run(['node', `${$.plugin.root}/bin/cc-account.js`, ...argv], {
      timeoutMs: opensBrowser ? BROWSER_MS : CLI_MS,
    })
    const text = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
    return { text: text || `cc-account ${argv[0]} exited with code ${result.exitCode}.` }
  })
}
