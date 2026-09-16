---
description: Switch the active Claude Code account, rotate to the next one, renew a login, or show which is in use
argument-hint: "[rotate | current | renew account-name | account-name]"
allowed-tools: Bash(node:*)
---

Manage the active Claude Code account with the bundled CLI.

Arguments given: `$1` `$2`

Run exactly one command, matching the first case that applies, then report its output verbatim:

- `$1` is empty: `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-account.js" list`
- `$1` is `rotate`: `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-account.js" rotate`
- `$1` is `current`: `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-account.js" current`
- `$1` is `renew`: `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-account.js" renew $2`, with a 10-minute timeout.
  It opens a browser for the sign-in and waits for it, so tell the user a browser window is opening
  before you run it.
- `$1` is anything else, treat it as an account name:
  `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-account.js" use $1`

`rotate`, `current` and `renew` are reserved: `cc-account save` refuses them, so no account can carry
a name this command would swallow.

The switch takes effect on this session's next API call, so no restart is needed.
Report the resulting account, and any login it warns is about to expire, and nothing more.
