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

/** Temp file plus rename, so a concurrent reader sees old or new, never half. */
export function writeJsonAtomic(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}
