// Claude Code's messages → Agentyard's items. The same messages arrive two ways: live on the
// stream-json channel, and later in the session's transcript file. Both carry the same `uuid` and
// tool_use ids, so an item read from history and the same item seen live share an id.

import type { Item } from '../../../shared/types.ts';
import { clip, relativePath } from '../process.ts';

/** Strings Claude Code writes into a user turn that the person never typed. */
const NOT_TYPED = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|local-command-caveat)>/;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

function shortPath(p: unknown, cwd: string | null): string {
  return typeof p === 'string' ? relativePath(p, cwd) : '';
}

/** One line saying what a tool call does, from its input. */
export function toolSummary(name: string, input: any, cwd: string | null = null): string {
  if (!input || typeof input !== 'object') return '';
  switch (name) {
    case 'Bash':
      return String(input.command ?? '');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return shortPath(input.file_path ?? input.notebook_path, cwd);
    case 'Grep':
    case 'Glob':
      return String(input.pattern ?? '');
    case 'WebFetch':
      return String(input.url ?? '');
    case 'WebSearch':
      return String(input.query ?? '');
    case 'Task':
    case 'Agent':
      return String(input.description ?? input.prompt ?? '');
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string');
      return typeof first === 'string' ? first : JSON.stringify(input);
    }
  }
}

/** What a tool call would do, for an approval's detail. */
export function toolDetail(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  if (name === 'Bash') return String(input.command ?? '');
  if (name === 'Write') return clip(String(input.content ?? ''), 2000);
  if (name === 'Edit') return clip(`- ${input.old_string ?? ''}\n+ ${input.new_string ?? ''}`, 2000);
  return clip(JSON.stringify(input, null, 2), 2000);
}

/**
 * Turns Claude Code messages into items, in order. Keeps the tool calls it has seen so a
 * tool_result, which arrives in a later user message, can complete the item of its call.
 */
export class ClaudeNormalizer {
  private tools = new Map<string, Extract<Item, { kind: 'tool' }>>();

  constructor(private cwd: string | null = null) {}

  push(msg: any): Item[] {
    if (!msg || (msg.type !== 'assistant' && msg.type !== 'user')) return [];
    if (msg.isMeta || msg.isSidechain || msg.isCompactSummary) return [];
    const at = typeof msg.timestamp === 'string' ? Date.parse(msg.timestamp) : undefined;
    const content = msg.message?.content;
    const base = String(msg.uuid ?? msg.message?.id ?? '');
    const out: Item[] = [];

    if (msg.type === 'user') {
      if (typeof content === 'string') {
        if (!NOT_TYPED.test(content) && content.trim()) out.push({ id: base, kind: 'user', text: content, at });
        return out;
      }
      if (!Array.isArray(content)) return out;
      const typed = content.filter((b: any) => b?.type === 'text' || b?.type === 'image');
      const text = textOf(typed);
      if (text.trim() && !NOT_TYPED.test(text)) out.push({ id: base, kind: 'user', text, at });
      for (const b of content) {
        if (b?.type !== 'tool_result') continue;
        const call = this.tools.get(b.tool_use_id);
        const output = clip(textOf(b.content));
        const done: Item = {
          id: b.tool_use_id,
          kind: 'tool',
          name: call?.name ?? 'Tool',
          summary: call?.summary ?? '',
          output,
          status: b.is_error ? 'failed' : 'done',
          at: call?.at ?? at,
        };
        this.tools.delete(b.tool_use_id);
        out.push(done);
      }
      return out;
    }

    if (!Array.isArray(content)) return out;
    content.forEach((b: any, i: number) => {
      if (b?.type === 'text' && b.text?.trim()) out.push({ id: `${base}:${i}`, kind: 'assistant', text: b.text, at });
      else if (b?.type === 'thinking' && b.thinking?.trim()) out.push({ id: `${base}:${i}`, kind: 'thinking', text: b.thinking, at });
      else if (b?.type === 'tool_use') {
        const item: Extract<Item, { kind: 'tool' }> = {
          id: b.id,
          kind: 'tool',
          name: b.name,
          summary: toolSummary(b.name, b.input, this.cwd),
          status: 'running',
          at,
        };
        this.tools.set(b.id, item);
        out.push(item);
      }
    });
    return out;
  }
}

/** Items in order with later versions of an item replacing earlier ones in place. */
export function collapse(items: Item[]): Item[] {
  const byId = new Map<string, Item>();
  for (const it of items) byId.set(it.id, it);
  return [...byId.values()];
}
