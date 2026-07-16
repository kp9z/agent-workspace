export const ACTIVE_RUNNING_POLL_MS = 900;
export const BACKGROUND_RUNNING_POLL_MS = 2500;
export const HIDDEN_RUNNING_POLL_MS = 5000;

export type SessionStreamHealth = 'idle' | 'connecting' | 'healthy' | 'disconnected' | 'error';

export function getRunningSessionPollMs({
  hasRunningSession,
  activeRunning,
  documentVisible,
  streamHealth,
}: {
  hasRunningSession: boolean;
  activeRunning: boolean;
  documentVisible: boolean;
  streamHealth: SessionStreamHealth;
}): number | null {
  if (!hasRunningSession) return null;
  if (streamHealth === 'connecting' || streamHealth === 'healthy') return null;
  return documentVisible
    ? (activeRunning ? ACTIVE_RUNNING_POLL_MS : BACKGROUND_RUNNING_POLL_MS)
    : HIDDEN_RUNNING_POLL_MS;
}
