/** One row of `/cc-account config`, as `cc-account config --json` describes it. */
export type Setting = {
  key: string
  label: string
  value: string
  /** Present for a pick; absent for free text. */
  options?: { value: string; label: string }[]
  /** What an empty free-text value means. */
  placeholder?: string
}

/** What the settings pane draws: the rows, and the refusal of the last change when there was one. */
export type SettingsMenu = { settings: Setting[]; error: string | null }

/** What every session is told, as `cc-account check --json` reports it; only the fields drawn are typed. */
export type Alerts = {
  logins: { name: string; level: 'expired' | 'urgent' | 'warn'; text: string }[]
  hold: { text: string } | null
  /** What cc-pace's rotation stopped to ask; it waits for a person. */
  question: { text: string; at: number } | null
  notices: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'cc-account': { menu: Shaped<SettingsMenu>; alerts: Shaped<Alerts> }
  }
}
