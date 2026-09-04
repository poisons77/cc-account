import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Keychain service Claude Code stores its token blob under on macOS. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const SECURITY = '/usr/bin/security';

export const usesKeychain = () => process.platform === 'darwin';

/**
 * Read the raw credential blob. Never parsed - it is a token bundle, and
 * round-tripping it through JSON risks dropping fields we do not know about.
 */
export function readCredentials(paths) {
  if (usesKeychain()) {
    try {
      return execFileSync(SECURITY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
        encoding: 'utf8',
      }).trimEnd();
    } catch {
      return null;
    }
  }
  try {
    return fs.readFileSync(paths.credentialsFile, 'utf8');
  } catch {
    return null;
  }
}

/** The Keychain item's account attribute, needed to overwrite the right entry. */
function keychainAccount() {
  try {
    const out = execFileSync(SECURITY, ['find-generic-password', '-s', KEYCHAIN_SERVICE], {
      encoding: 'utf8',
    });
    const match = out.match(/"acct"<blob>="([^"]*)"/);
    if (match) return match[1];
  } catch {
    /* fall through to the login name */
  }
  return process.env.USER ?? '';
}

/**
 * Replace the stored credentials. A live session re-reads them on its next API
 * call, so the write must never be observable half-finished.
 */
export function writeCredentials(paths, blob) {
  if (usesKeychain()) {
    execFileSync(SECURITY, [
      'add-generic-password',
      '-U', // update in place, atomic from a reader's point of view
      '-s', KEYCHAIN_SERVICE,
      '-a', keychainAccount(),
      '-w', blob,
    ]);
    return;
  }

  fs.mkdirSync(path.dirname(paths.credentialsFile), { recursive: true });
  const tmp = `${paths.credentialsFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, blob, { mode: 0o600 });
  fs.renameSync(tmp, paths.credentialsFile);
}
