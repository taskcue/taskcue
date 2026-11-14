// OpenAI's Codex, driven through `codex app-server` (JSON-RPC over stdio): the same binary,
// ChatGPT or API-key sign-in, config.toml, AGENTS.md and MCP servers as the Codex CLI.
// TaskCue never reads Codex's credentials.
//
// Protocol (codex-cli 0.167, captured in test/fixtures/codex-app-server.jsonl):
//   initialize → initialized → thread/start | thread/resume → turn/start (turn/steer while one runs)
//   notifications: turn/started, item/started, item/agentMessage/delta, item/completed, turn/completed,
//                  thread/status/changed, serverRequest/resolved, error
//   server requests: item/commandExecution/requestApproval, item/fileChange/requestApproval

import { randomUUID } from 'node:crypto';
import type { AgentInfo, ApprovalDecision, PermissionMode } from '../../../shared/types.ts';
import type { AgentAdapter, LiveSession, NativeSession, SessionSink, StartOptions } from '../types.ts';
import { findBinary, titleFrom, versionOf } from '../process.ts';
import { bareCommand, codexItem, threadItems } from './normalize.ts';
import { CodexRpc } from './rpc.ts';

const VERSION = '0.1.0';

const POLICIES: Record<PermissionMode, { approvalPolicy: string; sandbox: string }> = {
  ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  'auto-edit': { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  full: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
};

export function codexBinary(): string | null {
  return findBinary([
    process.env.TASKCUE_CANVAS_CODEX_BIN,
    'codex',
    // The ChatGPT desktop app for macOS ships the Codex CLI inside it.
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  ]);
}

interface PendingApproval {
  rpcId: number | string;
  kind: 'command' | 'file';
  available: unknown[] | null;
  resolve(result: unknown): void;
}

class CodexSession implements LiveSession {
  private rpc: CodexRpc;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private drafts = new Map<string, string>();
  private started = new Map<string, any>();
  private approvals = new Map<string, PendingApproval>();
  private stopping = false;
  readonly ready: Promise<void>;

  constructor(bin: string, private o: StartOptions, private sink: SessionSink) {
    this.rpc = new CodexRpc(bin, o.cwd, {
      notification: (method, params) => this.onNotification(method, params),
      request: (method, params, id) => this.onRequest(method, params, id),
      exit: (error) => {
        for (const id of this.approvals.keys()) sink.approvalGone(id);
        this.approvals.clear();
        sink.draft('');
        sink.working(false);
        sink.exited(this.stopping ? null : error);
      },
    });
    this.ready = this.open();
  }

  private async open(): Promise<void> {
    await this.rpc.initialize(VERSION);
    const policy = POLICIES[this.o.permission];
    const params = { cwd: this.o.cwd, model: this.o.model || null, ...policy };
    const r: any = this.o.resumeId
      ? await this.rpc.request('thread/resume', { threadId: this.o.resumeId, ...params, excludeTurns: true })
      : await this.rpc.request('thread/start', params);
    this.threadId = r.thread.id;
    this.sink.nativeId(r.thread.id);
    if (r.model) this.sink.model(r.model);
  }

  async send(text: string): Promise<void> {
    await this.ready;
    const input = [{ type: 'text', text, text_elements: [] }];
    this.sink.working(true);
    if (this.turnId) {
      await this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input });
      return;
    }
    await this.rpc.request('turn/start', { threadId: this.threadId, input });
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) return;
    await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }

  answer(approvalId: string, decision: ApprovalDecision): void {
    const p = this.approvals.get(approvalId);
    if (!p) return;
    this.approvals.delete(approvalId);
    const offered = (d: string) => !p.available || p.available.includes(d);
    let choice: string;
    if (decision === 'allow') choice = 'accept';
    else if (decision === 'allow-session') choice = offered('acceptForSession') ? 'acceptForSession' : 'accept';
    else choice = offered('decline') ? 'decline' : 'cancel';
    p.resolve({ decision: choice });
    this.sink.approvalGone(approvalId);
  }

  stop(): void {
    this.stopping = true;
    this.rpc.close();
  }

  private onNotification(method: string, p: any): void {
    if (p?.threadId && this.threadId && p.threadId !== this.threadId) return;
    switch (method) {
      case 'turn/started':
        this.turnId = p.turn?.id ?? null;
        this.sink.working(true);
        return;
      case 'turn/completed':
        this.turnId = null;
        this.drafts.clear();
        this.sink.draft('');
        this.sink.working(false);
        if (p.turn?.status === 'failed' && p.turn.error?.message) {
          this.sink.item({ id: `${p.turn.id}:error`, kind: 'notice', tone: 'error', text: p.turn.error.message, at: Date.now() });
        }
        return;
      case 'item/started': {
        this.started.set(p.item?.id, p.item);
        const it = codexItem(p.item, this.o.cwd);
        // Messages show once whole; their text streams as a draft meanwhile.
        if (it && it.kind === 'tool') this.sink.item(it);
        return;
      }
      case 'item/completed': {
        this.started.delete(p.item?.id);
        if (p.item?.type === 'agentMessage') {
          this.drafts.delete(p.item.id);
          this.sink.draft('');
        }
        const it = codexItem(p.item, this.o.cwd);
        if (it) this.sink.item(it);
        return;
      }
      case 'item/agentMessage/delta': {
        const text = (this.drafts.get(p.itemId) ?? '') + p.delta;
        this.drafts.set(p.itemId, text);
        this.sink.draft(text);
        return;
      }
      case 'serverRequest/resolved': {
        const id = String(p.requestId);
        for (const [key, a] of this.approvals) {
          if (String(a.rpcId) === id) {
            this.approvals.delete(key);
            this.sink.approvalGone(key);
          }
        }
        return;
      }
      case 'error':
        if (!p.willRetry && p.error?.message) {
          this.sink.item({ id: `error-${randomUUID()}`, kind: 'notice', tone: 'error', text: p.error.message, at: Date.now() });
        }
        return;
      default:
        return;
    }
  }

  private onRequest(method: string, p: any, rpcId: number | string): Promise<unknown> | undefined {
    if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') return undefined;
    const id = `codex-${rpcId}-${randomUUID().slice(0, 8)}`;
    return new Promise((resolve) => {
      if (method === 'item/commandExecution/requestApproval') {
        const command = bareCommand(String(p.command ?? ''));
        this.approvals.set(id, { rpcId, kind: 'command', available: Array.isArray(p.availableDecisions) ? p.availableDecisions : null, resolve });
        this.sink.approval({
          id,
          title: `Run: ${command.split('\n')[0]}`,
          detail: [p.reason, command, p.cwd ? `in ${p.cwd}` : ''].filter(Boolean).join('\n\n'),
          canAllowForSession: !Array.isArray(p.availableDecisions) || p.availableDecisions.includes('acceptForSession'),
        });
      } else {
        const item = codexItem(this.started.get(p.itemId), this.o.cwd);
        const summary = item && item.kind === 'tool' ? item.summary : 'files';
        this.approvals.set(id, { rpcId, kind: 'file', available: null, resolve });
        this.sink.approval({
          id,
          title: `Edit: ${summary}`,
          detail: [p.reason, item && item.kind === 'tool' ? item.output : ''].filter(Boolean).join('\n\n'),
          canAllowForSession: true,
        });
      }
    });
  }
}

/**
 * One app-server kept for reading history, listing threads and models, closed after a minute idle.
 * Live sessions each get their own process, so stopping one never touches another.
 */
class Utility {
  private rpc: CodexRpc | null = null;
  private ready: Promise<CodexRpc> | null = null;
  private timer: NodeJS.Timeout | null = null;

  async call<T>(method: string, params: unknown): Promise<T> {
    const bin = codexBinary();
    if (!bin) throw new Error('Codex is not installed on this computer.');
    if (!this.ready) {
      const rpc = new CodexRpc(bin, process.cwd(), {
        exit: () => {
          if (this.rpc === rpc) {
            this.rpc = null;
            this.ready = null;
          }
        },
      });
      this.rpc = rpc;
      this.ready = rpc.initialize(VERSION).then(() => rpc);
      this.ready.catch(() => {
        this.rpc = null;
        this.ready = null;
      });
    }
    const rpc = await this.ready;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      rpc.close();
      this.rpc = null;
      this.ready = null;
    }, 60_000);
    this.timer.unref();
    return rpc.request<T>(method, params);
  }

  close(): void {
    this.rpc?.close();
    this.rpc = null;
    this.ready = null;
  }
}

const utility = new Utility();
let modelsCache: { id: string; label: string }[] | null = null;

export const codex: AgentAdapter & { closeUtility(): void } = {
  id: 'codex',
  name: 'Codex',

  async detect(): Promise<AgentInfo> {
    const path = codexBinary();
    if (path && !modelsCache) {
      try {
        const r: any = await utility.call('model/list', {});
        modelsCache = (r.data ?? []).filter((m: any) => !m.hidden).map((m: any) => ({ id: m.model ?? m.id, label: m.displayName ?? m.id }));
      } catch {
        modelsCache = [];
      }
    }
    return {
      id: 'codex',
      name: 'Codex',
      path,
      version: path ? await versionOf(path) : null,
      installHint: 'Install the Codex CLI (`npm install -g @openai/codex`) and sign in with `codex login`.',
      models: modelsCache ?? [],
    };
  },

  async start(options: StartOptions, sink: SessionSink): Promise<LiveSession> {
    const bin = codexBinary();
    if (!bin) throw new Error('Codex is not installed on this computer.');
    const s = new CodexSession(bin, options, sink);
    try {
      await s.ready;
    } catch (err) {
      s.stop();
      throw err;
    }
    return s;
  },

  async history(nativeId: string): Promise<ReturnType<typeof threadItems>> {
    const r: any = await utility.call('thread/read', { threadId: nativeId, includeTurns: true });
    return threadItems(r.thread);
  },

  async recent(limit: number): Promise<NativeSession[]> {
    if (!codexBinary()) return [];
    const r: any = await utility.call('thread/list', { limit, archived: false });
    return (r.data ?? [])
      .filter((t: any) => typeof t.cwd === 'string')
      .map((t: any) => ({
        nativeId: t.id,
        cwd: t.cwd,
        title: titleFrom(t.name || t.preview || 'Codex thread'),
        updatedAt: (t.updatedAt ?? t.createdAt ?? 0) * 1000,
      }));
  },

  closeUtility(): void {
    utility.close();
  },
};
