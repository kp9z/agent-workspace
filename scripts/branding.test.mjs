import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);

function loadBrandingModule() {
  const { outDir, cleanup } = transpileTsFiles(path.join(rootDir, 'lib'), ['branding.ts']);
  const modulePath = path.join(outDir, 'branding.js');
  delete require.cache[modulePath];
  const branding = require(modulePath);
  return { branding, cleanup };
}

function snapshotEnv() {
  return {
    AGENT_WORKSPACE_NAME: process.env.AGENT_WORKSPACE_NAME,
    AGENT_WORKSPACE_SHORT_NAME: process.env.AGENT_WORKSPACE_SHORT_NAME,
    AGENT_DISPLAY_NAME: process.env.AGENT_DISPLAY_NAME,
    USER_DISPLAY_NAME: process.env.USER_DISPLAY_NAME,
    NEXT_PUBLIC_AGENT_WORKSPACE_NAME: process.env.NEXT_PUBLIC_AGENT_WORKSPACE_NAME,
    NEXT_PUBLIC_AGENT_WORKSPACE_SHORT_NAME: process.env.NEXT_PUBLIC_AGENT_WORKSPACE_SHORT_NAME,
    NEXT_PUBLIC_AGENT_DISPLAY_NAME: process.env.NEXT_PUBLIC_AGENT_DISPLAY_NAME,
    NEXT_PUBLIC_USER_DISPLAY_NAME: process.env.NEXT_PUBLIC_USER_DISPLAY_NAME,
  };
}

function restoreEnv(savedEnv) {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test('branding defaults stay neutral and product-branded', () => {
  const savedEnv = snapshotEnv();
  delete process.env.AGENT_WORKSPACE_NAME;
  delete process.env.AGENT_WORKSPACE_SHORT_NAME;
  delete process.env.AGENT_DISPLAY_NAME;
  delete process.env.USER_DISPLAY_NAME;
  delete process.env.NEXT_PUBLIC_AGENT_WORKSPACE_NAME;
  delete process.env.NEXT_PUBLIC_AGENT_WORKSPACE_SHORT_NAME;
  delete process.env.NEXT_PUBLIC_AGENT_DISPLAY_NAME;
  delete process.env.NEXT_PUBLIC_USER_DISPLAY_NAME;

  const { branding, cleanup } = loadBrandingModule();
  try {
    assert.deepEqual(branding.branding, {
      workspaceName: 'Agent Workspace',
      workspaceShortName: 'Agent',
      agentDisplayName: 'Agent',
      userDisplayName: 'User',
      userGreeting: 'What would you like to work on today?',
    });
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});

test('branding picks up explicit display label overrides', () => {
  const savedEnv = snapshotEnv();
  process.env.NEXT_PUBLIC_AGENT_WORKSPACE_NAME = 'Workspace X';
  process.env.NEXT_PUBLIC_AGENT_WORKSPACE_SHORT_NAME = 'WS';
  process.env.NEXT_PUBLIC_AGENT_DISPLAY_NAME = 'Helper';
  process.env.NEXT_PUBLIC_USER_DISPLAY_NAME = 'Visitor';

  const { branding, cleanup } = loadBrandingModule();
  try {
    assert.deepEqual(branding.branding, {
      workspaceName: 'Workspace X',
      workspaceShortName: 'WS',
      agentDisplayName: 'Helper',
      userDisplayName: 'Visitor',
      userGreeting: 'What would you like to work on today?',
    });
  } finally {
    cleanup();
    restoreEnv(savedEnv);
  }
});
