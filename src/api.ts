// The page's side of the API. The token comes from the address the server prints
// (http://127.0.0.1:4880/#token=…), is kept in this browser, and goes with every call.

import type { AgentInfo, ApprovalDecision, Item, PermissionMode, ServerEvent, SessionSummary, StartRequest } from '../shared/types.ts';

const KEY = 'agentyard:token';

function readToken(): string | null {
  const hash = new URLSearchParams(location.hash.slice(1));
  const fromHash = hash.get('token');
  if (fromHash) {
    localStorage.setItem(KEY, fromHash);
    history.replaceState(null, '', location.pathname + location.search);
    return fromHash;
  }
  return localStorage.getItem(KEY);
}

export const token = readToken();

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-agentyard-token': token ?? '', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export const api = {
  agents: () => call<AgentInfo[]>('GET', '/api/agents'),
  items: (id: string) => call<Item[]>('GET', `/api/sessions/${encodeURIComponent(id)}/items`),
  start: (req: StartRequest) => call<SessionSummary>('POST', '/api/sessions', req),
  send: (id: string, text: string, permission?: PermissionMode) => call('POST', `/api/sessions/${encodeURIComponent(id)}/send`, { text, permission }),
  interrupt: (id: string) => call('POST', `/api/sessions/${encodeURIComponent(id)}/interrupt`, {}),
  stop: (id: string) => call('POST', `/api/sessions/${encodeURIComponent(id)}/stop`, {}),
  hide: (id: string) => call('POST', `/api/sessions/${encodeURIComponent(id)}/hide`, {}),
  answer: (sessionId: string, approvalId: string, decision: ApprovalDecision) =>
    call('POST', `/api/approvals/${encodeURIComponent(sessionId)}/${encodeURIComponent(approvalId)}`, { decision }),
  addProject: (path: string) => call<{ path: string }>('POST', '/api/projects', { path }),
  removeProject: (path: string) => call('POST', '/api/projects/remove', { path }),
};

/** The server's event stream; reconnects by itself (EventSource does) and reports whether it's connected. */
export function events(onEvent: (ev: ServerEvent) => void, onConnected: (up: boolean) => void): () => void {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token ?? '')}`);
  es.onopen = () => onConnected(true);
  es.onerror = () => onConnected(false);
  es.onmessage = (m) => onEvent(JSON.parse(m.data) as ServerEvent);
  return () => es.close();
}
