import type { ToolEvent } from './types';

type RunningTurn = {
  promise: Promise<void>;
  started_at: string;
  assistant_message_id: string;
  client_turn_id?: string;
  hermes_run_id?: string;
  injected_tool_events?: ToolEvent[];
  controller: AbortController;
};

const globalState = globalThis as typeof globalThis & {
  __agentWorkspaceRunningTurns?: Map<string, RunningTurn>;
  __kiraWorkspaceRunningTurns?: Map<string, RunningTurn>;
};

export const runningTurns = globalState.__agentWorkspaceRunningTurns
  ?? globalState.__kiraWorkspaceRunningTurns
  ?? new Map<string, RunningTurn>();
globalState.__agentWorkspaceRunningTurns = runningTurns;
globalState.__kiraWorkspaceRunningTurns = runningTurns;

export type { RunningTurn };
