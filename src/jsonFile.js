import fs from 'node:fs';
import path from 'node:path';

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function readJsonOr(file, fallback = null) {
  try {
    return readJson(file);
  } catch {
    return fallback;
  }
}

/**
 * The file's JSON, or `fallback` when it does not exist. Any other failure throws: a file that is
 * there but unreadable must not be mistaken for an empty one and written back over.
 */
export function readJsonIfPresent(file, fallback) {
  try {
    return readJson(file);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/** Temp file plus rename, so a concurrent reader sees old or new, never half. */
export function writeFileAtomic(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file, value, mode = 0o600) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}
