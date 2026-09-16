import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePaths } from '../src/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.join(here, 'fixtures', 'fake-claude.js');
export const recordArgs = path.join(here, 'fixtures', 'record-args.js');

/**
 * Put a fake `claude` on PATH. On Windows it has to be a .cmd, which is the
 * shape execFileSync cannot spawn directly - so this also exercises the
 * shell fallback in authStatus rather than working around it.
 */
function installShim(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const shim = path.join(dir, 'claude.cmd');
    fs.writeFileSync(shim, `@node "${fakeClaude}" %*\r\n`);
    return;
  }
  const shim = path.join(dir, 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec node "${fakeClaude}" "$@"\n`, { mode: 0o755 });
}

/**
 * A throwaway config dir, account store, temp dir and `claude` shim, wired
 * through the environment so nothing touches the real ones. Call restore()
 * when done.
 */
export function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-account-test-'));
  const binDir = path.join(root, 'bin');
  installShim(binDir);

  const saved = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CC_ACCOUNT_HOME: process.env.CC_ACCOUNT_HOME,
    PATH: process.env.PATH,
    FAKE_BROWSER_ACCOUNT: process.env.FAKE_BROWSER_ACCOUNT,
    FAKE_RENEWED_EXPIRY: process.env.FAKE_RENEWED_EXPIRY,
  };

  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'config');
  process.env.CC_ACCOUNT_HOME = path.join(root, 'store');
  process.env.PATH = `${binDir}${path.delimiter}${saved.PATH}`;

  const tmp = path.join(root, 'tmp');
  // No installed browser is a candidate: a renew test must never open a real window.
  const paths = { ...resolvePaths(process.env, root, tmp), privateBrowsers: [] };
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.mkdirSync(tmp);

  return {
    root,
    tmp,
    paths,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Make the sandbox look logged in as `email`, credentials and identity both. */
export function login(paths, email, extra = {}) {
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(
    paths.credentialsFile,
    JSON.stringify({ email, plan: 'max', refreshToken: `token-for-${email}`, ...extra }),
  );
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(paths.configJson, 'utf8'));
  } catch {
    /* first login in this sandbox */
  }
  config.oauthAccount = { emailAddress: email, accountUuid: `uuid-${email}` };
  fs.writeFileSync(paths.configJson, JSON.stringify(config, null, 2));
}

/** Blob fields for a login that stops refreshing `ms` from now. */
export const expiringIn = (ms) => ({ claudeAiOauth: { refreshTokenExpiresAt: Date.now() + ms } });

export function logout(paths) {
  fs.rmSync(paths.credentialsFile, { force: true });
}

export const readFile = (file) => fs.readFileSync(file, 'utf8');
export const readJson = (file) => JSON.parse(readFile(file));
