import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);

function snapshotEnv() {
  return {
    AGENT_WORKSPACE_BASE_URL: process.env.AGENT_WORKSPACE_BASE_URL,
    KIRA_WORKSPACE_BASE_URL: process.env.KIRA_WORKSPACE_BASE_URL,
    APP_BASE_URL: process.env.APP_BASE_URL,
    AGENT_WORKSPACE_NOTIFY_INACTIVITY_MS: process.env.AGENT_WORKSPACE_NOTIFY_INACTIVITY_MS,
    KIRA_WORKSPACE_NOTIFY_INACTIVITY_MS: process.env.KIRA_WORKSPACE_NOTIFY_INACTIVITY_MS,
    AGENT_WORKSPACE_NOTIFY_SESSION_RATE_LIMIT_MS: process.env.AGENT_WORKSPACE_NOTIFY_SESSION_RATE_LIMIT_MS,
    KIRA_WORKSPACE_NOTIFY_SESSION_RATE_LIMIT_MS: process.env.KIRA_WORKSPACE_NOTIFY_SESSION_RATE_LIMIT_MS,
    AGENT_WORKSPACE_DEBUG_PERF: process.env.AGENT_WORKSPACE_DEBUG_PERF,
    HERMES_WEB_UI_DEBUG_PERF: process.env.HERMES_WEB_UI_DEBUG_PERF,
    KIRA_DEBUG_PERF: process.env.KIRA_DEBUG_PERF,
    HERMES_WEB_UI_DEBUG: process.env.HERMES_WEB_UI_DEBUG,
    AGENT_WORKSPACE_SESSION_KEY: process.env.AGENT_WORKSPACE_SESSION_KEY,
    HERMES_WEB_UI_SESSION_KEY: process.env.HERMES_WEB_UI_SESSION_KEY,
  };
}

function restoreEnv(savedEnv) {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function loadWorkspaceEnv() {
  const { outDir, cleanup } = transpileTsFiles(rootDir, ['lib/workspace-env.ts']);
  const modulePath = path.join(outDir, 'lib/workspace-env.js');
  delete require.cache[modulePath];
  const workspaceEnv = require(modulePath);
  return { workspaceEnv, cleanup };
}

test('workspace env helpers prefer agent variables over legacy aliases', () => {
  const savedEnv = snapshotEnv();
  process.env.AGENT_WORKSPACE_BASE_URL = 'https://agent.example';
  process.env.KIRA_WORKSPACE_BASE_URL = 'https://legacy.example';
  process.env.APP_BASE_URL = 'https://app.example';
  process.env.AGENT_WORKSPACE_NOTIFY_INACTIVITY_MS = '12';
  process.env.KIRA_WORKSPACE_NOTIFY_INACTIVITY_MS = '34';
  process.env.AGENT_WORKSPACE_NOTIFY_SESSION_RATE_LIMIT_MS = '56';
  process.env.KIRA_WORKSPACE_NOTIFY_SESSION_RATE_LIMIT_MS = '78';
  process.env.AGENT_WORKSPACE_DEBUG_PERF = '1';
  process.env.KIRA_DEBUG_PERF = '0';
  process.env.AGENT_WORKSPACE_SESSION_KEY = 'agent-session-key';
  process.env.HERMES_WEB_UI_SESSION_KEY = 'legacy-session-key';

  const { workspaceEnv, cleanup } = loadWorkspaceEnv();
  try {
    assert.equal(workspaceEnv.getWorkspaceBaseUrl(), 'https://agent.example');
    assert.equal(workspaceEnv.getWorkspaceNotificationInactivityMs(), 12);
    assert.equal(workspaceEnv.getWorkspaceNotificationSessionRateLimitMs(), 56);
    assert.equal(workspaceEnv.getWorkspaceDebugPerfEnabled(), true);
    assert.equal(workspaceEnv.getWorkspaceSessionKey(), 'agent-session-key');
    assert.equal(workspaceEnv.getHermesWebUiSessionKey(), 'agent-session-key');
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});

test('workspace env helpers fall back to legacy aliases and defaults', () => {
  const savedEnv = snapshotEnv();
  delete process.env.AGENT_WORKSPACE_BASE_URL;
  process.env.KIRA_WORKSPACE_BASE_URL = 'https://legacy.example';
  delete process.env.APP_BASE_URL;
  delete process.env.AGENT_WORKSPACE_NOTIFY_INACTIVITY_MS;
  process.env.KIRA_WORKSPACE_NOTIFY_INACTIVITY_MS = '34';
  delete process.env.AGENT_WORKSPACE_NOTIFY_SESSION_RATE_LIMIT_MS;
  process.env.KIRA_WORKSPACE_NOTIFY_SESSION_RATE_LIMIT_MS = '78';
  delete process.env.AGENT_WORKSPACE_DEBUG_PERF;
  process.env.KIRA_DEBUG_PERF = '1';
  delete process.env.AGENT_WORKSPACE_SESSION_KEY;
  process.env.HERMES_WEB_UI_SESSION_KEY = 'legacy-session-key';

  const { workspaceEnv, cleanup } = loadWorkspaceEnv();
  try {
    assert.equal(workspaceEnv.getWorkspaceBaseUrl(), 'https://legacy.example');
    assert.equal(workspaceEnv.getWorkspaceNotificationInactivityMs(), 34);
    assert.equal(workspaceEnv.getWorkspaceNotificationSessionRateLimitMs(), 78);
    assert.equal(workspaceEnv.getWorkspaceDebugPerfEnabled(), true);
    assert.equal(workspaceEnv.getWorkspaceSessionKey(), 'legacy-session-key');
    delete process.env.HERMES_WEB_UI_SESSION_KEY;
    const { workspaceEnv: fallbackEnv, cleanup: fallbackCleanup } = loadWorkspaceEnv();
    try {
      assert.equal(fallbackEnv.getWorkspaceSessionKey(), 'web-ui:agent-workspace');
    } finally {
      fallbackCleanup();
    }
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});
