const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function firstEnvValue(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function parseNonNegativeMs(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envFlag(...names: string[]) {
  const value = firstEnvValue(...names).toLowerCase();
  return TRUE_VALUES.has(value);
}

export function getWorkspaceBaseUrl() {
  return firstEnvValue('AGENT_WORKSPACE_BASE_URL', 'KIRA_WORKSPACE_BASE_URL', 'APP_BASE_URL');
}

export function getWorkspaceNotificationInactivityMs(defaultMs = 60_000) {
  return parseNonNegativeMs(firstEnvValue('AGENT_WORKSPACE_NOTIFY_INACTIVITY_MS', 'KIRA_WORKSPACE_NOTIFY_INACTIVITY_MS'), defaultMs);
}

export function getWorkspaceNotificationSessionRateLimitMs(defaultMs = 60_000) {
  return parseNonNegativeMs(firstEnvValue('AGENT_WORKSPACE_NOTIFY_SESSION_RATE_LIMIT_MS', 'KIRA_WORKSPACE_NOTIFY_SESSION_RATE_LIMIT_MS'), defaultMs);
}

export function getWorkspaceDebugPerfEnabled() {
  return envFlag('AGENT_WORKSPACE_DEBUG_PERF', 'HERMES_WEB_UI_DEBUG_PERF', 'KIRA_DEBUG_PERF') || envFlag('HERMES_WEB_UI_DEBUG');
}

export function getWorkspaceSessionKey() {
  return firstEnvValue('AGENT_WORKSPACE_SESSION_KEY', 'HERMES_WEB_UI_SESSION_KEY') || 'web-ui:agent-workspace';
}

export function getHermesWebUiSessionKey() {
  return getWorkspaceSessionKey();
}
