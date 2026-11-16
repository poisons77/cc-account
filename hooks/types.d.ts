/** One row of `/cc-account config`, as `cc-account config --json` describes it. */
export type Setting = {
  key: string
  label: string
  value: string
  /** A limit row: `all` for every account, or the one account whose own limit it is. */
  scope?: string
  /** Present for a pick; absent for free text. */
  options?: { value: string; label: string }[]
  /** What an empty free-text value means. */
  placeholder?: string
}

/** One connector an account can carry, as `cc-account connectors --json` lists it; only the fields drawn are typed. */
export type Connector = {
  slug: string
  label: string
  kind: 'chrome' | 'claude-ai' | 'server'
  attachedAs: string
  attached: boolean
  /** A server added in Claude Code that needs its own sign-in. */
  needsLogin?: boolean
}

/** One saved account and its connectors; `lane` is null until the account has signed in there. */
export type AccountConnectors = {
  name: string
  lane: { dir: string; email: string; expiresAt: number } | null
  connectors: Connector[]
}

/**
 * What the settings pane draws: the rows, the refusal of the last change when there was one, the
 * connectors of every account, a note shown on the connectors screen, and the screens opened from
 * the main list, innermost last: `limits:<scope>`, `pick:<key>`, `edit:<key>` or
 * `connectors:<account>`. Empty is the main list.
 */
export type SettingsMenu = {
  settings: Setting[]
  error: string | null
  path: string[]
  connectors: AccountConnectors[]
  note: string | null
}

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
