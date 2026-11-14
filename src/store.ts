// The page's state: what the event stream says, kept in one place and read with useStore.

import { useSyncExternalStore } from 'react';
import type { AgentInfo, Approval, Item, Project, ServerEvent, SessionSummary } from '../shared/types.ts';
import { api } from './api.ts';

export interface State {
  connected: boolean;
  loaded: boolean;
  sessions: Record<string, SessionSummary>;
  projects: Project[];
  approvals: Record<string, Approval>;
  agents: AgentInfo[];
  /** Conversations opened in the panel, by session id. */
  items: Record<string, Item[]>;
  drafts: Record<string, string>;
}

let state: State = { connected: false, loaded: false, sessions: {}, projects: [], approvals: {}, agents: [], items: {}, drafts: {} };
const listeners = new Set<() => void>();

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function useStore<T>(pick: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pick(state),
  );
}

export function getState(): State {
  return state;
}

function upsert(list: Item[], item: Item): Item[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

export function apply(ev: ServerEvent): void {
  switch (ev.type) {
    case 'hello':
      set({
        loaded: true,
        sessions: Object.fromEntries(ev.sessions.map((s) => [s.id, s])),
        projects: ev.projects,
        approvals: Object.fromEntries(ev.approvals.map((a) => [a.id, a])),
      });
      return;
    case 'session':
      set({ sessions: { ...state.sessions, [ev.session.id]: ev.session } });
      return;
    case 'session-removed': {
      const { [ev.id]: _gone, ...rest } = state.sessions;
      set({ sessions: rest });
      return;
    }
    case 'projects':
      set({ projects: ev.projects });
      return;
    case 'item': {
      const list = state.items[ev.sessionId];
      if (!list) return; // not open; it loads whole when opened
      set({ items: { ...state.items, [ev.sessionId]: upsert(list, ev.item) } });
      return;
    }
    case 'draft':
      set({ drafts: { ...state.drafts, [ev.sessionId]: ev.text } });
      return;
    case 'approval':
      set({ approvals: { ...state.approvals, [ev.approval.id]: ev.approval } });
      return;
    case 'approval-resolved': {
      const { [ev.id]: _done, ...rest } = state.approvals;
      set({ approvals: rest });
      return;
    }
  }
}

export function setConnected(up: boolean): void {
  if (up !== state.connected) set({ connected: up });
}

export async function loadAgents(): Promise<void> {
  set({ agents: await api.agents() });
}

/** Loads a conversation when it opens. Items that arrive while it loads are kept. */
export async function openConversation(id: string): Promise<void> {
  if (state.items[id]) return;
  set({ items: { ...state.items, [id]: [] } });
  let loaded: Item[];
  try {
    loaded = await api.items(id);
  } catch (err) {
    loaded = [{ id: 'load-error', kind: 'notice', tone: 'error', text: `Could not read this conversation: ${(err as Error).message}` }];
  }
  const during: Item[] = getState().items[id] ?? [];
  let merged = loaded;
  for (const it of during) merged = upsert(merged, it);
  set({ items: { ...state.items, [id]: merged } });
}
