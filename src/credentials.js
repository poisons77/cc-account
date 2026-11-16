import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { writeFileAtomic } from './jsonFile.js';

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

  writeFileAtomic(paths.credentialsFile, blob);
}

/**
 * A parsed copy of a blob, for reading one field out of it; null when it is not JSON. Nothing parsed
 * here is ever written back: the blob itself only travels as the original string.
 */
function parseBlob(blob) {
  try {
    return JSON.parse(blob);
  } catch {
    return null;
  }
}

/**
 * An epoch-milliseconds time, or null. Milliseconds are past 1e12 since 2001; a value in seconds
 * would read as 1970 and flag every login as expired, so it counts as unknown instead.
 */
const epochMs = (value) => (Number.isFinite(value) && value > 1e12 ? value : null);

/**
 * When the login behind a blob stops refreshing, in epoch milliseconds, or null when the blob does
 * not say. Refreshing hands out a new refresh token but carries this date over unchanged, so only a
 * browser login moves it.
 */
export function refreshTokenExpiry(blob) {
  return epochMs(parseBlob(blob)?.claudeAiOauth?.refreshTokenExpiresAt);
}

/**
 * The access token a blob holds, with the epoch milliseconds it expires at (null when it does not
 * say), or null when there is none. Without `server` it is the claude.ai login's; with one, the
 * login Claude Code keeps for that MCP server, under an `mcpOAuth` key that starts `<server>|`.
 */
export function accessToken(blob, server) {
  const parsed = parseBlob(blob);
  const entry = server
    ? Object.entries(parsed?.mcpOAuth ?? {}).find(([key]) => key.split('|')[0] === server)?.[1]
    : parsed?.claudeAiOauth;
  if (typeof entry?.accessToken !== 'string' || entry.accessToken === '') return null;
  return { token: entry.accessToken, expiresAt: epochMs(entry.expiresAt) };
}
