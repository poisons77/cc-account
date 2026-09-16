# cc-account

Switch the active Claude Code account from the command line. No browser, no magic link, no
re-authorization - until a login expires, and then one command signs that account in again.

![cc-account use work: the outgoing account is saved, then the terminal reports it is now on work,
me@company.com, on a max plan](docs/images/switch.svg)

Running sessions pick up the new account on their next API call, so nothing needs restarting.

Each account keeps its own snapshot, and `list` says how long each login still refreshes for:

![cc-account list: personal, active, expires in 2 days; work expires in 18 days; a warning offers to
renew personal now, numbered 1 renew, 2 not now, 0 leave the rest](docs/images/list.svg)

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

Or as a Claude Code plugin, which needs no `PATH` entry and adds a slash command:

```
/plugin marketplace add poisons77/cc-account
/plugin install cc-account@cc-account
```

Restart the session; commands are enumerated at startup. Claude Code namespaces every plugin
command as `/<plugin>:<command>`, so the command is `/cc-account:cc-account`:

```
/cc-account:cc-account              list snapshots
/cc-account:cc-account rotate       switch to the account left longest ago
/cc-account:cc-account personal     switch to that account
/cc-account:cc-account current      re-sync identity after a manual /login
/cc-account:cc-account renew work   sign that account in again through the browser
```

The plugin also checks every saved login when a session starts, and names any that expire within
three days.

With the npm install, a command file of your own gives the shorter `/cc-account`, in every project.
Save this as `~/.claude/commands/cc-account.md`:

````markdown
---
description: Switch the active Claude Code account, rotate to the next one, renew a login, or show which is in use
argument-hint: "[rotate | current | renew account-name | account-name]"
allowed-tools: Bash(cc-account:*)
---

Arguments given: `$1` `$2`

Run exactly one command, matching the first case that applies, then report its output verbatim:

- `$1` is empty: `cc-account list`
- `$1` is `rotate`: `cc-account rotate`
- `$1` is `current`: `cc-account current`
- `$1` is `renew`: `cc-account renew $2`, with a 10-minute timeout. It opens a browser and waits for
  the sign-in, so say a browser window is opening first.
- `$1` is anything else, treat it as an account name: `cc-account use $1`

Report the resulting account and nothing more.
````

Commands outside a plugin carry no namespace, which is what shortens the name. It calls `cc-account`
on `PATH`, so it needs the npm install rather than the plugin one.

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

From then on, switching needs no browser:

```console
$ cc-account use personal
```

## Logins expire

Every Claude Code login carries a date after which it stops refreshing, and a snapshot is that
login. A login lasts 30 days, and refreshing keeps the date, so only signing in again moves it.
`list` shows it for every account, and `use`, `rotate`, `list` and `check` name each login due
within three days:

```console
$ cc-account use work
Now on 'work'  ->  me@company.com [max]
! 'personal' login expires in 2d. Renew it now? A browser window opens.
  1: Renew    2: Not now    0: Leave the rest
  >
```

The question appears only in a terminal. Run from a script or a scheduled task, the warning line
stands alone.

`renew` signs one account in again without disturbing the live session:

![cc-account renew personal: Chrome opens to sign in as me@example.com, the login succeeds, and the
account is renewed and made live](docs/images/renew.svg)

1. The login runs in a throwaway config directory, so the live account is untouched while it waits.
2. The sign-in page opens in a private window, with the account's email already filled in. A private
   window holds no claude.ai session, so it signs in the account asked for rather than whichever one
   the everyday browser is logged in to.
3. The result is kept only when `claude auth status` reports the snapshot's own email. Any other
   account is discarded and the snapshot stays as it was.
4. Renewing the live account makes the new login live as well.

A browser profile that stays signed in to one account turns the sign-in into a single click. Give
that account the profile once:

```console
$ cc-account browser work "C:\Program Files\Google\Chrome\Application\chrome.exe" --profile-directory="Profile 2"
$ cc-account browser work --reset      # back to a private window
```

The plugin runs `cc-account check --hook` when a session starts. With the npm install, the same
warning comes from a hook in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup", "hooks": [{ "type": "command", "command": "cc-account check --hook" }] }
    ]
  }
}
```

## Commands

| Command | Effect |
|---|---|
| `save [name]` | Snapshot the logged-in account. Name defaults to the email local part. |
| `use <name>` | Switch. Re-snapshots the outgoing account first. |
| `rotate` | Switch to the account switched away from longest ago. |
| `list` | Show snapshots and when each login expires; `*` marks the active one. |
| `current` | Show who is logged in now, and re-publish it after a manual `/login`. |
| `renew <name>` | Sign that account in again through the browser, resetting its expiry. |
| `browser <name> [command]` | Set the browser `renew` opens for that account; no command shows it, `--reset` returns to a private window. |
| `check` | Name the logins that expire within three days. `--hook` prints it as SessionStart hook output. |
| `--creds-only` | Swap tokens only, leaving `oauthAccount` untouched. |

`rotate`, `current` and `renew` cannot be used as account names. `save` refuses them, so the
`/cc-account` slash command can treat them as subcommands without ever hiding an account.

`save` also refuses a name whose snapshot already holds a different email, so one account's token
never lands under another account's name.

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
    meta.json            email, plan, authMethod, savedAt, browser
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
is written but untested, and `renew` is not available on macOS: the login it runs would write to the
shared Keychain rather than to its throwaway directory.

## Licence

MIT. See [LICENSE](LICENSE).

Not affiliated with Anthropic. "Claude" and "Claude Code" are trademarks of their respective owner.
