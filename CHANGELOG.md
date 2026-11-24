# Changelog

Every release since 0.4.0 is also on [GitHub Releases](https://github.com/poisons77/cc-account/releases),
and every release on npm as [`cc-account`](https://www.npmjs.com/package/cc-account). The plugin
carries the same version: `/plugin update cc-account` to get it.

## 0.8.1 - 2026-11-24

**Changed**

- `status` shows a window whose reset has passed as `0%, full again since <time>`, rather than the
  use read before the reset.

## 0.8.0 - 2026-11-16

**New**

- With the plugin, every session that starts or resumes is told the connectors it has from your
  other accounts, by name, and to browse through `chrome-<account>`.
- With the plugin, a session that reaches for Claude Code's own Claude in Chrome while a
  `chrome-<account>` connector is connected is sent to the same tool there, so the browser works
  whichever account is live.

## 0.7.1 - 2026-11-16

**Changed**

- A connector is connected by the name every session shows it under:
  `cc-account connect gmail-work`, or `/cc-account connect gmail-work` in a session, and
  `disconnect gmail-work` to take it out. `connectors` lists those names. They replace 0.7.0's
  `attach work gmail` and `detach work gmail`.

## 0.7.0 - 2026-11-16

**New**

- Every session can use the connectors of any saved account, whichever account is live: its Claude
  in Chrome, its claude.ai connectors (Gmail, Drive, Calendar...) and the HTTP servers added in
  Claude Code. `cc-account attach work gmail` makes it `gmail-work` in every session; `detach` takes
  it out, and `connectors` shows what each account can lend. Needs the npm install.
- The first connector of an account signs in a second login of that account, its lane, in a private
  browser window. It lasts 30 days; `cc-account lane work` renews it, and it is warned about three
  days ahead and in red in its last hour, like any other login.
- A Chrome connector costs a session about 45 MB until the session first uses the browser.
- `/cc-account config` has a Connectors screen per account: a tick beside each attached connector,
  Enter attaches or detaches it.
- Removing an account also takes its connectors out of every session.
- cc-account now makes one read-only request to Anthropic, to list an account's claude.ai
  connectors, and only when connectors are attached or listed afresh.

**Changed**

- The README says how to update the npm install and the plugin, and that cc-pace is updated with
  them.
- The rotation guide uses the global install throughout, the scheduled-task example included.

## 0.6.0 - 2026-11-13

**New**

- `/cc-account config`: limits per account. Under **Limits**, "All accounts" and each account in
  rotation open their own screen; an account's own limit wins, and each row reads "as all accounts"
  until changed. Needs cc-pace 0.7.0 or later.
- "Near" the weekly reset can be 3 days.

**Changed**

- `/cc-account config` works like Claude Code's own menus: one row per setting with its value,
  Enter opens its choices with the current one ticked, Esc goes back a screen and closes the menu
  from the main list.
- Removing an account also removes its own limits.

## 0.5.0 - 2026-11-06

See every account's last reading, and know when rotation stops to ask.

**New**

- `cc-account status` (and `/cc-account status`): each account's last saved use, when each window
  resets, how long ago it was read, and whether rotation would switch into it. Reads the published
  files only, so it starts no `claude` process.
- With cc-pace 0.5.0, when rotation stops on a question - it landed on an account already over its
  limit, or the account it would move to was read too long ago - every session shows it in red above
  the prompt, with a one-time toast, until you pick an account with `/cc-account <name>`. `status`
  and `check --json` carry it too.
- `/cc-account config`: "Ask before switching into an account last read more than" (12h, 1d, 2d,
  3d), and 95% as a choice for the bar near the weekly reset.

**Changed**

- `status` is a reserved account name, like the other subcommands.

## 0.4.0 - 2026-11-01

- Settings menu: `/cc-account config` opens a menu, each change saved at once. `cc-account config`
  and `config set <key> <value>` do the same from a terminal.
- With cc-pace, `rotate` switches to the account cc-pace ranks best; without it, to the account
  switched away from longest ago.
- With cc-pace, `list` shows each account's weekly use and reset, plus a forecast for all accounts
  together.
- With the plugin, every session shows in red when no account has quota left, and says again when
  work can resume. `sessionNotices` turns it off.
- A login in its last hour shows in red in every session, and cc-pace stops rotating onto it.

## 0.3.0 - 2026-10-31

- `add` signs a new account in through a private browser window, leaving the live account logged
  in.
- `remove` deletes a snapshot; the live account cannot be removed.
- `/cc-account` is registered from a hooks module, so it reads `/cc-account` rather than
  `/cc-account:cc-account`.
- `add`, `save` and `remove` keep cc-pace's `rotation.accounts` list in step.

## 0.2.0 - 2026-09-16

- First release on npm: `save`, `use`, `list`, `current` and `rotate`, swapping saved OAuth tokens
  so a switch needs no browser login.
- `renew` signs an account in again before its login expires; `check` and the SessionStart hook warn
  three days ahead.
- The `/cc-account` slash command; its subcommands are refused as account names.
