// Claude Code's own history: one JSON-lines transcript per session under
// <config dir>/projects/<folder slug>/<session id>.jsonl. Read only; TaskCue never writes there.

import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Item } from '../../../shared/types.ts';
import type { NativeSession } from '../types.ts';
import { titleFrom } from '../process.ts';
import { ClaudeNormalizer, collapse } from './normalize.ts';

export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** Claude Code names a project's folder after its path with every character but letters and digits made '-'. */
export function folderSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The transcript of a session: where the slug says, else wherever a folder holds that id (long paths are shortened). */
export async function transcriptPath(sessionId: string, cwd: string): Promise<string | null> {
  const root = join(configDir(), 'projects');
  const direct = join(root, folderSlug(cwd), `${sessionId}.jsonl`);
  if (await exists(direct)) return direct;
  let dirs: string[] = [];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join(root, d, `${sessionId}.jsonl`);
    if (await exists(p)) return p;
  }
  return null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readHistory(sessionId: string, cwd: string): Promise<Item[]> {
  const file = await transcriptPath(sessionId, cwd);
  if (!file) return [];
  const norm = new ClaudeNormalizer(cwd);
  const items: Item[] = [];
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    try {
      items.push(...norm.push(JSON.parse(line)));
    } catch {
      // A line being written as we read it; the next read has it whole.
    }
  }
  return collapse(items);
}

/** The first and last bytes of a file: enough for where it ran, its first prompt and its newest title. */
async function headAndTail(file: string, size: number, span = 65536): Promise<{ head: string; tail: string }> {
  const fh = await open(file, 'r');
  try {
    const headBuf = Buffer.alloc(Math.min(span, size));
    await fh.read(headBuf, 0, headBuf.length, 0);
    let tail = '';
    if (size > span) {
      const tailBuf = Buffer.alloc(Math.min(span, size - span));
      await fh.read(tailBuf, 0, tailBuf.length, size - tailBuf.length);
      tail = tailBuf.toString('utf8');
    }
    return { head: headBuf.toString('utf8'), tail };
  } finally {
    await fh.close();
  }
}

function lines(text: string): any[] {
  const out: any[] = [];
  for (const l of text.split('\n')) {
    if (!l.startsWith('{')) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // Cut off at the edge of the span.
    }
  }
  return out;
}

/** Where a transcript ran and what to call it, from its head and tail. */
export function describe(head: string, tail: string): { cwd: string | null; title: string } {
  const all = [...lines(head), ...lines(tail)];
  const cwd = all.find((m) => typeof m.cwd === 'string')?.cwd ?? null;
  let custom = '';
  let ai = '';
  for (const m of all) {
    if (m.type === 'custom-title' && m.customTitle) custom = m.customTitle;
    if (m.type === 'ai-title' && m.aiTitle) ai = m.aiTitle;
  }
  if (custom || ai) return { cwd, title: custom || ai };
  const norm = new ClaudeNormalizer();
  for (const m of lines(head)) {
    const first = norm.push(m).find((i) => i.kind === 'user');
    if (first && first.kind === 'user') return { cwd, title: titleFrom(first.text) };
  }
  return { cwd, title: 'Claude Code session' };
}

/** The newest transcripts across every project, described. */
export async function recentTranscripts(limit: number): Promise<NativeSession[]> {
  const root = join(configDir(), 'projects');
  let dirs: string[] = [];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }
  // A long-time user has tens of thousands of transcripts. A folder's own time changes when a session
  // starts in it, so the most recently changed folders hold the recent sessions: only those are read.
  const stamped: { d: string; mtime: number }[] = [];
  for (const d of dirs) {
    try {
      stamped.push({ d, mtime: (await stat(join(root, d))).mtimeMs });
    } catch {
      // Removed while listing.
    }
  }
  stamped.sort((a, b) => b.mtime - a.mtime);
  const files: { file: string; id: string; mtime: number; size: number }[] = [];
  for (const { d } of stamped.slice(0, Math.max(limit * 4, 100))) {
    let names: string[] = [];
    try {
      names = await readdir(join(root, d));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = join(root, d, n);
      try {
        const s = await stat(file);
        files.push({ file, id: n.slice(0, -'.jsonl'.length), mtime: s.mtimeMs, size: s.size });
      } catch {
        // Removed while listing.
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: NativeSession[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const { head, tail } = await headAndTail(f.file, f.size);
    const { cwd, title } = describe(head, tail);
    // Transcripts with no conversation yet (a session opened and closed) have no cwd line.
    if (!cwd) continue;
    out.push({ nativeId: f.id, cwd, title, updatedAt: f.mtime });
  }
  return out;
}
