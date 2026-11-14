// Claude Code's adapter, against output captured from the real binary (Claude Code 2.1.322).

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Item } from '../shared/types.ts';
import { claude, claudeArgs } from '../server/agents/claude/index.ts';
import { ClaudeNormalizer, collapse } from '../server/agents/claude/normalize.ts';
import { describe as describeTranscript, folderSlug, readHistory } from '../server/agents/claude/transcripts.ts';
import type { SessionSink } from '../server/agents/types.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name: string) => join(here, 'fixtures', name);
const stream = readFileSync(fixture('claude-stream.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const CWD = '/private/tmp/ay-cap-claude';
const SESSION = stream.find((e) => e.msg.type === 'system').msg.session_id as string;

describe('ClaudeNormalizer', () => {
  it('turns the live stream into a tool call per tool_use, completed by its result, and the reply', () => {
    const norm = new ClaudeNormalizer(CWD);
    const items = collapse(stream.filter((e) => e.dir === 'out').flatMap((e) => norm.push(e.msg)));
    expect(items.map((i) => i.kind)).toEqual(['tool', 'tool', 'assistant']);
    const [write, bash] = items as Extract<Item, { kind: 'tool' }>[];
    expect(write).toMatchObject({ name: 'Write', summary: 'hello.txt', status: 'done' });
    expect(bash).toMatchObject({ name: 'Bash', summary: 'ls', status: 'done', output: 'hello.txt' });
  });

  it('skips what Claude Code writes into a user turn that nobody typed', () => {
    const norm = new ClaudeNormalizer();
    expect(norm.push({ type: 'user', uuid: 'a', message: { role: 'user', content: '<command-name>/clear</command-name>' } })).toEqual([]);
    expect(norm.push({ type: 'user', uuid: 'b', isMeta: true, message: { role: 'user', content: 'Caveat' } })).toEqual([]);
    expect(norm.push({ type: 'user', uuid: 'c', message: { role: 'user', content: 'Fix the bug' } })).toEqual([{ id: 'c', kind: 'user', text: 'Fix the bug', at: undefined }]);
  });
});

describe('transcripts', () => {
  const config = mkdtempSync(join(tmpdir(), 'agentyard-claude-'));
  process.env.CLAUDE_CONFIG_DIR = config;
  mkdirSync(join(config, 'projects', folderSlug(CWD)), { recursive: true });
  copyFileSync(fixture('claude-transcript.jsonl'), join(config, 'projects', folderSlug(CWD), `${SESSION}.jsonl`));

  it('names a project folder the way Claude Code does', () => {
    expect(folderSlug('/Users/dev/my app.v2')).toBe('-Users-dev-my-app-v2');
  });

  it('reads history with the same item ids the live stream gave', async () => {
    const history = await readHistory(SESSION, CWD);
    expect(history[0]).toMatchObject({ kind: 'user' });
    const norm = new ClaudeNormalizer(CWD);
    const live = collapse(stream.filter((e) => e.dir === 'out').flatMap((e) => norm.push(e.msg)));
    // Every live item is in history under the same id, so the panel never shows one twice.
    for (const it of live) expect(history.find((h) => h.id === it.id)).toBeTruthy();
  });

  it('finds a transcript by id when its folder name is not the slug', async () => {
    expect((await readHistory(SESSION, '/somewhere/else')).length).toBeGreaterThan(0);
  });

  it('titles a session by its custom title, else its first message', () => {
    const user = JSON.stringify({ type: 'user', uuid: 'u', cwd: '/w', message: { role: 'user', content: 'Add a login page\nmore' } });
    expect(describeTranscript(user, '')).toEqual({ cwd: '/w', title: 'Add a login page' });
    const titled = `${user}\n${JSON.stringify({ type: 'custom-title', customTitle: 'Login page' })}`;
    expect(describeTranscript(titled, '').title).toBe('Login page');
  });
});

describe('claudeArgs', () => {
  it('maps each permission mode onto Claude Code’s own', () => {
    const base = { cwd: '/w', sessionId: 's' };
    expect(claudeArgs({ ...base, permission: 'ask' })).toContain('default');
    expect(claudeArgs({ ...base, permission: 'auto-edit' })).toContain('acceptEdits');
    const full = claudeArgs({ ...base, permission: 'full' });
    expect(full).toContain('bypassPermissions');
    expect(full).toContain('--allow-dangerously-skip-permissions');
  });

  it('resumes by id, or starts with a new one', () => {
    expect(claudeArgs({ cwd: '/w', sessionId: 'new', permission: 'ask', resumeId: 'old' })).toEqual(expect.arrayContaining(['--resume', 'old']));
    expect(claudeArgs({ cwd: '/w', sessionId: 'new', permission: 'ask' })).toEqual(expect.arrayContaining(['--session-id', 'new']));
  });
});

describe('a live session, replayed', () => {
  afterEach(() => {
    delete process.env.AGENTYARD_CLAUDE_BIN;
    delete process.env.REPLAY_FIXTURE;
  });

  it('streams the turn, raises the approval, and finishes once it is answered', async () => {
    process.env.AGENTYARD_CLAUDE_BIN = join(here, 'fake', 'replay.mjs');
    process.env.REPLAY_FIXTURE = fixture('claude-stream.jsonl');
    const items = new Map<string, Item>();
    const approvals: { id: string; title: string }[] = [];
    let idle!: () => void;
    const finished = new Promise<void>((r) => (idle = r));
    let busy = false;
    const sink: SessionSink = {
      item: (i) => items.set(i.id, i),
      draft: () => undefined,
      nativeId: () => undefined,
      model: () => undefined,
      working: (b) => {
        if (busy && !b) idle();
        busy = b;
      },
      approval: (a) => {
        approvals.push(a);
        live.answer(a.id, 'allow');
      },
      approvalGone: () => undefined,
      exited: () => undefined,
    };
    const live = await claude.start({ cwd: CWD, permission: 'ask' }, sink);
    await live.send('Create hello.txt and run ls');
    await finished;
    live.stop();
    expect(approvals.map((a) => a.title)).toEqual(['Write: hello.txt']);
    const kinds = [...items.values()].map((i) => i.kind);
    expect(kinds).toEqual(['user', 'tool', 'tool', 'assistant']);
  });
});
