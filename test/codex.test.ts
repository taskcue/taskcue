// Codex's adapter, against app-server output captured from the real binary (codex-cli 0.167).

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Item } from '../shared/types.ts';
import { codex } from '../server/agents/codex/index.ts';
import { bareCommand, codexItem, threadItems } from '../server/agents/codex/normalize.ts';
import type { SessionSink } from '../server/agents/types.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = join(here, 'fixtures', 'codex-app-server.jsonl');
const lines = readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const out = lines.filter((e) => e.dir === 'out').map((e) => e.msg);
const CWD = '/tmp/ay-cap-codex';

describe('codexItem', () => {
  it('turns each completed item into Agentyard’s own', () => {
    const items = out.filter((m) => m.method === 'item/completed').map((m) => codexItem(m.params.item, CWD)).filter(Boolean) as Item[];
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    expect(items[2]).toMatchObject({ name: 'Edit', summary: 'hello.txt', status: 'done' });
    expect(items[3]).toMatchObject({ name: 'Shell', summary: 'ls', status: 'done', output: 'hello.txt\n' });
  });

  it('reads a thread back with the same items and ids', () => {
    const read = out.find((m) => m.id === 4 && m.result).result.thread;
    const history = threadItems(read);
    const live = out.filter((m) => m.method === 'item/completed').map((m) => codexItem(m.params.item, CWD)).filter(Boolean) as Item[];
    expect(history.map((i) => i.id)).toEqual(live.map((i) => i.id));
  });

  it('marks a command that exited non-zero as failed', () => {
    expect(codexItem({ type: 'commandExecution', id: 'x', command: 'false', status: 'completed', exitCode: 1 })).toMatchObject({ status: 'failed' });
  });
});

describe('bareCommand', () => {
  it('drops the login shell Codex wraps every command in', () => {
    expect(bareCommand('/bin/zsh -lc ls')).toBe('ls');
    expect(bareCommand(`/bin/bash -lc "printf 'yard\\\\n' > note.txt"`)).toBe(`printf 'yard\\n' > note.txt`);
    expect(bareCommand(`/bin/zsh -lc 'echo '"'"'hi'"'"''`)).toBe(`echo 'hi'`);
    expect(bareCommand('git status')).toBe('git status');
  });
});

describe('a live session, replayed', () => {
  afterEach(() => {
    delete process.env.AGENTYARD_CODEX_BIN;
    delete process.env.REPLAY_FIXTURE;
  });

  it('starts a thread, streams the turn, and raises both approvals', async () => {
    process.env.AGENTYARD_CODEX_BIN = join(here, 'fake', 'replay.mjs');
    process.env.REPLAY_FIXTURE = FIXTURE;
    mkdirSync(CWD, { recursive: true });
    const items = new Map<string, Item>();
    const approvals: string[] = [];
    let nativeId = '';
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    let busy = false;
    const sink: SessionSink = {
      item: (i) => items.set(i.id, i),
      draft: () => undefined,
      nativeId: (id) => (nativeId = id),
      model: () => undefined,
      working: (b) => {
        if (busy && !b) done();
        busy = b;
      },
      approval: (a) => {
        approvals.push(a.title);
        live.answer(a.id, 'allow');
      },
      approvalGone: () => undefined,
      exited: () => undefined,
    };
    const live = await codex.start({ cwd: CWD, permission: 'ask' }, sink);
    await live.send('Create hello.txt and run ls');
    await finished;
    live.stop();
    expect(nativeId).toBe(out.find((m) => m.id === 2).result.thread.id);
    expect(approvals).toEqual(['Edit: hello.txt', 'Run: ls']);
    expect([...items.values()].map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
  });
});
