# cc-account

Switch the active Claude Code account from the command line. No browser, no magic link, no
re-authorization.

```console
$ cc-account list
* personal  me@example.com  [max]
  work      me@company.com  [max]

$ cc-account use work
Saved 'personal' before switching.
Now on 'work'  ->  me@company.com [max]
```

Running sessions pick up the new account on their next API call, so nothing needs restarting.

## Why it takes a tool

Signing in mints an OAuth token. Every step of that flow - the web login, the emailed link, the
authorization window - exists only to produce it. Save the token once per account and every later
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

Or as a Claude Code plugin, which needs no `PATH` entry and adds a `/cc-account` command:

```
/plugin marketplace add poisons77/cc-account
/plugin install cc-account@cc-account
```

```
/cc-account              list snapshots
/cc-account rotate       switch to the account left longest ago
/cc-account personal     switch to that account
/cc-account current      re-sync identity after a manual /login
```

Plugins do not auto-update. `/plugin update cc-account` pulls a newer commit; the npm install is
the one that tracks releases.

## Use

Snapshot each account once, right after signing in as it:

```console
$ cc-account save personal
Saved 'personal'  <-  me@example.com [max]

$ claude auth logout
$ claude auth login          # sign in as the other account
$ cc-account save work
```

That is the last time you see a magic link. From then on:

```console
$ cc-account use personal
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

`rotate` and `current` cannot be used as account names. `save` refuses them, so the `/cc-account`
slash command can treat them as subcommands without ever hiding an account.

## Switching on its own

cc-account switches when told to. It has no opinion about *when*, because it never sees your usage:
it reads local files and asks `claude auth status` who is logged in. Deciding the moment needs the
rate-limit windows, and those arrive in the Claude Code statusline payload, which is
[cc-pace](https://github.com/poisons77/cc-pace)'s input.

Each tool stands alone. cc-account switches on demand with no statusline installed, and cc-pace
renders usage whether or not you own a second account. Together they close the loop: cc-pace decides
*when*, cc-account performs the switch and publishes *who* is live, which is the identity the
payload does not carry and cc-pace cannot otherwise know.

Install cc-pace, then connect them at one of two depths.

**One command at a threshold.** cc-pace runs any command once per window when a bucket crosses a
percentage, in `~/.config/cc-pace/config.json`:

```json
{
  "onThreshold": { "bucket": "five_hour", "at": 95, "run": "cc-account rotate" }
}
```

`rotate` picks the account switched away from longest ago, so no account names appear in the config.

**The rotation engine.** Watches several windows, picks a target on what it knows of each account,
and reports the outcome in the status line:

```json
{
  "rotation": {
    "accounts": ["work", "personal"],
    "buckets": { "five_hour": 95, "seven_day": { "at": 95, "lateAt": 99, "lateWithinSecs": 129600 } },
    "command": "cc-account"
  }
}
```

```
Session: 95% (2h18m) | Weekly: 67% (4d20h) | → switching to personal
Session: 2% (5h0m)   | Weekly: 61% (4d2h)  | ✓ on personal
```

Name `primary` and `fallback` instead of `accounts` for a reserve you return to rather than peers
you rotate between. Both shapes call `cc-account use <name>`, so the snapshots must exist first.

Setup, the identity file this publishes, and the limits: [`docs/rotation.md`](docs/rotation.md).

## What `use` does

1. Target already active → report and stop, nothing written.
2. Re-snapshot the outgoing account. Refresh tokens rotate, so a snapshot left behind goes dead;
   an account that has no snapshot yet gets one here rather than costing a browser login later.
3. Write the target's tokens atomically - temp file plus rename, or a Keychain update in place -
   so a live session reads either the old set or the new one, never a partial write.
4. Replace only the `oauthAccount` key of `~/.claude.json`. Unrelated state in that file,
   including MCP server logins, is left alone.
5. Drop `daemon-auth-status.json` and `daemon-auth-cooldown`, regenerable caches that would
   otherwise report the previous account.

## Storage

```
~/.claude-accounts/
  personal/
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
