export const AGENT_WORKSPACE_SMOKE_HEADER = 'x-agent-workspace-smoke-test';
export const LEGACY_SMOKE_HEADER = 'x-kira-smoke-test';

export function isSmokeTestRequest(headers: Pick<Headers, 'get'>) {
  return headers.get(AGENT_WORKSPACE_SMOKE_HEADER) === '1' || headers.get(LEGACY_SMOKE_HEADER) === '1';
}
