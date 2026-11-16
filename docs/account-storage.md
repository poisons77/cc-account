# What a switch touches

cc-account moves an account by rewriting two locations and deleting two caches. Nothing else on
disk is read or written.

## The two locations

| What | Where |
|---|---|
| OAuth tokens | macOS Keychain, service `Claude Code-credentials`; elsewhere `~/.claude/.credentials.json` |
| Account identity | `~/.claude.json` → `oauthAccount` key |

Both carry the account. Moving only the tokens leaves the previous identity in place, so a switch
always moves both.

`~/.claude.json` holds far more than the account - `userID`, MCP server state, per-project history.
**Only the `oauthAccount` key is replaced.** Everything else in the file is left untouched, which is
why MCP logins survive a switch.

Tokens are written atomically: a temp file and a rename, or a Keychain update in place. A running
session reads either the old set or the new one, never half of each.

## Caches removed

```
~/.claude/daemon-auth-status.json
~/.claude/daemon-auth-cooldown
```

Both cache auth state and would otherwise report the previous account. Claude Code regenerates them.

## `CLAUDE_CONFIG_DIR`

The variable relocates both locations, and cc-account follows it. With the override set,
`.claude.json` lives **inside** that directory; without it, the file sits at the home root while the
rest lives in `~/.claude`.

## Where snapshots live

```
~/.claude-accounts/
  personal/
    .credentials.json    token blob, copied verbatim and never parsed
    oauthAccount.json    identity
    meta.json            email, plan, authMethod, savedAt, browser
    connectors.json      cached list of the account's claude.ai connectors
    lane/                a second login of the account, once a connector is attached
```

`meta.json` is the index. The active account is the one whose email matches
`claude auth status --json`. Set `CC_ACCOUNT_HOME` to keep snapshots elsewhere.

## Snapshots go stale on their own

Claude Code rotates refresh tokens during a session, rewriting `.credentials.json` while you work.
A snapshot older than the last refresh is stranded on a dead token.

`use` therefore re-snapshots the outgoing account before swapping the new one in. Two consequences:

- An account that has never been saved gets a snapshot at that moment, rather than costing a browser
  login later.
- Copying a snapshot directory by hand, or restoring an old one, can hand back a token that no longer
  works. Let `use` manage them.

## Logins expire

The token blob carries `claudeAiOauth.refreshTokenExpiresAt`, the moment the login stops refreshing,
30 days after it was made. A refresh hands out a new refresh token and carries that moment over
unchanged, so a snapshot kept current by `use` still expires on the date its login was created with.
It is the one field cc-account reads out of the blob, to show and warn about expiry; the blob is
still copied verbatim.

`renew` is the only way to move the date:

![The renew flow: the sign-in runs in a throwaway config directory and opens a private browser
window; the new login is kept only when its email matches meta.json, otherwise it is discarded and
the snapshot is left untouched](images/renew-flow.svg)

What it touches:

| What | How |
|---|---|
| A throwaway config directory in the system temp directory | `claude auth login` runs with `CLAUDE_CONFIG_DIR` pointed there; removed when `renew` ends, whatever the outcome, and one left by a killed renew is cleared by the next one |
| The snapshot's three files | replaced only when the new login's email matches `meta.json`. `savedAt` is kept, so a renewal does not change the rotation order |
| The live tokens and `oauthAccount` | replaced only when the renewed account is the live one, and written before the snapshot, so an interrupted renewal leaves the newer login to be picked up by the next switch |

The browser comes from `meta.json` → `browser` when set, and otherwise from the first of Chrome,
Edge and Firefox found installed, opened in a private window. Claude Code starts it through the
`BROWSER` variable. With none found, Claude Code prints the sign-in link to open by hand.

## Lanes and connectors

A lane is a Claude Code config directory of its own, `~/.claude-accounts/<name>/lane/`, holding a
separate browser login of the account. It is never a copy of the snapshot: two copies of one login
would refresh apart and one would end on a dead token. `lane <name>` signs it in, and signing it in
again moves its expiry, 30 days out like any other login. The first `attach` for an account signs it
in, through the same private window and email check as `renew`.

What it touches:

| What | How |
|---|---|
| `<name>/lane/` | Written by Claude Code's own login and token renewal; cc-account never writes a token into it |
| `<name>/connectors.json` | The account's claude.ai connectors, cached by `connectors --refresh` and `attach` |
| `~/.claude.json` → `mcpServers` | One user-scope entry per attached connector, named `<connector>-<name>`, written and removed only through `claude mcp add-json` and `claude mcp remove`. Other entries stay untouched |

`detach` removes one entry. `remove <name>` detaches every connector of the account and deletes its
lane along with the snapshot.

A session starts an attached connector by calling `cc-account`: `cc-account header` prints the
authorization headers of a claude.ai connector or an added server, and `cc-account chrome` starts
Claude in Chrome. Claude Code renews the lane's tokens when its servers connect, and cc-account asks
for that shortly before a token ends.

The one request cc-account makes itself lists an account's claude.ai connectors from Anthropic, read
only, with the lane's token. It runs when connectors are listed afresh or attached, never while a
session works. Everything else is Claude Code's.

## Which accounts can be switched

| Mode | Login | Identity lives in | Switchable |
|---|---|---|---|
| Subscription | `claude auth login --claudeai` | the two locations above | yes |
| Console / API billing | `claude auth login --console` | the same two locations | yes |
| Raw API key | `ANTHROPIC_API_KEY` / `apiKeyHelper` | environment or `settings.json` | nothing to swap |

Raw API keys need no tool - switching one is a shell variable. cc-account exists to replay OAuth
tokens, which cannot be retyped.

## Security

Snapshots are live credentials in plain form. Keep `~/.claude-accounts/` out of synced folders,
backups, and repositories.

Logging out of an account on the web **does not revoke a stored refresh token**: a snapshot taken
beforehand still authenticates. Delete the snapshot directory to retire an account from this machine.

A lane's token is handed to a session only for that account's own connectors, and `header` refuses to
print it when the lane is signed in as any other account, so one account's connector never opens
another's data. The lane directory is live credentials too: the same rules as the snapshot apply.

## Limits

- Lanes are not available on macOS, for the reason `renew` is not: the login would write to the
  shared Keychain.
- Only connectors an account has set up on claude.ai, HTTP servers added in Claude Code, and Claude in
  Chrome are offered. A server defined only in a project's `.mcp.json` is not.
- Attached connectors call `cc-account` by name, so they need the npm install on `PATH`.
