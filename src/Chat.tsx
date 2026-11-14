// The side panel for one session: its conversation, what it asks, and a box to reply.

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Approval, Item } from '../shared/types.ts';
import { api } from './api.ts';
import { AGENT_NAMES, AgentBadge, Arrow, Close, Square, StateLamp } from './bits.tsx';
import { shortPath } from './format.ts';
import { openConversation, useStore } from './store.ts';

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function ToolRow({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tool tool-${item.status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} disabled={!item.output}>
        <span className="tool-name">{item.name}</span>
        <span className="tool-summary">{item.summary}</span>
        <span className="tool-status">{item.status === 'running' ? 'running' : item.status === 'failed' ? 'failed' : ''}</span>
      </button>
      {open && item.output && <pre className="tool-output">{item.output}</pre>}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking">
      <button onClick={() => setOpen(!open)}>{open ? 'Hide thinking' : 'Thinking'}</button>
      {open && <div className="thinking-text">{text}</div>}
    </div>
  );
}

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'user':
      return <div className="msg user">{item.text}</div>;
    case 'assistant':
      return (
        <div className="msg assistant">
          <Markdown text={item.text} />
        </div>
      );
    case 'thinking':
      return <Thinking text={item.text} />;
    case 'tool':
      return <ToolRow item={item} />;
    case 'notice':
      return <div className={`notice notice-${item.tone}`}>{item.text}</div>;
  }
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (d: 'allow' | 'allow-session' | 'deny') => {
    setBusy(true);
    try {
      await api.answer(approval.sessionId, approval.id, d);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="approval">
      <div className="approval-label">Asks before acting</div>
      <div className="approval-title">{approval.title}</div>
      {approval.detail && <pre className="approval-detail">{approval.detail}</pre>}
      <div className="approval-actions">
        <button className="primary" disabled={busy} onClick={() => answer('allow')}>Allow</button>
        {approval.canAllowForSession && (
          <button disabled={busy} onClick={() => answer('allow-session')}>Allow for this session</button>
        )}
        <button className="danger" disabled={busy} onClick={() => answer('deny')}>Deny</button>
      </div>
      {error && <div className="notice notice-error">{error}</div>}
    </div>
  );
}

export function Chat({ id, onClose }: { id: string; onClose(): void }) {
  const session = useStore((s) => s.sessions[id]);
  const items = useStore((s) => s.items[id]);
  const draft = useStore((s) => s.drafts[id] ?? '');
  const allApprovals = useStore((s) => s.approvals);
  const approvals = useMemo(() => Object.values(allApprovals).filter((a) => a.sessionId === id), [allApprovals, id]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    setError(null);
    openConversation(id).catch((e) => setError((e as Error).message));
  }, [id]);

  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items, draft, approvals.length]);

  if (!session) return null;
  const busy = session.live && (session.state === 'working' || session.state === 'waiting' || session.state === 'starting');

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.send(id, t);
      setText('');
      pinned.current = true;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="chat">
      <header className="chat-head">
        <div className="chat-head-top">
          <AgentBadge agent={session.agent} />
          <StateLamp state={approvals.length ? 'waiting' : session.state} live={session.live} />
          <span className="spacer" />
          {busy && (
            <button className="ghost small" onClick={() => api.interrupt(id)} title="Stop the turn under way">
              <Square /> Interrupt
            </button>
          )}
          {session.live && !busy && (
            <button className="ghost small" onClick={() => api.stop(id)} title="End the agent's process; the conversation can be continued later">
              End process
            </button>
          )}
          <button className="ghost small" onClick={onClose} title="Close the panel">
            <Close />
          </button>
        </div>
        <div className="chat-title">{session.title}</div>
        <div className="chat-meta">
          <span title={session.cwd}>{shortPath(session.cwd)}</span>
          {session.model && <span>{session.model}</span>}
        </div>
      </header>

      <div
        className="chat-body"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {session.external && !session.live && (
          <div className="notice notice-info">
            Found in {AGENT_NAMES[session.agent]}'s own history. Sending a message continues this conversation here; if it is still
            open in a terminal or an editor, close it there first so two programs don't write to it at once.
          </div>
        )}
        {!items && <div className="muted">Loading…</div>}
        {items?.map((it) => <ItemView key={it.id} item={it} />)}
        {draft && (
          <div className="msg assistant draft">
            <Markdown text={draft} />
          </div>
        )}
        {approvals.map((a) => (
          <ApprovalCard key={a.id} approval={a} />
        ))}
        {error && <div className="notice notice-error">{error}</div>}
      </div>

      <footer className="composer">
        <textarea
          value={text}
          placeholder={session.live ? `Message ${AGENT_NAMES[session.agent]}…` : `Continue this ${AGENT_NAMES[session.agent]} session…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
        />
        <button className="primary send" disabled={!text.trim() || sending} onClick={() => void send()} title="Send (Enter)">
          <Arrow />
        </button>
      </footer>
    </aside>
  );
}
