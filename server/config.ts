// Taskcue's own state: a folder of small JSON files, never shared with the agents.
//   TASKCUE_DATA_DIR (default ~/.taskcue): settings.json, sessions.json, token
//   TASKCUE_PORT (default 4880)

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const dataDir = process.env.TASKCUE_DATA_DIR || join(homedir(), '.taskcue');
export const port = Number(process.env.TASKCUE_PORT || 4880);

mkdirSync(dataDir, { recursive: true, mode: 0o700 });

export function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(dataDir, name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Writes through a temporary file, so a crash mid-write never leaves half a file. */
export function writeJson(name: string, value: unknown): void {
  const file = join(dataDir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * The secret every API call carries. Taskcue can run agents that run shell commands, so other
 * programs and web pages on this computer must not be able to drive it: the guard checks this
 * token on top of the Host, Origin and Fetch-Metadata checks (server/guard.ts).
 */
export function apiToken(): string {
  const file = join(dataDir, 'token');
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  }
  const t = randomBytes(24).toString('hex');
  writeFileSync(file, t + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return t;
}
