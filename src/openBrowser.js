// Claude Code runs this as BROWSER during `cc-account renew`, with the sign-in URL as its argument.
// Exiting non-zero leaves Claude Code's own fallback in charge: it prints the URL to open by hand.
import { spawn } from 'node:child_process';

import { BROWSER_COMMAND_ENV } from './browser.js';

const [url] = process.argv.slice(2);
const [exe, ...args] = JSON.parse(process.env[BROWSER_COMMAND_ENV] || '[]');
if (!url || !exe) process.exit(1);

// Detached, so a browser that stays open does not keep this process, or the login, waiting.
spawn(exe, [...args, url], { detached: true, stdio: 'ignore' })
  .on('error', () => {
    process.exitCode = 1;
  })
  .unref();
