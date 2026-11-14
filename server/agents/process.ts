// What every adapter needs from the operating system: finding a binary, reading its version,
// a clean environment for the child, and splitting its output into JSON lines.

import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Variables a parent agent session sets for its own children. When Agentyard is started from
 * inside a Claude Code session (a terminal tab, an editor panel, a tool call), passing them on
 * would make every session it starts believe it is a child of that one.
 */
const PARENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_AGENT_SDK_VERSION',
  'AI_AGENT',
  'CODEX_THREAD_ID',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
];

/** Agentyard's own settings, which belong to Agentyard and not to the projects its sessions work in. */
const OWN_VARS = ['PORT', 'NODE_ENV', 'ELECTRON_RUN_AS_NODE'];
const OWN_PREFIX = 'AGENTYARD_';

export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of [...PARENT_SESSION_VARS, ...OWN_VARS]) delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith(OWN_PREFIX)) delete env[k];
  return env;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first candidate that exists and runs: an explicit path, else a name looked up on PATH. */
export function findBinary(candidates: (string | null | undefined)[]): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const c of candidates) {
    if (!c) continue;
    if (c.includes('/') || c.includes('\\')) {
      if (executable(c)) return c;
      continue;
    }
    for (const d of dirs) {
      const p = join(d, c);
      if (executable(p)) return p;
    }
  }
  return null;
}

/** `<bin> --version`'s first line, or null when it won't say within five seconds. */
export function versionOf(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000, env: childEnv() }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout).trim().split('\n')[0] || null);
    });
  });
}

/** Calls `onLine` with each JSON object a stream writes, one per line. Lines that aren't JSON go to `onOther`. */
export function jsonLines(stream: Readable, onLine: (msg: any) => void, onOther?: (line: string) => void): void {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        onOther?.(line);
        continue;
      }
      onLine(msg);
    }
  });
}

/** Cuts long tool output for display; the agent's own history keeps the whole of it. */
export function clip(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… ${text.length - max} more characters`;
}

/** A path inside the session's folder, shown relative to it. macOS names /tmp and /var with or without /private. */
export function relativePath(path: string, cwd: string | null): string {
  if (!cwd) return path;
  const roots = new Set([cwd, cwd.replace(/^\/private(?=\/)/, ''), `/private${cwd}`]);
  for (const root of roots) if (path.startsWith(root + '/')) return path.slice(root.length + 1);
  return path;
}

/** A title from a first message: its first line, cut at a word near 80 characters. */
export function titleFrom(text: string, max = 80): string {
  const line = text.trim().split('\n')[0].trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}
