// Claude Code, driven through the installed `claude` binary's own stream-json channel: the same
// binary, login, settings, CLAUDE.md memory, skills, hooks and MCP servers as a terminal session.
// TaskCue never modifies the binary, never reads its credentials, and never uses the Agent SDK.
//
// Protocol (Claude Code 2.1.x, captured in test/fixtures/claude-stream.jsonl):
//   stdin:  {type:"user", uuid, message:{role:"user", content:[…]}, …}
//           {type:"control_request", request_id, request:{subtype:"initialize"|"interrupt"}}
//           {type:"control_response", response:{subtype:"success", request_id, response:{behavior:"allow"|"deny", …}}}
//   stdout: system/init, stream_event (partial text), assistant, user (tool results), result,
//           control_request (subtype can_use_tool: an approval), control_cancel_request, control_response

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentInfo, ApprovalDecision, PermissionMode } from '../../../shared/types.ts';
import type { AgentAdapter, LiveSession, SessionSink, StartOptions } from '../types.ts';
import { childEnv, findBinary, jsonLines, versionOf } from '../process.ts';
import { ClaudeNormalizer, toolDetail, toolSummary } from './normalize.ts';
import { readHistory, recentTranscripts } from './transcripts.ts';

const MODES: Record<PermissionMode, string> = {
  ask: 'default',
  'auto-edit': 'acceptEdits',
  full: 'bypassPermissions',
};

export function claudeBinary(): string | null {
  return findBinary([process.env.TASKCUE_CANVAS_CLAUDE_BIN, 'claude', join(homedir(), '.claude', 'local', 'claude')]);
}

export function claudeArgs(o: StartOptions & { sessionId: string }): string[] {
  const a = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', MODES[o.permission],
  ];
  if (o.permission === 'full') a.push('--allow-dangerously-skip-permissions');
  if (o.resumeId) a.push('--resume', o.resumeId);
  else a.push('--session-id', o.sessionId);
  if (o.model) a.push('--model', o.model);
  return a;
}

interface Pending {
  input: unknown;
  suggestions: unknown[];
}

class ClaudeSession implements LiveSession {
  private proc: ChildProcess;
  private norm: ClaudeNormalizer;
  private draft = '';
  private approvals = new Map<string, Pending>();
  private stopping = false;
  private stderr = '';

  constructor(bin: string, private o: StartOptions, private sink: SessionSink) {
    const sessionId = o.resumeId ?? randomUUID();
    this.norm = new ClaudeNormalizer(o.cwd);
    this.proc = spawn(bin, claudeArgs({ ...o, sessionId }), { cwd: o.cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    sink.nativeId(sessionId);
    jsonLines(this.proc.stdout!, (m) => this.onMessage(m));
    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (d: string) => {
      this.stderr = (this.stderr + d).slice(-2000);
    });
    this.proc.on('error', (err) => sink.exited(`Claude Code could not start: ${err.message}`));
    this.proc.on('exit', (code, signal) => {
      for (const id of this.approvals.keys()) sink.approvalGone(id);
      this.approvals.clear();
      sink.draft('');
      sink.working(false);
      if (this.stopping) sink.exited(null);
      else sink.exited(this.stderr.trim() || `Claude Code exited (${signal ?? `code ${code}`}).`);
    });
    this.write({ type: 'control_request', request_id: `init-${randomUUID()}`, request: { subtype: 'initialize' } });
  }

  private write(msg: unknown): void {
    if (this.proc.stdin?.writable) this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  async send(text: string): Promise<void> {
    const uuid = randomUUID();
    // The transcript keeps this uuid, so the item read back from history is the same item.
    this.sink.item({ id: uuid, kind: 'user', text, at: Date.now() });
    this.sink.working(true);
    this.write({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: '' });
  }

  async interrupt(): Promise<void> {
    this.write({ type: 'control_request', request_id: `interrupt-${randomUUID()}`, request: { subtype: 'interrupt' } });
  }

  answer(approvalId: string, decision: ApprovalDecision): void {
    const p = this.approvals.get(approvalId);
    if (!p) return;
    this.approvals.delete(approvalId);
    const response =
      decision === 'deny'
        ? { behavior: 'deny', message: 'The person declined this in TaskCue.' }
        : {
            behavior: 'allow',
            updatedInput: p.input,
            ...(decision === 'allow-session' && p.suggestions.length ? { updatedPermissions: p.suggestions } : {}),
          };
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: approvalId, response } });
    this.sink.approvalGone(approvalId);
  }

  stop(): void {
    this.stopping = true;
    this.proc.kill('SIGTERM');
    setTimeout(() => {
      if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill('SIGKILL');
    }, 5000).unref();
  }

  private onMessage(m: any): void {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init' && typeof m.model === 'string') this.sink.model(m.model);
        return;
      case 'stream_event': {
        const e = m.event;
        if (m.parent_tool_use_id) return;
        if (e?.type === 'message_start') this.draft = '';
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          this.draft += e.delta.text;
          this.sink.draft(this.draft);
        }
        return;
      }
      case 'assistant':
      case 'user': {
        if (m.parent_tool_use_id) return; // a subagent's own turn
        const items = this.norm.push(m);
        if (m.type === 'assistant' && items.some((i) => i.kind === 'assistant')) {
          this.draft = '';
          this.sink.draft('');
        }
        for (const it of items) this.sink.item(it);
        return;
      }
      case 'result':
        this.draft = '';
        this.sink.draft('');
        this.sink.working(false);
        if (m.subtype && m.subtype !== 'success' && m.terminal_reason !== 'aborted_streaming') {
          const text = Array.isArray(m.errors) && m.errors.length ? m.errors.join('\n') : `The turn ended: ${String(m.subtype).replace(/_/g, ' ')}.`;
          this.sink.item({ id: `result-${m.uuid ?? randomUUID()}`, kind: 'notice', tone: 'error', text, at: Date.now() });
        }
        return;
      case 'control_request':
        return this.onControlRequest(m);
      case 'control_cancel_request':
        if (this.approvals.delete(m.request_id)) this.sink.approvalGone(m.request_id);
        return;
      default:
        return;
    }
  }

  private onControlRequest(m: any): void {
    const r = m.request ?? {};
    if (r.subtype !== 'can_use_tool') {
      // Hook callbacks, SDK MCP servers and elicitations are host features TaskCue does not provide.
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: `TaskCue does not handle ${r.subtype}` } });
      return;
    }
    const suggestions = Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [];
    this.approvals.set(m.request_id, { input: r.input, suggestions });
    const name = r.display_name || r.tool_name;
    const summary = toolSummary(r.tool_name, r.input, this.o.cwd);
    this.sink.approval({
      id: m.request_id,
      title: summary ? `${name}: ${summary.split('\n')[0]}` : name,
      detail: [r.decision_reason, toolDetail(r.tool_name, r.input)].filter(Boolean).join('\n\n'),
      canAllowForSession: suggestions.length > 0,
    });
  }
}

export const claude: AgentAdapter = {
  id: 'claude',
  name: 'Claude Code',

  async detect(): Promise<AgentInfo> {
    const path = claudeBinary();
    return {
      id: 'claude',
      name: 'Claude Code',
      path,
      version: path ? await versionOf(path) : null,
      installHint: 'Install Claude Code (https://code.claude.com) and sign in by running `claude` once.',
      models: [
        { id: 'opus', label: 'Opus' },
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'haiku', label: 'Haiku' },
      ],
    };
  },

  async start(options: StartOptions, sink: SessionSink): Promise<LiveSession> {
    const bin = claudeBinary();
    if (!bin) throw new Error('Claude Code is not installed on this computer.');
    return new ClaudeSession(bin, options, sink);
  },

  history: readHistory,
  recent: recentTranscripts,
};
