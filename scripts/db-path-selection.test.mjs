import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(import.meta.url);

function loadDbModule() {
  const { outDir, cleanup } = transpileTsFiles(rootDir, ['lib/db.ts']);
  const tempNodeModules = path.join(outDir, 'node_modules');
  mkdirSync(tempNodeModules, { recursive: true });
  symlinkSync(path.join(rootDir, 'node_modules', 'better-sqlite3'), path.join(tempNodeModules, 'better-sqlite3'), 'dir');
  const modulePath = path.join(outDir, 'lib/db.js');
  delete require.cache[modulePath];
  const db = require(modulePath);
  return { db, cleanup };
}

test('db path selection prefers canonical files and falls back to legacy files', () => {
  const { db, cleanup } = loadDbModule();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'kira-db-path-'));

  try {
    process.env.HERMES_WEB_UI_DATA_DIR = dataDir;
    assert.equal(db.selectDbPath(dataDir), path.join(dataDir, 'agent-workspace.sqlite'));
    assert.equal(db.getDbPath(), path.join(dataDir, 'agent-workspace.sqlite'));

    writeFileSync(path.join(dataDir, 'kira-workspace.sqlite'), 'legacy');
    assert.equal(db.selectDbPath(dataDir), path.join(dataDir, 'kira-workspace.sqlite'));
    assert.equal(db.getDbPath(), path.join(dataDir, 'kira-workspace.sqlite'));

    writeFileSync(path.join(dataDir, 'agent-workspace.sqlite'), 'canonical');
    assert.equal(db.selectDbPath(dataDir), path.join(dataDir, 'agent-workspace.sqlite'));
    assert.equal(db.getDbPath(), path.join(dataDir, 'agent-workspace.sqlite'));
  } finally {
    cleanup();
    delete process.env.HERMES_WEB_UI_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
