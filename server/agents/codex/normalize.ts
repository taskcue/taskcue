// Codex's thread items → TaskCue's items. Live (item/started, item/completed) and history
// (thread/read) carry the same items with the same ids, so both paths share this one function.

import type { Item } from '../../../shared/types.ts';
import { clip, relativePath } from '../process.ts';

/** `/bin/zsh -lc ls` → `ls`: Codex runs every command through a login shell. */
export function bareCommand(command: string): string {
  const m = /^\S*\/(?:ba|z|)sh\s+-l?c\s+([\s\S]*)$/.exec(command.trim());
  if (!m) return command;
  const c = m[1].trim();
  if (c.length >= 2 && c.startsWith('"') && c.endsWith('"')) return c.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  if (c.length >= 2 && c.startsWith("'") && c.endsWith("'")) return c.slice(1, -1).replace(/'"'"'/g, "'");
  return c;
}

const rel = relativePath;

function status(s: unknown, exitCode?: unknown): 'running' | 'done' | 'failed' {
  if (s === 'inProgress') return 'running';
  if (s === 'completed') return typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'done';
  return 'failed';
}

function inputText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' || c?.type === 'localImage' ? '[image]' : c?.type === 'mention' ? `@${c.name}` : ''))
    .filter(Boolean)
    .join('\n');
}

export function codexItem(item: any, cwd: string | null = null): Item | null {
  if (!item || typeof item.id !== 'string') return null;
  const at = typeof item.startedAtMs === 'number' ? item.startedAtMs : undefined;
  switch (item.type) {
    case 'userMessage': {
      const text = inputText(item.content);
      return text.trim() ? { id: item.id, kind: 'user', text, at } : null;
    }
    case 'agentMessage':
      return item.text?.trim() ? { id: item.id, kind: 'assistant', text: item.text, at } : null;
    case 'reasoning': {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].join('\n').trim();
      return text ? { id: item.id, kind: 'thinking', text, at } : null;
    }
    case 'plan':
      return { id: item.id, kind: 'tool', name: 'Plan', summary: String(item.text ?? '').split('\n')[0], output: item.text, status: 'done', at };
    case 'commandExecution':
      return {
        id: item.id,
        kind: 'tool',
        name: 'Shell',
        summary: bareCommand(String(item.command ?? '')),
        output: item.aggregatedOutput ? clip(item.aggregatedOutput) : undefined,
        status: status(item.status, item.exitCode),
        at,
      };
    case 'fileChange': {
      const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
      return {
        id: item.id,
        kind: 'tool',
        name: 'Edit',
        summary: changes.map((c) => rel(String(c.path), cwd)).join(', '),
        output: changes.length ? clip(changes.map((c) => `${rel(String(c.path), cwd)}\n${c.diff ?? ''}`).join('\n')) : undefined,
        status: status(item.status),
        at,
      };
    }
    case 'mcpToolCall':
      return {
        id: item.id,
        kind: 'tool',
        name: `${item.server}.${item.tool}`,
        summary: item.arguments ? clip(JSON.stringify(item.arguments), 200) : '',
        output: item.error ? clip(JSON.stringify(item.error)) : item.result ? clip(JSON.stringify(item.result)) : undefined,
        status: status(item.status),
        at,
      };
    case 'dynamicToolCall':
      return { id: item.id, kind: 'tool', name: item.tool, summary: item.arguments ? clip(JSON.stringify(item.arguments), 200) : '', status: status(item.status), at };
    case 'webSearch':
      return { id: item.id, kind: 'tool', name: 'Web search', summary: String(item.query ?? item.action?.query ?? ''), status: 'done', at };
    case 'imageView':
      return { id: item.id, kind: 'tool', name: 'View image', summary: rel(String(item.path ?? ''), cwd), status: 'done', at };
    case 'contextCompaction':
      return { id: item.id, kind: 'notice', tone: 'info', text: 'Codex compacted the conversation to save context.', at };
    default:
      return null;
  }
}

/** A thread read with its turns → its items, in order. */
export function threadItems(thread: any): Item[] {
  const cwd = typeof thread?.cwd === 'string' ? thread.cwd : null;
  const out: Item[] = [];
  for (const turn of thread?.turns ?? []) {
    for (const raw of turn.items ?? []) {
      const it = codexItem(raw, cwd);
      if (it) out.push(it);
    }
    if (turn.status === 'failed' && turn.error?.message) {
      out.push({ id: `${turn.id}:error`, kind: 'notice', tone: 'error', text: turn.error.message });
    }
  }
  return out;
}
