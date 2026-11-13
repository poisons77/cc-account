# Automatic rotation

Optional, and split across two tools. [cc-pace](https://github.com/poisons77/cc-pace) watches the
rate-limit windows it already renders in the status line and decides when to move; cc-account
performs the switch and publishes which account is live.

Neither tool needs the other. cc-account switches on demand with no statusline installed; cc-pace
renders usage with one account. The pairing exists because each holds half of what an automatic
switch needs: cc-pace sees the rate-limit windows and cc-account can act on them, say who is now
live, and say until when each login works.

## Install cc-pace

```console
npm install -g claude-code-pace
```

Then point Claude Code's status line at it, in `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "cc-pace", "refreshInterval": 60 } }
```

`cc-pace --setup` prints that snippet. cc-account is installed globally too
(`npm install -g cc-account`): the rotation config names `cc-account` as a command, which has to be
on `PATH`.

Rotation runs when the status line renders, so a status line that is not cc-pace runs no rotation.

## The cheap link

cc-pace can run one command per window when a bucket crosses a percentage, without knowing anything
about accounts. In `~/.config/cc-pace/config.json`:

```json
{
  "onThreshold": { "bucket": "five_hour", "at": 95, "run": "cc-account rotate" }
}
```

`rotate` moves to the account switched away from longest ago, or to the one the rotation engine
ranks best while it runs, so no names appear in the config and
nothing is stored beyond a latch that clears when the window resets. This is the whole integration
for a two-account setup that only needs to get off a spent window.

## The rotation engine

For more than one watched window, a target chosen on evidence, and the outcome shown in the line,
use the `rotation` block instead. Two shapes, depending on how the accounts relate.

**Peers.** Accounts of equal worth. Spend the one you are on down to its bar, then move to whichever
peer has the most room.

```json
{
  "rotation": {
    "accounts": ["work", "personal"],
    "buckets": { "five_hour": 95, "seven_day": { "at": 95, "lateAt": 99, "lateWithinSecs": 129600 } },
    "command": "cc-account"
  }
}
```

**Primary and reserve.** A smaller plan whose 5-hour window fills fast, held next to a larger one
kept back. Burn the primary, move to the fallback when a window runs dry, return the moment it
refills.

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

Account names are cc-account snapshot names, so each must exist - run `cc-account save` once per
account first. `command` is invoked as `<command> use <account>`; `cc-account`, the global install,
is also the default when `command` is left out.

A bucket takes a plain percentage, or `{ "at", "lateAt", "lateWithinSecs" }` to raise the bar as the
reset nears: percent abandoned early in a weekly window is gone for days, while the same percent
just before a refill is nearly worthless.

One account can have limits of its own: in `/cc-account config`, open that account under
**Limits** and pick its bars. Each one reads "as all accounts" until changed, and picking that again
returns it to the shared value. Every other account keeps following the shared limits. In the config file
this is `perAccount`, for example `"perAccount": { "work": { "seven_day": 80 } }`.

The full field list, including per-window thresholds and the return grace period, is in
[cc-pace's rotation guide](https://github.com/poisons77/cc-pace/blob/main/docs/rotation.md).

## Why cc-account publishes identity

The statusline payload carries `session_id`, `cwd`, `model`, `cost`, `context_window` and
`rate_limits` - and **no account identity**. Nothing in it says whose limits are being rendered, so
a status line cannot know which account it is looking at.

cc-account writes the answer on every switch, with the unix second each saved login stops
refreshing, rewritten whenever a snapshot or the live login changes:

```
~/.claude-accounts/rotation-state.json
{ "active": "personal", "email": "…", "switchedAt": 1786412323,
  "logins": { "personal": 1788900000, "work": 1789500000 } }
```

The engine skips an account whose login ends within the hour, the same hour in which cc-account
alerts in red.

## What cc-account reads back

cc-pace publishes its judgement in its own `rotation-state.json`, beside its config, and cc-account
only reads it, for six hours after cc-pace last wrote it:

- `ranking`: every account, best first. `rotate` takes the first eligible one that is not live.
- `forecast`: when the quota of all accounts together runs out at the current burn, shown by `list`.
- `seen`: the last reading of every account and when it was taken, shown by `status`.
- `ask`: the question rotation stopped on - an account already spent when it landed there, or, with
  "Ask before switching into an account last read more than" set, a target read too long ago.

When no ranked account is eligible, every session with the plugin is told so in red, with the
account that frees up first, and told again when one has quota.

When rotation stops to ask, every session with the plugin shows the question in red above the
prompt until an account is picked:

```
! Rotation stopped: 'work' was already at 99% when it switched there. Pick an account with /cc-account <name>; /cc-account status compares them.
```

`/cc-account <name>` switches and answers it; `/cc-account rotate` takes cc-pace's best-ranked
account.

Point cc-pace elsewhere with its `store` field if `CC_ACCOUNT_HOME` moves the snapshots.

## After a manual login

Signing in with `/login` or `claude auth login` changes the account without going through
cc-account, leaving the published identity stale. Re-sync it:

```console
$ cc-account current
```

Run this any time the status line names an account you are not on.

## Rotating without cc-pace

With no ranking to follow, `rotate` switches to the account switched away from longest ago:

```console
$ cc-account rotate
```

For a one-shot return at a known reset time, a scheduled task covers it. On Windows:

```powershell
$tr = '"' + (Get-Command cc-account.cmd).Source + '" use work'
schtasks /Create /TN "cc-account-switchback" /SC ONCE /ST 17:32 /TR $tr /F

schtasks /Query  /TN "cc-account-switchback" /FO LIST /V   # Last Result: 0 means it ran
schtasks /Delete /TN "cc-account-switchback" /F
```

`Get-Command` puts the global install's full path in the task: a scheduled task does not inherit
the interactive `PATH`.
Created this way the task runs only while the user is logged on; add `/RU` and `/RP` for a stored
credential if it must fire from a locked session. The reset time to aim at is the one the status
line already shows.

On Linux and macOS the same job is a `systemd` timer, a `launchd` agent, or an `at` entry.

## Limits

Rotation runs **when the status line renders**. A threshold crossed during a long subagent run is
missed until the next main-loop turn.

With primary and fallback, the engine does not check whether the fallback is worth switching to
before moving. With both accounts near their weekly caps it moves anyway, then reports
`! both limited`. Peers move only to an account the ranking calls eligible.

Two sessions can cross a threshold at the same moment and both fire. The second lands on an
account that is already active and stops without writing.

The cheap link has no ranking, so `rotate` there can land on an account that is spent or whose
login has ended. `cc-account list` shows every expiry; `cc-account renew <name>` resets one.

An account never live since cc-pace started is counted as full in the ranking and the forecast,
until its first turn shows its real use.
