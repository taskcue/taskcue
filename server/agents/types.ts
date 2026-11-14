// The one interface between Agentyard and an agent. Everything an agent knows about its own
// binary, protocol and history files lives behind it (server/agents/<agent>/); the rest of the
// server and the page only see shared/types.ts. docs/adding-an-agent.md walks through a new one.

import type { AgentId, AgentInfo, ApprovalDecision, Item, PermissionMode } from '../../shared/types.ts';

export interface StartOptions {
  cwd: string;
  permission: PermissionMode;
  model?: string | null;
  /** The agent's own id of a conversation to continue (Claude's session id, Codex's thread id). */
  resumeId?: string | null;
}

/** What an adapter's live session reports. Agentyard keeps state and fans it out to the page. */
export interface SessionSink {
  /** A new or updated item. An item with an id already shown replaces it (a tool's result arriving). */
  item(item: Item): void;
  /** The assistant's reply as it streams; '' clears it once the finished message has arrived as an item. */
  draft(text: string): void;
  /** The agent's own id for the conversation, once known. */
  nativeId(id: string): void;
  /** The model the agent says it runs. */
  model(model: string): void;
  /** Busy with a turn, or done with it. */
  working(busy: boolean): void;
  /** The agent asks before acting. Agentyard calls back `answer` with the same id. */
  approval(a: { id: string; title: string; detail: string; canAllowForSession: boolean }): void;
  /** An approval the agent withdrew or that was answered elsewhere. */
  approvalGone(id: string): void;
  /** The process ended. `error` says why when it wasn't asked to stop. */
  exited(error: string | null): void;
}

export interface LiveSession {
  /** Sends the person's message. Starts a turn, or adds to the one under way where the agent allows it. */
  send(text: string): Promise<void>;
  /** Stops the turn under way; the session stays open. */
  interrupt(): Promise<void>;
  /** Answers an approval the session raised. */
  answer(approvalId: string, decision: ApprovalDecision): void;
  /** Ends the process. The conversation stays in the agent's own history and can be resumed. */
  stop(): void;
}

/** A conversation the agent keeps in its own history, found without running it. */
export interface NativeSession {
  nativeId: string;
  cwd: string;
  title: string;
  updatedAt: number;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly name: string;
  /** Finds the agent's binary and version. Cheap enough to call on every page load. */
  detect(): Promise<AgentInfo>;
  /** Starts a session (or resumes one by `resumeId`), reporting through `sink`. */
  start(options: StartOptions, sink: SessionSink): Promise<LiveSession>;
  /** A conversation's items, read from the agent's own history. */
  history(nativeId: string, cwd: string): Promise<Item[]>;
  /** Recent conversations in the agent's own history, newest first. */
  recent(limit: number): Promise<NativeSession[]>;
}
