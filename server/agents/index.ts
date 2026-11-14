import type { AgentId } from '../../shared/types.ts';
import { claude } from './claude/index.ts';
import { codex } from './codex/index.ts';
import type { AgentAdapter } from './types.ts';

/** Every agent Agentyard can drive. A new agent is one more adapter here (docs/adding-an-agent.md). */
export const adapters: Record<AgentId, AgentAdapter> = { claude, codex };

export function adapter(id: string): AgentAdapter {
  const a = adapters[id as AgentId];
  if (!a) throw new Error(`Unknown agent: ${id}`);
  return a;
}

export function shutdownAgents(): void {
  codex.closeUtility();
}
