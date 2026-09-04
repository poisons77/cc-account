# cc-account

Switch the active Claude Code account from the command line. No browser, no magic link, no
re-authorization.

```console
$ cc-account list
  work       me@company.com  [max]
* perso      me@example.com  [max]

$ cc-account use work
Saved 'perso' before switching.
Now on 'work'  ->  me@company.com [max]
```

Running sessions pick up the new account on their next API call, so nothing needs restarting.

## Why it takes a tool

Signing in mints an OAuth token. Every step of that flow — the web login, the emailed link, the
authorization window — exists only to produce it. Save the token once per account and every later
switch is a copy.

Claude Code splits one account across two places, and moving only the first leaves a stale
identity behind:

| | Location |
|---|---|
| Tokens | macOS Keychain service `Claude Code-credentials`, elsewhere `~/.claude/.credentials.json` |
| Identity | `~/.claude.json` → `oauthAccount` |

`CLAUDE_CONFIG_DIR` relocates both, and cc-account follows it.

## Install

Requires Node 22+ and the `claude` CLI on `PATH`.

```console
npm install -g cc-account
```

Or as a Claude Code plugin, which adds an `/account` command:

```
/plugin marketplace add poisons77/cc-account
/plugin install cc-account@cc-account
```

## Use

Snapshot each account once, right after signing in as it:

```console
$ cc-account save perso
Saved 'perso'  <-  me@example.com [max]

$ claude auth logout
$ claude auth login          # sign in as the other account
$ cc-account save work
```

That is the last time you see a magic link. From then on:

```console
$ cc-account use perso
```

## Commands

| Command | Effect |
|---|---|
| `save [name]` | Snapshot the logged-in account. Name defaults to the email local part. |
| `use <name>` | Switch. Re-snapshots the outgoing account first. |
| `rotate` | Switch to the account switched away from longest ago. |
| `list` | Show snapshots; `*` marks the active one. |
| `current` | Show who is logged in now, and re-publish it after a manual `/login`. |
| `--creds-only` | Swap tokens only, leaving `oauthAccount` untouched. |

## Automatic rotation

Pair with [cc-pace](https://github.com/poisons77/cc-pace) to switch on its own: burn the smaller
plan, fall back to the reserve when a window runs dry, return the moment it refills.

```json
{
  "rotation": {
    "primary": "work",
    "fallback": "personal",
    "buckets": { "five_hour": 95, "seven_day": 99 },
    "command": "cc-account"
  }
}
```

Setup and limits: [`docs/rotation.md`](docs/rotation.md).

## What `use` does

1. Target already active → report and stop, nothing written.
2. Re-snapshot the outgoing account. Refresh tokens rotate, so a snapshot left behind goes dead;
   an account that has no snapshot yet gets one here rather than costing a browser login later.
3. Write the target's tokens atomically — temp file plus rename, or a Keychain update in place —
   so a live session reads either the old set or the new one, never a partial write.
4. Replace only the `oauthAccount` key of `~/.claude.json`. Unrelated state in that file,
   including MCP server logins, is left alone.
5. Drop `daemon-auth-status.json` and `daemon-auth-cooldown`, regenerable caches that would
   otherwise report the previous account.

## Storage

```
~/.claude-accounts/
  perso/
    .credentials.json    token blob, copied verbatim and never parsed
    oauthAccount.json    identity
    meta.json            email, plan, authMethod, savedAt
```

`meta.json` is the index: the active account is the one whose email matches
`claude auth status --json`. Set `CC_ACCOUNT_HOME` to store snapshots elsewhere.

These are live credentials. Keep the directory out of synced folders and repositories.

Everything a switch reads, writes and deletes: [`docs/account-storage.md`](docs/account-storage.md).

## Platforms

| | Tokens | Pickup |
|---|---|---|
| Windows | `~/.claude/.credentials.json` | immediate |
| Linux, WSL | `~/.claude/.credentials.json`, mode 600 | immediate |
| macOS | Keychain, service `Claude Code-credentials` | ~30s cache; restart Claude Code to apply at once |

Verified on Windows against subscription accounts on the first-party API. The macOS Keychain path
is written but untested.

## Licence

MIT. See [LICENSE](LICENSE).

Not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of their respective owner.
