// The board: each project is a frame, each session a card inside it, Claude Code and Codex alike.

import { Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project, SessionSummary } from '../shared/types.ts';
import { AgentBadge, Plus, StateLamp } from './bits.tsx';
import { useStore } from './store.ts';
import { ago, shortPath } from './format.ts';

const CARD_W = 248;
const CARD_H = 104;
const GAP = 14;
const HEAD = 52;
const COLS = 2;
const FRAME_W = COLS * CARD_W + (COLS + 1) * GAP;
const MAX_CARDS = 12;

type ProjectData = { project: Project; count: number; hidden: number; onNew(path: string): void };
type SessionData = { session: SessionSummary; selected: boolean; needsYou: boolean; onOpen(id: string): void };

function ProjectFrame({ data }: NodeProps<Node<ProjectData>>) {
  const { project, count, hidden, onNew } = data;
  return (
    <div className="frame">
      <div className="frame-head">
        <div className="frame-title">
          <span className="frame-name">{project.name}</span>
          <span className="frame-path" title={project.path}>{shortPath(project.path)}</span>
        </div>
        <button className="ghost small nodrag" onClick={() => onNew(project.path)} title="New session in this project">
          <Plus /> New
        </button>
      </div>
      {count === 0 && <div className="frame-empty">No sessions yet.</div>}
      {hidden > 0 && <div className="frame-more">{hidden} older not shown</div>}
    </div>
  );
}

function SessionCard({ data }: NodeProps<Node<SessionData>>) {
  const { session: s, selected, needsYou, onOpen } = data;
  return (
    <button className={`card ${selected ? 'selected' : ''} ${needsYou ? 'needs-you' : ''}`} onClick={(e) => { e.stopPropagation(); onOpen(s.id); }}>
      <div className="card-top">
        <AgentBadge agent={s.agent} />
        <StateLamp state={needsYou ? 'waiting' : s.state} live={s.live} />
      </div>
      <div className="card-title">{s.title}</div>
      <div className="card-foot">
        {s.model && <span>{s.model}</span>}
        <span>{ago(s.updatedAt)}</span>
        {s.external && !s.live && <span className="tag">history</span>}
      </div>
    </button>
  );
}

const nodeTypes = { project: ProjectFrame, session: SessionCard };

interface Props {
  focus: string | null;
  selected: string | null;
  onOpen(id: string): void;
  onNew(path: string | null): void;
}

function Layout({ focus, selected, onOpen, onNew }: Props) {
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const approvals = useStore((s) => s.approvals);
  const flow = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  // As many frame columns as the space holds, so frames stay readable when the side panel opens.
  const columns = Math.max(1, Math.min(4, Math.floor((width - 40) / (FRAME_W + 40))));

  const nodes = useMemo(() => {
    const waiting = new Set(Object.values(approvals).map((a) => a.sessionId));
    const byProject = new Map<string, SessionSummary[]>();
    for (const s of Object.values(sessions)) {
      const list = byProject.get(s.cwd) ?? [];
      list.push(s);
      byProject.set(s.cwd, list);
    }
    const shown = focus ? projects.filter((p) => p.path === focus) : projects;
    const out: Node[] = [];
    const colY = new Array(columns).fill(0);
    for (const project of shown) {
      const all = (byProject.get(project.path) ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
      const list = all.slice(0, MAX_CARDS);
      const rows = Math.max(1, Math.ceil(list.length / COLS));
      const height = HEAD + rows * (CARD_H + GAP) + GAP + (all.length > MAX_CARDS ? 22 : 0);
      const col = colY.indexOf(Math.min(...colY));
      const x = col * (FRAME_W + 40);
      const y = colY[col];
      colY[col] += height + 40;
      out.push({
        id: `p:${project.path}`,
        type: 'project',
        position: { x, y },
        data: { project, count: all.length, hidden: all.length - list.length, onNew } satisfies ProjectData,
        style: { width: FRAME_W, height },
        draggable: false,
        selectable: false,
      });
      list.forEach((s, i) => {
        out.push({
          id: `s:${s.id}`,
          type: 'session',
          parentId: `p:${project.path}`,
          extent: 'parent',
          position: { x: GAP + (i % COLS) * (CARD_W + GAP), y: HEAD + Math.floor(i / COLS) * (CARD_H + GAP) },
          data: { session: s, selected: s.id === selected, needsYou: waiting.has(s.id), onOpen } satisfies SessionData,
          style: { width: CARD_W, height: CARD_H },
          draggable: false,
          selectable: false,
        });
      });
    }
    return out;
  }, [sessions, projects, approvals, focus, selected, onOpen, onNew, columns]);

  // Fit the newest row of frames, not all of them: with many projects, fitting every frame makes each unreadable.
  const frames = nodes.filter((n) => n.type === 'project');
  const frameKey = frames.map((n) => n.id).join('|');
  // The board starts at its top-left, scaled so its columns fill the width (never past 100%).
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const place = (duration: number) => {
    const el = wrap.current;
    if (!el) return;
    const w = el.clientWidth;
    const content = columnsRef.current * (FRAME_W + 40) - 40;
    const zoom = Math.min(1, (w - 64) / content);
    void flow.setViewport({ x: Math.max(32, (w - content * zoom) / 2), y: 28, zoom }, { duration });
  };
  useEffect(() => {
    const t = setTimeout(() => place(250), 30);
    return () => clearTimeout(t);
  }, [frameKey, columns, flow]);
  // The board lays out and fits again when its space changes (the side panel, the window).
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver((entries) => {
      setWidth(entries[0].contentRect.width);
      clearTimeout(t);
      t = setTimeout(() => place(200), 120);
    });
    ro.observe(el);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, [flow]);

  return (
    <div ref={wrap} className="board-wrap">
    <ReactFlow
      nodes={nodes}
      edges={[]}
      nodeTypes={nodeTypes}
      onNodeClick={(_, node) => {
        if (node.type === 'session') onOpen(node.id.slice(2));
      }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={0.2}
      maxZoom={1.5}
      proOptions={{ hideAttribution: false }}
    >
      <Background gap={24} size={1} color="var(--grid)" />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
    </div>
  );
}

export function Board(props: Props) {
  const projects = useStore((s) => s.projects);
  const loaded = useStore((s) => s.loaded);
  if (loaded && projects.length === 0) {
    return (
      <div className="board-empty">
        <h2>Nothing on the board yet</h2>
        <p>Add a project folder on the left, or start a session. Sessions you run in Claude Code or Codex elsewhere appear here too.</p>
        <button className="primary" onClick={() => props.onNew(null)}>
          <Plus /> New session
        </button>
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <Layout {...props} />
    </ReactFlowProvider>
  );
}
