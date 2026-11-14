// A JSON-RPC client for `codex app-server`, the interface OpenAI's own editor extensions use.
// One JSON object per line on stdio: requests and responses carry an id, notifications don't,
// and the server sends its own requests (approvals) that the client answers by the same id.

import { spawn, type ChildProcess } from 'node:child_process';
import { childEnv, jsonLines } from '../process.ts';

export interface RpcHandlers {
  notification?(method: string, params: any): void;
  /** A request from the server. Return its result, or throw to answer with an error. */
  request?(method: string, params: any, id: number | string): unknown | Promise<unknown>;
  exit?(error: string | null): void;
}

export class CodexRpc {
  readonly proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  private stderr = '';
  private closing = false;

  constructor(bin: string, cwd: string, private handlers: RpcHandlers = {}) {
    this.proc = spawn(bin, ['app-server'], { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    jsonLines(this.proc.stdout!, (m) => void this.onMessage(m));
    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (d: string) => {
      this.stderr = (this.stderr + d).slice(-2000);
    });
    this.proc.on('error', (err) => this.fail(`Codex could not start: ${err.message}`));
    this.proc.on('exit', (code, signal) => {
      this.fail(this.closing ? null : this.stderr.trim() || `Codex exited (${signal ?? `code ${code}`}).`);
    });
  }

  private fail(error: string | null): void {
    for (const p of this.pending.values()) p.reject(new Error(error ?? 'Codex stopped.'));
    this.pending.clear();
    this.handlers.exit?.(error);
    this.handlers.exit = undefined;
  }

  private write(msg: unknown): void {
    if (this.proc.stdin?.writable) this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  /** The handshake every client makes before anything else. */
  async initialize(version: string): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'agentyard', title: 'Agentyard', version }, capabilities: null });
    this.notify('initialized');
  }

  close(): void {
    this.closing = true;
    this.proc.kill('SIGTERM');
    setTimeout(() => {
      if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill('SIGKILL');
    }, 5000).unref();
  }

  private async onMessage(m: any): Promise<void> {
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
      else p.resolve(m.result);
      return;
    }
    if (m.id !== undefined && m.method) {
      try {
        const result = await this.handlers.request?.(m.method, m.params, m.id);
        if (result === undefined) throw new Error(`Agentyard does not handle ${m.method}`);
        this.write({ id: m.id, result });
      } catch (err) {
        this.write({ id: m.id, error: { code: -32601, message: (err as Error).message } });
      }
      return;
    }
    if (m.method) this.handlers.notification?.(m.method, m.params);
  }
}
