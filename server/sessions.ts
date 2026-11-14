// The sessions on the board: the ones Taskcue started (kept in sessions.json), and the recent
// ones each agent keeps in its own history (found, not copied). An agent's own history is the
// record of a conversation; Taskcue only keeps what it needs to draw the board.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { AgentId, Approval, ApprovalDecision, Item, PermissionMode, ServerEvent, SessionSummary, StartRequest } from '../shared/types.ts';
import { adapter, adapters } from './agents/index.ts';
import type { LiveSession, SessionSink } from './agents/types.ts';
import { titleFrom } from './agents/process.ts';
import { readJson, writeJson } from './config.ts';

const FILE = 'sessions.json';
const RECENT_PER_AGENT = 40;

interface Stored {
  sessions: SessionSummary[];
  /** Agent history entries the person took off the board: `${agent}:${nativeId}`. */
  hidden: string[];
}

function externalId(agent: AgentId, nativeId: string): string {
  return `${agent}-${nativeId}`;
}

export class Sessions extends EventEmitter {
  private meta = new Map<string, SessionSummary>();
  private hidden = new Set<string>();
  private live = new Map<string, LiveSession>();
  private items = new Map<string, Map<string, Item>>();
  private approvals = new Map<string, Approval>();
  private external = new Map<string, SessionSummary>();

  constructor() {
    super();
    const stored = readJson<Stored>(FILE, { sessions: [], hidden: [] });
    for (const s of stored.sessions) {
      // Nothing runs after a restart: each conversation stays in its agent's history, resumable.
      this.meta.set(s.id, { ...s, live: false, state: s.state === 'error' ? 'error' : 'stopped' });
    }
    for (const h of stored.hidden ?? []) this.hidden.add(h);
  }

  private save(): void {
    writeJson(FILE, { sessions: [...this.meta.values()], hidden: [...this.hidden] } satisfies Stored);
  }

  private emitEvent(ev: ServerEvent): void {
    this.emit('event', ev);
  }

  list(): SessionSummary[] {
    const known = new Set([...this.meta.values()].map((s) => `${s.agent}:${s.nativeId}`));
    const ext = [...this.external.values()].filter((s) => !known.has(`${s.agent}:${s.nativeId}`) && !this.hidden.has(`${s.agent}:${s.nativeId}`));
    return [...this.meta.values(), ...ext].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  pendingApprovals(): Approval[] {
    return [...this.approvals.values()];
  }

  get(id: string): SessionSummary | undefined {
    return this.meta.get(id) ?? this.external.get(id);
  }

  private update(id: string, patch: Partial<SessionSummary>): void {
    const s = this.meta.get(id);
    if (!s) return;
    const next = { ...s, ...patch, updatedAt: Date.now() };
    this.meta.set(id, next);
    this.save();
    this.emitEvent({ type: 'session', session: next });
  }

  /**
   * Reads each agent's recent history. Called at start and every half minute. Skipped with
   * TASKCUE_CANVAS_HISTORY=0. Sessions that ran inside a hidden folder (a path segment starting with
   * '.', where tools keep their own working copies) only show when that folder is an added project.
   */
  async refreshExternal(added: string[] = []): Promise<void> {
    if (process.env.TASKCUE_CANVAS_HISTORY === '0') return;
    const found = new Map<string, SessionSummary>();
    for (const a of Object.values(adapters)) {
      let recent: Awaited<ReturnType<typeof a.recent>> = [];
      try {
        recent = await a.recent(RECENT_PER_AGENT);
      } catch {
        continue;
      }
      for (const r of recent) {
        if (/\/\.[^/]/.test(r.cwd) && !added.includes(r.cwd)) continue;
        const id = externalId(a.id, r.nativeId);
        found.set(id, {
          id,
          agent: a.id,
          nativeId: r.nativeId,
          cwd: r.cwd,
          title: r.title,
          model: null,
          permission: 'ask',
          state: 'stopped',
          live: false,
          createdAt: r.updatedAt,
          updatedAt: r.updatedAt,
          external: true,
        });
      }
    }
    const changed = found.size !== this.external.size || [...found].some(([id, s]) => this.external.get(id)?.updatedAt !== s.updatedAt || this.external.get(id)?.title !== s.title);
    this.external = found;
    if (changed) for (const s of this.list()) if (s.external) this.emitEvent({ type: 'session', session: s });
  }

  async start(req: StartRequest): Promise<SessionSummary> {
    adapter(req.agent);
    const now = Date.now();
    const s: SessionSummary = {
      id: randomUUID(),
      agent: req.agent,
      nativeId: null,
      cwd: req.cwd,
      title: titleFrom(req.text) || 'New session',
      model: req.model || null,
      permission: req.permission,
      state: 'starting',
      live: true,
      createdAt: now,
      updatedAt: now,
      external: false,
    };
    this.meta.set(s.id, s);
    this.items.set(s.id, new Map());
    this.save();
    this.emitEvent({ type: 'session', session: s });
    await this.run(s.id, null);
    await this.send(s.id, req.text);
    return this.meta.get(s.id)!;
  }

  /** Starts the agent for a session, resuming its conversation when it has one. */
  private async run(id: string, resumeId: string | null, permission?: PermissionMode): Promise<LiveSession> {
    const s = this.meta.get(id)!;
    const sink = this.sink(id);
    try {
      if (!existsSync(s.cwd)) throw new Error(`The folder ${s.cwd} no longer exists, so this session can't run there.`);
      const live = await adapter(s.agent).start({ cwd: s.cwd, permission: permission ?? s.permission, model: s.model, resumeId }, sink);
      this.live.set(id, live);
      this.update(id, { live: true, state: 'idle', ...(permission ? { permission } : {}) });
      return live;
    } catch (err) {
      this.update(id, { live: false, state: 'error' });
      this.addItem(id, { id: `start-${randomUUID()}`, kind: 'notice', tone: 'error', text: (err as Error).message, at: Date.now() });
      throw err;
    }
  }

  private sink(id: string): SessionSink {
    return {
      item: (item) => this.addItem(id, item),
      draft: (text) => this.emitEvent({ type: 'draft', sessionId: id, text }),
      nativeId: (nativeId) => this.update(id, { nativeId }),
      model: (model) => this.update(id, { model }),
      working: (busy) => {
        const s = this.meta.get(id);
        if (!s || !s.live) return;
        const waiting = [...this.approvals.values()].some((a) => a.sessionId === id);
        this.update(id, { state: busy ? (waiting ? 'waiting' : 'working') : 'idle' });
      },
      approval: (a) => {
        const approval: Approval = { ...a, sessionId: id };
        this.approvals.set(a.id, approval);
        this.emitEvent({ type: 'approval', approval });
        this.update(id, { state: 'waiting' });
      },
      approvalGone: (approvalId) => {
        if (!this.approvals.delete(approvalId)) return;
        this.emitEvent({ type: 'approval-resolved', sessionId: id, id: approvalId });
        const s = this.meta.get(id);
        if (s?.state === 'waiting' && ![...this.approvals.values()].some((a) => a.sessionId === id)) this.update(id, { state: 'working' });
      },
      exited: (error) => {
        this.live.delete(id);
        if (error) this.addItem(id, { id: `exit-${randomUUID()}`, kind: 'notice', tone: 'error', text: error, at: Date.now() });
        this.update(id, { live: false, state: error ? 'error' : 'stopped' });
      },
    };
  }

  private addItem(id: string, item: Item): void {
    let map = this.items.get(id);
    if (!map) {
      map = new Map();
      this.items.set(id, map);
    }
    map.set(item.id, item);
    this.emitEvent({ type: 'item', sessionId: id, item });
  }

  /** A session's conversation: what this server has seen, or the agent's own history the first time. */
  async conversation(id: string): Promise<Item[]> {
    const cached = this.items.get(id);
    if (cached && (cached.size > 0 || this.live.has(id))) return [...cached.values()];
    const s = this.get(id);
    if (!s?.nativeId) return [];
    const history = await adapter(s.agent).history(s.nativeId, s.cwd);
    const map = new Map(history.map((i) => [i.id, i] as const));
    // Items that arrived while history was being read stay, after it.
    for (const [k, v] of this.items.get(id) ?? []) map.set(k, v);
    if (this.meta.has(id)) this.items.set(id, map);
    return [...map.values()];
  }

  /** Sends a message, starting (resuming) the agent first when it isn't running. */
  async send(id: string, text: string, permission?: PermissionMode): Promise<void> {
    if (!this.meta.has(id)) this.adopt(id);
    let live = this.live.get(id);
    if (!live) {
      const s = this.meta.get(id)!;
      if (!this.items.has(id) || this.items.get(id)!.size === 0) await this.conversation(id).catch(() => []);
      this.update(id, { state: 'starting' });
      live = await this.run(id, s.nativeId, permission);
    }
    this.update(id, { state: 'working' });
    await live.send(text);
  }

  /** Brings a conversation found in an agent's history onto Taskcue's own list, to continue it here. */
  private adopt(id: string): void {
    const s = this.external.get(id);
    if (!s) throw new Error('No such session');
    this.meta.set(id, { ...s, external: true, updatedAt: Date.now() });
    this.save();
  }

  async interrupt(id: string): Promise<void> {
    await this.live.get(id)?.interrupt();
  }

  answer(sessionId: string, approvalId: string, decision: ApprovalDecision): void {
    const live = this.live.get(sessionId);
    if (!live) throw new Error('That session is no longer running.');
    live.answer(approvalId, decision);
  }

  stop(id: string): void {
    const live = this.live.get(id);
    if (live) live.stop();
    else this.update(id, { live: false, state: 'stopped' });
  }

  /** Takes a session off the board. Its conversation stays in the agent's own history. */
  hide(id: string): void {
    const s = this.get(id);
    if (!s) return;
    this.live.get(id)?.stop();
    if (s.nativeId) this.hidden.add(`${s.agent}:${s.nativeId}`);
    this.meta.delete(id);
    this.items.delete(id);
    this.save();
    this.emitEvent({ type: 'session-removed', id });
  }

  stopAll(): void {
    for (const live of this.live.values()) live.stop();
  }
}
