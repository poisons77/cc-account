import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Carries the browser command from `renew`, through Claude Code, to the opener it runs. */
export const BROWSER_COMMAND_ENV = 'CC_ACCOUNT_BROWSER';

const OPENER = fileURLToPath(new URL('./openBrowser.js', import.meta.url));

/**
 * The command `renew` opens the sign-in page with, the URL appended as its last argument: the
 * account's own browser when one is set, else the first installed browser in a private window,
 * else null - and then Claude Code prints the URL to open by hand.
 */
export function browserCommand(paths, meta) {
  if (Array.isArray(meta.browser) && meta.browser.length > 0) return meta.browser;
  return paths.privateBrowsers.find(([exe]) => fs.existsSync(exe)) ?? null;
}

/**
 * Write the executable Claude Code is given as BROWSER. It only starts the opener, which reads the
 * command from the environment, so no part of the command passes through a script's quoting.
 */
export function writeBrowserShim(dir) {
  if (process.platform === 'win32') {
    const shim = path.join(dir, 'browser.cmd');
    fs.writeFileSync(shim, `@"${process.execPath}" "${OPENER}" %*\r\n`);
    return shim;
  }
  const shim = path.join(dir, 'browser');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${OPENER}" "$@"\n`, {
    mode: 0o700,
  });
  return shim;
}
