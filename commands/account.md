---
description: Switch the active Claude Code account, or show which one is in use
argument-hint: "[account-name]"
allowed-tools: Bash(node:*)
---

Manage the active Claude Code account with the bundled CLI.

Requested account: `$1`

Run exactly one command, then report its output verbatim:

- No account name given: `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-account.js" list`
- An account name given: `node "${CLAUDE_PLUGIN_ROOT}/bin/cc-account.js" use $1`

The switch takes effect on this session's next API call, so no restart is needed.
Report the resulting account and nothing more.
