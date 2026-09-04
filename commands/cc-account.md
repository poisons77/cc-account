---
description: Switch the active Claude Code account, rotate to the next one, or show which is in use
argument-hint: "[rotate | current | account-name]"
allowed-tools: Bash(node:*)
---

Manage the active Claude Code account with the bundled CLI.

Argument given: `$1`

Run exactly one command, matching the first case that applies, then report its output verbatim:

- `$1` is empty: `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-account.js" list`
- `$1` is `rotate`: `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-account.js" rotate`
- `$1` is `current`: `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-account.js" current`
- `$1` is anything else, treat it as an account name:
  `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-account.js" use $1`

`rotate` and `current` are reserved, so a snapshot named either is reachable only from the CLI.

The switch takes effect on this session's next API call, so no restart is needed.
Report the resulting account and nothing more.
