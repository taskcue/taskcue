// Starting a session: where, which agent, which model, how much it may do alone, and the first message.

import { useEffect, useState } from 'react';
import { PERMISSION_MODES, type AgentId, type PermissionMode } from '../shared/types.ts';
import { api } from './api.ts';
import { Close } from './bits.tsx';
import { shortPath } from './format.ts';
import { loadAgents, useStore } from './store.ts';

const LAST = 'agentyard:last-start';

interface Last {
  agent: AgentId;
  permission: PermissionMode;
  model: Partial<Record<AgentId, string>>;
}

function last(): Last {
  try {
    return { agent: 'claude', permission: 'ask', model: {}, ...JSON.parse(localStorage.getItem(LAST) ?? '{}') };
  } catch {
    return { agent: 'claude', permission: 'ask', model: {} };
  }
}

export function NewSession({ cwd: initialCwd, onClose, onStarted }: { cwd: string | null; onClose(): void; onStarted(id: string): void }) {
  const agents = useStore((s) => s.agents);
  const projects = useStore((s) => s.projects);
  const remembered = last();
  const [agent, setAgent] = useState<AgentId>(remembered.agent);
  const [cwd, setCwd] = useState(initialCwd ?? projects[0]?.path ?? '');
  const [model, setModel] = useState(remembered.model[remembered.agent] ?? '');
  const [permission, setPermission] = useState<PermissionMode>(remembered.permission);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agents.length) void loadAgents();
  }, [agents.length]);

  const info = agents.find((a) => a.id === agent);
  const installed = !!info?.path;

  const pickAgent = (id: AgentId) => {
    setAgent(id);
    setModel(remembered.model[id] ?? '');
  };

  const start = async () => {
    if (!text.trim() || !cwd.trim() || !installed) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api.start({ agent, cwd, text, model: model || null, permission });
      localStorage.setItem(LAST, JSON.stringify({ agent, permission, model: { ...remembered.model, [agent]: model } } satisfies Last));
      onStarted(s.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="New session">
        <div className="modal-head">
          <h2>New session</h2>
          <button className="ghost small" onClick={onClose} aria-label="Close">
            <Close />
          </button>
        </div>

        <label className="field">
          <span>Project folder</span>
          <input list="agentyard-projects" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/code/my-app" />
          <datalist id="agentyard-projects">
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {shortPath(p.path)}
              </option>
            ))}
          </datalist>
        </label>

        <div className="field">
          <span>Agent</span>
          <div className="choices">
            {(['claude', 'codex'] as AgentId[]).map((id) => {
              const a = agents.find((x) => x.id === id);
              return (
                <button key={id} className={`choice ${agent === id ? 'on' : ''}`} onClick={() => pickAgent(id)}>
                  <span className={`agent agent-${id}`}>
                    <span className="agent-dot" />
                    {a?.name ?? id}
                  </span>
                  <span className="choice-sub">{!a ? 'Checking…' : a.path ? a.version ?? 'Installed' : 'Not installed'}</span>
                </button>
              );
            })}
          </div>
          {info && !info.path && <div className="hint warn">{info.installHint}</div>}
        </div>

        <label className="field">
          <span>Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">The agent's default</option>
            {info?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span>Permissions</span>
          <div className="choices three">
            {PERMISSION_MODES.map((p) => (
              <button key={p.id} className={`choice ${permission === p.id ? 'on' : ''} ${p.id === 'full' ? 'risky' : ''}`} onClick={() => setPermission(p.id)}>
                <span>{p.label}</span>
                <span className="choice-sub">{p.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span>First message</span>
          <textarea
            rows={4}
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void start();
            }}
            placeholder="What should it do?"
          />
        </label>

        {error && <div className="notice notice-error">{error}</div>}

        <div className="modal-actions">
          <span className="hint">Runs on this computer with your own {info?.name ?? 'agent'} sign-in.</span>
          <button className="primary" disabled={busy || !text.trim() || !cwd.trim() || !installed} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}
