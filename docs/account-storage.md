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

`~/.claude.json` holds far more than the account — `userID`, MCP server state, per-project history.
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
    meta.json            email, plan, authMethod, savedAt
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

## Which accounts can be switched

| Mode | Login | Identity lives in | Switchable |
|---|---|---|---|
| Subscription | `claude auth login --claudeai` | the two locations above | yes |
| Console / API billing | `claude auth login --console` | the same two locations | yes |
| Raw API key | `ANTHROPIC_API_KEY` / `apiKeyHelper` | environment or `settings.json` | nothing to swap |

Raw API keys need no tool — switching one is a shell variable. cc-account exists to replay OAuth
tokens, which cannot be retyped.

## Security

Snapshots are live credentials in plain form. Keep `~/.claude-accounts/` out of synced folders,
backups, and repositories.

Logging out of an account on the web **does not revoke a stored refresh token**: a snapshot taken
beforehand still authenticates. Delete the snapshot directory to retire an account from this machine.
