import { expect, mock, test } from 'claude-code/testing'

// Run with: claude plugin test .
// The CLI stands behind every change, so the engine's `process.run` is answered here as the CLI
// would answer: the settings as JSON, and a refusal for a value it does not accept.

const SETTINGS = [
  {
    key: 'mode',
    label: 'Automatic rotation',
    value: 'peers',
    options: [
      { value: 'off', label: 'off' },
      { value: 'peers', label: 'between all accounts' },
    ],
  },
  {
    key: 'five_hour',
    label: 'Switch at 5-hour use',
    value: '95',
    options: [
      { value: '90', label: '90%' },
      { value: '95', label: '95%' },
    ],
  },
  { key: 'browser.work', label: "Browser that signs in 'work'", value: '', placeholder: 'a private window' },
]

const PANE = {
  plugin: 'cc-account',
  component: 'Pane',
  requestId: 'cc-account-config',
  props: {
    title: 'cc-account settings',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const QUIET = { logins: [], hold: null, notices: true }
const HOLD = { text: "All accounts are out of quota: hold off on new work. 'work' frees up Sun 8 Nov 07:00." }

type Engine = Parameters<Parameters<typeof test>[1]>[1]

/** `alerts` is what `check --json` answers; a function answers each poll in turn. */
function engine(on: Engine, { refuse = '', alerts = (): object => QUIET } = {}) {
  const runs: string[][] = []
  on('command.register', () => ({ value: { command: 'cc-account' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    if (argv.includes('check')) return { value: { stdout: JSON.stringify(alerts()), stderr: '', exitCode: 0 } }
    if (argv.includes('--json')) return { value: { stdout: JSON.stringify(SETTINGS), stderr: '', exitCode: 0 } }
    if (refuse) return { value: { stdout: '', stderr: refuse, exitCode: 1 } }
    return { value: { stdout: 'Set.', stderr: '', exitCode: 0 } }
  })
  return runs
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/cc-account config opens a menu whose pick is saved through the CLI (${surface})`, async ($, on) => {
    const runs = engine(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })

    const opened = await $.command.run({ command: 'cc-account', args: 'config' })
    expect(opened.text).toMatch(/Settings opened/)

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Select', key: 'five_hour' })).toBeTruthy()
    expect(await ui.find({ type: 'Input', key: 'browser.work' })).toBeTruthy()

    await $.ui.select({ plugin: 'cc-account', key: 'five_hour', value: '90' })
    expect(runs.some(argv => argv.slice(-4).join(' ') === 'config set five_hour 90')).toBe(true)
    await ui.unmount()
  })

  test(`a change the CLI refuses is shown in the menu (${surface})`, async ($, on) => {
    engine(on, { refuse: 'Rotation needs at least two saved accounts.' })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.command.run({ command: 'cc-account', args: 'config' })

    const ui = await $.ui.mount({ ...PANE, surface })
    await $.ui.select({ plugin: 'cc-account', key: 'mode', value: 'off' })

    const error = await ui.find({ type: 'Text', text: /two saved accounts/ })
    expect(error?.text).toBe('Rotation needs at least two saved accounts.')
    await ui.unmount()
  })
}

const BAND = {
  plugin: 'cc-account',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

function toasts(on: Engine) {
  const shown: string[] = []
  on('ui.toast', (_, e) => {
    shown.push(e.text)
    return { value: undefined }
  })
  return shown
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`every session is told when all accounts run out, and again when one is back (${surface})`, async ($, on) => {
    const clock = mock.clock(on)
    const answers = [{ ...QUIET, hold: HOLD }, QUIET]
    engine(on, { alerts: () => answers[0] })
    const shown = toasts(on)

    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await clock.settle()
    expect(shown).toEqual([HOLD.text])

    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /hold off/ }))?.text).toBe(`! ${HOLD.text}`)
    await ui.unmount()

    answers.shift()
    await clock.advance(60_000)
    expect(shown).toEqual([HOLD.text, 'An account has quota again: work can resume.'])
  })

  test(`a login in its last hour stays red above the prompt (${surface})`, async ($, on) => {
    const clock = mock.clock(on)
    const urgent = { name: 'work', level: 'urgent', text: "'work' login expires in 1h. Renew: cc-account renew work" }
    const warn = { name: 'personal', level: 'warn', text: "'personal' login expires in 2d. Renew: cc-account renew personal" }
    engine(on, { alerts: () => ({ ...QUIET, logins: [urgent, warn] }) })

    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await clock.settle()

    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /'work'/ }))?.text).toBe(`! ${urgent.text}`)
    expect(await ui.find({ type: 'Text', text: /'personal'/ })).toBeFalsy()
    await ui.unmount()
  })
}

test('with session notices off, running out is neither toasted nor drawn', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, { alerts: () => ({ ...QUIET, hold: HOLD, notices: false }) })
  const shown = toasts(on)
  // Stands for the engine's own band, which the plugin hands the drawing to.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(shown).toEqual([])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /hold off/ })).toBeFalsy()
  await ui.unmount()
})

test('any other word still runs the CLI and shows its output', async ($, on) => {
  const runs = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const result = await $.command.run({ command: 'cc-account', args: 'work' })

  expect(runs.at(-1)?.slice(-2)).toEqual(['use', 'work'])
  expect(result.text).toBe('Set.')
})
