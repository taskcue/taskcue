// What the server and the page share. The page never sees an agent's own wire format: each adapter
// (server/agents/<agent>/) translates its agent's events into these types, and nothing else.

/** An agent Agentyard can drive. New agents add an id here and an adapter in server/agents/. */
export type AgentId = 'claude' | 'codex';

/** How much a session may do without asking. Each adapter maps these onto its agent's own settings. */
export type PermissionMode = 'ask' | 'auto-edit' | 'full';

export const PERMISSION_MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask first', hint: 'The agent asks before it edits files or runs commands.' },
  { id: 'auto-edit', label: 'Edit freely', hint: 'Edits inside the project go ahead; other actions ask.' },
  { id: 'full', label: 'Full access', hint: 'Nothing asks. Use only in a folder you trust the agent with.' },
];

export interface AgentInfo {
  id: AgentId;
  name: string;
  /** The binary Agentyard found, or null when the agent isn't installed. */
  path: string | null;
  version: string | null;
  /** Where to get it when it isn't installed. */
  installHint: string;
  /** Models the person can pick by name; empty means "the agent's own default only". */
  models: { id: string; label: string }[];
}

/** One entry in a session's conversation, already in Agentyard's own shape. */
export type Item =
  | { id: string; kind: 'user'; text: string; at?: number }
  | { id: string; kind: 'assistant'; text: string; at?: number }
  | { id: string; kind: 'thinking'; text: string; at?: number }
  | {
      id: string;
      kind: 'tool';
      /** The tool as the agent names it: Bash, Write, commandExecution, fileChange… */
      name: string;
      /** One line saying what it does: the command, the file, the search. */
      summary: string;
      /** Its result, cut to a readable length. */
      output?: string;
      status: 'running' | 'done' | 'failed';
      at?: number;
    }
  | { id: string; kind: 'notice'; text: string; tone: 'info' | 'error'; at?: number };

export type SessionState = 'starting' | 'working' | 'waiting' | 'idle' | 'stopped' | 'error';

/** An agent asking the person before it acts. */
export interface Approval {
  id: string;
  sessionId: string;
  /** What it wants to do, in one line: "Run ls", "Write hello.txt". */
  title: string;
  /** The command, the diff or the input, shown under the title. */
  detail: string;
  /** Whether "Allow for this session" is on offer. */
  canAllowForSession: boolean;
}

export type ApprovalDecision = 'allow' | 'allow-session' | 'deny';

export interface SessionSummary {
  id: string;
  agent: AgentId;
  /** The agent's own id for the conversation (Claude's session id, Codex's thread id). */
  nativeId: string | null;
  cwd: string;
  title: string;
  model: string | null;
  permission: PermissionMode;
  state: SessionState;
  /** True while Agentyard runs the agent for it; false for history only. */
  live: boolean;
  createdAt: number;
  updatedAt: number;
  /** True for sessions found in the agent's own history rather than started here. */
  external: boolean;
}

export interface Project {
  path: string;
  name: string;
  /** False when the folder no longer exists. */
  exists: boolean;
}

/** One message on the server's event stream (GET /api/events). */
export type ServerEvent =
  | { type: 'hello'; sessions: SessionSummary[]; projects: Project[]; approvals: Approval[] }
  | { type: 'session'; session: SessionSummary }
  | { type: 'session-removed'; id: string }
  | { type: 'item'; sessionId: string; item: Item }
  | { type: 'draft'; sessionId: string; text: string }
  | { type: 'approval'; approval: Approval }
  | { type: 'approval-resolved'; sessionId: string; id: string }
  | { type: 'projects'; projects: Project[] };

export interface StartRequest {
  agent: AgentId;
  cwd: string;
  text: string;
  model?: string | null;
  permission: PermissionMode;
}
