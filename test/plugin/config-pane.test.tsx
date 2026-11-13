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
    key: 'seven_day',
    label: 'Switch at weekly use',
    value: '90',
    scope: 'all',
    options: [
      { value: '85', label: '85%' },
      { value: '90', label: '90%' },
    ],
  },
  {
    key: 'limits.work.seven_day',
    label: "'work' switches at weekly use",
    value: '85',
    scope: 'work',
    options: [
      { value: 'same', label: 'as all accounts (90%)' },
      { value: '85', label: '85%' },
    ],
  },
  {
    key: 'limits.home.seven_day',
    label: "'home' switches at weekly use",
    value: 'same',
    scope: 'home',
    options: [
      { value: 'same', label: 'as all accounts (90%)' },
      { value: '85', label: '85%' },
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
  on('ui.focus', () => ({ value: {} }))
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

const ran = (runs: string[][], command: string) => runs.some(argv => argv.slice(-4).join(' ') === command)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the main list shows each setting with its value, and Enter opens its choices (${surface})`, async ($, on) => {
    const runs = engine(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })

    const opened = await $.command.run({ command: 'cc-account', args: 'config' })
    expect(opened.text).toMatch(/Settings opened/)

    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Button', key: 'row:mode' }))?.text).toMatch(/Automatic rotation\s+between all accounts/)
    expect((await ui.find({ type: 'Button', key: 'scope:all' }))?.text).toMatch(/All accounts\s+weekly 90%/)
    expect((await ui.find({ type: 'Button', key: 'scope:work' }))?.text).toMatch(/work\s+weekly 85%/)
    expect((await ui.find({ type: 'Button', key: 'scope:home' }))?.text).toMatch(/home\s+as all accounts/)

    await ui.press({ key: 'row:mode' })
    expect((await ui.find({ type: 'Button', key: 'opt:peers' }))?.text).toBe('✔ between all accounts')
    expect((await ui.find({ type: 'Button', key: 'opt:off' }))?.text).toBe('  off')
    expect(await ui.find({ type: 'Button', key: 'row:mode' })).toBeFalsy()

    await ui.press({ key: 'opt:off' })
    expect(ran(runs, 'config set mode off')).toBe(true)
    // A pick that took returns to the list it was opened from.
    expect(await ui.find({ type: 'Button', key: 'row:mode' })).toBeTruthy()
    await ui.unmount()
  })

  test(`an account's limits open from the main list, and Back returns there (${surface})`, async ($, on) => {
    const runs = engine(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.command.run({ command: 'cc-account', args: 'config' })
    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.press({ key: 'scope:work' })
    expect(await ui.find({ type: 'Text', text: 'Limits for work' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'row:seven_day' })).toBeFalsy()

    await ui.press({ key: 'row:limits.work.seven_day' })
    await ui.press({ key: 'opt:same' })
    expect(ran(runs, 'config set limits.work.seven_day same')).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'Limits for work' })).toBeTruthy()

    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Button', key: 'scope:work' })).toBeTruthy()
    await ui.unmount()
  })

  test(`a free-text setting opens a field of its own (${surface})`, async ($, on) => {
    const runs = engine(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.command.run({ command: 'cc-account', args: 'config' })
    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.press({ key: 'row:browser.work' })
    await ui.input({ key: 'input:browser.work', text: 'firefox' })
    expect(ran(runs, 'config set browser.work firefox')).toBe(true)
    await ui.unmount()
  })

  test(`a change the CLI refuses stays on its screen, the reason shown (${surface})`, async ($, on) => {
    engine(on, { refuse: 'Rotation needs at least two saved accounts.' })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.command.run({ command: 'cc-account', args: 'config' })

    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'row:mode' })
    await ui.press({ key: 'opt:off' })

    const error = await ui.find({ type: 'Text', text: /two saved accounts/ })
    expect(error?.text).toBe('Rotation needs at least two saved accounts.')
    expect(await ui.find({ type: 'Button', key: 'opt:off' })).toBeTruthy()
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
