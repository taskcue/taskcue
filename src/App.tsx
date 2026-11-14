import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, events, token } from './api.ts';
import { AGENT_NAMES, Board as BoardIcon, Folder, Plus, Terminal } from './bits.tsx';
import { Board } from './Board.tsx';
import { Chat } from './Chat.tsx';
import { shortPath } from './format.ts';
import { NewSession } from './NewSession.tsx';
import { apply, loadAgents, setConnected, useStore } from './store.ts';

function NoToken() {
  return (
    <div className="gate">
      <h1>TaskCue</h1>
      <p>Open TaskCue from the address it printed when it started, the one that ends in <code>#token=…</code>.</p>
      <p className="muted">
        The token keeps other websites and programs on this computer from driving your agents. It is in
        <code> ~/.taskcue-canvas/token</code>.
      </p>
    </div>
  );
}

function Sidebar({ focus, setFocus }: { focus: string | null; setFocus(p: string | null): void }) {
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const approvals = useStore((s) => s.approvals);
  const agents = useStore((s) => s.agents);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c = new Map<string, { total: number; live: number; waiting: number }>();
    const waiting = new Set(Object.values(approvals).map((a) => a.sessionId));
    for (const s of Object.values(sessions)) {
      const e = c.get(s.cwd) ?? { total: 0, live: 0, waiting: 0 };
      e.total++;
      if (s.live) e.live++;
      if (waiting.has(s.id)) e.waiting++;
      c.set(s.cwd, e);
    }
    return c;
  }, [sessions, approvals]);

  const add = async () => {
    setError(null);
    try {
      const r = await api.addProject(path);
      setPath('');
      setAdding(false);
      setFocus(r.path);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <nav className="sidebar">
      <div className="side-section">
        <button className={`side-row ${focus === null ? 'on' : ''}`} onClick={() => setFocus(null)}>
          <BoardIcon />
          <span className="side-name">All projects</span>
        </button>
      </div>
      <div className="side-label">
        Projects
        <button className="ghost tiny" onClick={() => setAdding(!adding)} title="Add a project folder">
          <Plus />
        </button>
      </div>
      {adding && (
        <div className="side-add">
          <input autoFocus value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} placeholder="/path/to/folder" />
          {error && <div className="hint warn">{error}</div>}
        </div>
      )}
      <div className="side-list">
        {projects.map((p) => {
          const c = counts.get(p.path);
          return (
            <button key={p.path} className={`side-row ${focus === p.path ? 'on' : ''} ${p.exists ? '' : 'gone'}`} onClick={() => setFocus(p.path)} title={p.path}>
              <Folder />
              <span className="side-name">{p.name}</span>
              {c?.waiting ? <span className="pill warn">{c.waiting}</span> : c?.live ? <span className="pill live">{c.live}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="side-label">Agents</div>
      <div className="side-agents">
        {agents.map((a) => (
          <div key={a.id} className="side-agent" title={a.path ?? a.installHint}>
            <span className={`agent agent-${a.id}`}>
              <span className="agent-dot" />
              {AGENT_NAMES[a.id]}
            </span>
            <span className={`muted small ${a.path ? '' : 'warn'}`}>{a.path ? (/\d+\.\d+\.\d+/.exec(a.version ?? '')?.[0] ?? 'installed') : 'not installed'}</span>
          </div>
        ))}
      </div>
    </nav>
  );
}

export function App() {
  const connected = useStore((s) => s.connected);
  const loaded = useStore((s) => s.loaded);
  const projects = useStore((s) => s.projects);
  const [focus, setFocus] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [starting, setStarting] = useState<{ cwd: string | null } | null>(null);
  const exists = useStore((s) => (open ? !!s.sessions[open] : false));

  useEffect(() => {
    if (!token) return;
    void loadAgents().catch(() => undefined);
    return events(apply, setConnected);
  }, []);

  useEffect(() => {
    if (open && loaded && !exists) setOpen(null);
  }, [open, loaded, exists]);

  const onNew = useCallback((cwd: string | null) => setStarting({ cwd }), []);
  const onOpen = useCallback((id: string) => setOpen(id), []);

  if (!token) return <NoToken />;

  const focused = focus ? projects.find((p) => p.path === focus) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/icon.svg" alt="" width={22} height={22} />
          TaskCue
        </div>
        <div className="crumb">{focused ? shortPath(focused.path) : 'All projects'}</div>
        <span className="spacer" />
        {!connected && loaded && <span className="offline">Reconnecting to the server…</span>}
        <button className="primary" onClick={() => onNew(focus)}>
          <Terminal /> New session
        </button>
      </header>
      <div className="main">
        <Sidebar focus={focus} setFocus={setFocus} />
        <section className="stage">
          <Board focus={focus} selected={open} onOpen={onOpen} onNew={onNew} />
        </section>
        {open && <Chat id={open} onClose={() => setOpen(null)} />}
      </div>
      {starting && (
        <NewSession
          cwd={starting.cwd}
          onClose={() => setStarting(null)}
          onStarted={(id) => {
            setStarting(null);
            setOpen(id);
          }}
        />
      )}
    </div>
  );
}
