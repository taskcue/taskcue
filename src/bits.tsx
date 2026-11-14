// Small shared pieces. Icons describe what a control does; none stand for "AI".

import type { AgentId, SessionState } from '../shared/types.ts';

const svg = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const Plus = () => (
  <svg {...svg} aria-hidden>
    <path d="M8 3v10M3 8h10" />
  </svg>
);
export const Close = () => (
  <svg {...svg} aria-hidden>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);
export const Square = () => (
  <svg {...svg} aria-hidden>
    <rect x="4" y="4" width="8" height="8" rx="1.5" />
  </svg>
);
export const Arrow = () => (
  <svg {...svg} aria-hidden>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </svg>
);
export const Folder = () => (
  <svg {...svg} aria-hidden>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.5 1.6h4.9A1.5 1.5 0 0 1 14 6.1v5.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </svg>
);
export const Terminal = () => (
  <svg {...svg} aria-hidden>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M5 6.5L7 8l-2 1.5M8.5 10H11" />
  </svg>
);
export const Board = () => (
  <svg {...svg} aria-hidden>
    <rect x="2" y="2.5" width="5" height="4.5" rx="1" />
    <rect x="9" y="2.5" width="5" height="4.5" rx="1" />
    <rect x="5.5" y="9.5" width="5" height="4.5" rx="1" />
  </svg>
);

export const AGENT_NAMES: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex' };

export function AgentBadge({ agent }: { agent: AgentId }) {
  return (
    <span className={`agent agent-${agent}`}>
      <span className="agent-dot" />
      {AGENT_NAMES[agent] ?? agent}
    </span>
  );
}

const STATE_LABEL: Record<SessionState, string> = {
  starting: 'Starting',
  working: 'Working',
  waiting: 'Needs you',
  idle: 'Ready',
  stopped: 'Stopped',
  error: 'Error',
};

export function StateLamp({ state, live }: { state: SessionState; live: boolean }) {
  const shown: SessionState = !live && state !== 'error' ? 'stopped' : state;
  return (
    <span className={`lamp lamp-${shown}`}>
      <span className="lamp-dot" />
      {STATE_LABEL[shown]}
    </span>
  );
}
