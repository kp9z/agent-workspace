import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  hasWorkspaceSidecars,
  selectExistingWorkspaceDbPath,
  selectWorkspaceDbPath,
} from './sqlite-workspace-paths.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const backupScript = path.join(scriptDir, 'backup.mjs');
const restoreScript = path.join(scriptDir, 'restore.mjs');

function runScript(scriptPath, args, env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: rootDir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createWorkspaceDb(dbPath, values, { wal = false } = {}) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma(`journal_mode = ${wal ? 'WAL' : 'DELETE'}`);
  db.pragma('foreign_keys = ON');
  db.exec('create table if not exists entries (id integer primary key, value text not null)');
  const insert = db.prepare('insert into entries (value) values (?)');
  for (const value of values) insert.run(value);
  return db;
}

function readValues(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('select value from entries order by id').all().map((row) => row.value);
  } finally {
    db.close();
  }
}

function quickCheckResult(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('pragma quick_check').all();
  } finally {
    db.close();
  }
}

test('shared workspace DB path helpers prefer canonical and fall back to legacy', () => {
  const dataDir = tempDir('kira-db-paths-');
  try {
    assert.equal(selectExistingWorkspaceDbPath(dataDir), null);
    assert.equal(selectWorkspaceDbPath(dataDir), path.join(dataDir, 'agent-workspace.sqlite'));

    const legacyPath = path.join(dataDir, 'kira-workspace.sqlite');
    createWorkspaceDb(legacyPath, ['legacy']).close();
    assert.equal(selectExistingWorkspaceDbPath(dataDir), legacyPath);
    assert.equal(selectWorkspaceDbPath(dataDir), legacyPath);

    const canonicalPath = path.join(dataDir, 'agent-workspace.sqlite');
    createWorkspaceDb(canonicalPath, ['canonical']).close();
    assert.equal(selectExistingWorkspaceDbPath(dataDir), canonicalPath);
    assert.equal(selectWorkspaceDbPath(dataDir), canonicalPath);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('backup script snapshots a live WAL database and verifies the backup', () => {
  const dataDir = tempDir('kira-backup-live-');
  const sourceDbPath = path.join(dataDir, 'agent-workspace.sqlite');
  const backupPath = path.join(dataDir, 'backup.sqlite');
  const sourceDb = createWorkspaceDb(sourceDbPath, ['before-backup'], { wal: true });
  try {
    const result = runScript(backupScript, [backupPath], { HERMES_WEB_UI_DATA_DIR: dataDir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), backupPath);
    assert.equal(result.stderr.trim(), '');
    assert.deepEqual(readValues(backupPath), ['before-backup']);
    assert.deepEqual(quickCheckResult(backupPath), [{ quick_check: 'ok' }]);

    sourceDb.prepare('insert into entries (value) values (?)').run('after-backup');
    assert.deepEqual(readValues(sourceDbPath), ['before-backup', 'after-backup']);
    assert.deepEqual(readValues(backupPath), ['before-backup']);
  } finally {
    sourceDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('backup script prefers canonical database over legacy and refuses to overwrite existing backups', () => {
  const dataDir = tempDir('kira-backup-preference-');
  const canonicalPath = path.join(dataDir, 'agent-workspace.sqlite');
  const legacyPath = path.join(dataDir, 'kira-workspace.sqlite');
  const backupPath = path.join(dataDir, 'existing-backup.sqlite');
  const canonicalDb = createWorkspaceDb(canonicalPath, ['canonical']);
  const legacyDb = createWorkspaceDb(legacyPath, ['legacy']);
  try {
    const firstResult = runScript(backupScript, [backupPath], { HERMES_WEB_UI_DATA_DIR: dataDir });
    assert.equal(firstResult.status, 0, firstResult.stderr);
    assert.deepEqual(readValues(backupPath), ['canonical']);

    const refusal = runScript(backupScript, [backupPath], { HERMES_WEB_UI_DATA_DIR: dataDir });
    assert.notEqual(refusal.status, 0);
    assert.match(refusal.stderr, /Backup already exists/);
    assert.deepEqual(readValues(backupPath), ['canonical']);
  } finally {
    canonicalDb.close();
    legacyDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('backup script falls back to legacy when canonical is absent', () => {
  const dataDir = tempDir('kira-backup-legacy-');
  const legacyPath = path.join(dataDir, 'kira-workspace.sqlite');
  const backupPath = path.join(dataDir, 'legacy-backup.sqlite');
  const legacyDb = createWorkspaceDb(legacyPath, ['legacy-only']);
  try {
    const result = runScript(backupScript, [backupPath], { HERMES_WEB_UI_DATA_DIR: dataDir });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readValues(backupPath), ['legacy-only']);
  } finally {
    legacyDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('backup script honors the configured default backup directory', () => {
  const dataDir = tempDir('kira-backup-dir-');
  const backupDir = path.join(dataDir, 'custom-backups');
  const sourceDb = createWorkspaceDb(path.join(dataDir, 'agent-workspace.sqlite'), ['configured-dir']);
  try {
    const result = runScript(backupScript, [], {
      AGENT_WORKSPACE_DATA_DIR: dataDir,
      AGENT_WORKSPACE_BACKUP_DIR: backupDir,
    });
    assert.equal(result.status, 0, result.stderr);
    const destination = result.stdout.trim();
    assert.equal(path.dirname(destination), backupDir);
    assert.match(path.basename(destination), /^agent-workspace-.*\.sqlite$/);
    assert.deepEqual(readValues(destination), ['configured-dir']);
  } finally {
    sourceDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('restore script refuses without the stopped-app flag and when destination sidecars exist', () => {
  const dataDir = tempDir('kira-restore-guards-');
  const destinationPath = path.join(dataDir, 'agent-workspace.sqlite');
  const backupPath = path.join(dataDir, 'restore-source.sqlite');
  const destinationDb = createWorkspaceDb(destinationPath, ['keep-me']);
  const backupDb = createWorkspaceDb(backupPath, ['new-value']);
  try {
    const missingFlag = runScript(restoreScript, [backupPath], { HERMES_WEB_UI_DATA_DIR: dataDir });
    assert.notEqual(missingFlag.status, 0);
    assert.match(missingFlag.stderr, /Usage: node scripts\/restore\.mjs --confirm-stopped <backup-file>/);

    destinationDb.close();
    writeFileSync(`${destinationPath}-wal`, 'wal');
    writeFileSync(`${destinationPath}-shm`, 'shm');

    const sidecarRefusal = runScript(restoreScript, ['--confirm-stopped', backupPath], {
      HERMES_WEB_UI_DATA_DIR: dataDir,
    });
    assert.notEqual(sidecarRefusal.status, 0);
    assert.match(sidecarRefusal.stderr, /destination WAL\/SHM sidecars exist/);
    assert.deepEqual(readValues(destinationPath), ['keep-me']);
    assert.equal(hasWorkspaceSidecars(destinationPath), true);
  } finally {
    try {
      destinationDb.close();
    } catch {
      // already closed above for the sidecar simulation.
    }
    backupDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('restore script validates malformed backups before touching destination data', () => {
  const dataDir = tempDir('kira-restore-malformed-');
  const destinationPath = path.join(dataDir, 'agent-workspace.sqlite');
  const backupPath = path.join(dataDir, 'bad-backup.sqlite');
  const destinationDb = createWorkspaceDb(destinationPath, ['original']);
  try {
    destinationDb.close();
    writeFileSync(backupPath, 'not sqlite');

    const result = runScript(restoreScript, ['--confirm-stopped', backupPath], { HERMES_WEB_UI_DATA_DIR: dataDir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /(quick_check failed|file is not a regular SQLite file|file is not a database|SQLITE_NOTADB)/i);
    assert.deepEqual(readValues(destinationPath), ['original']);
  } finally {
    try {
      destinationDb.close();
    } catch {
      // already closed above.
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('confirmed restore swaps in the new database and preserves a rollback copy', () => {
  const dataDir = tempDir('kira-restore-confirmed-');
  const destinationPath = path.join(dataDir, 'agent-workspace.sqlite');
  const backupPath = path.join(dataDir, 'restore-source.sqlite');
  const destinationDb = createWorkspaceDb(destinationPath, ['old-value']);
  const backupDb = createWorkspaceDb(backupPath, ['new-value']);
  try {
    const result = runScript(restoreScript, ['--confirm-stopped', backupPath], { HERMES_WEB_UI_DATA_DIR: dataDir });
    assert.equal(result.status, 0, result.stderr);
    const [printedDestination, rollbackPath] = result.stdout.trim().split(/\r?\n/);
    assert.equal(printedDestination, destinationPath);
    assert.match(rollbackPath, /\.pre-restore-.*\.sqlite$/);
    assert.equal(hasWorkspaceSidecars(destinationPath), false);
    assert.deepEqual(readValues(destinationPath), ['new-value']);
    assert.deepEqual(quickCheckResult(destinationPath), [{ quick_check: 'ok' }]);
    assert.equal(existsSync(rollbackPath), true);
    assert.deepEqual(readValues(rollbackPath), ['old-value']);
    assert.deepEqual(quickCheckResult(rollbackPath), [{ quick_check: 'ok' }]);
  } finally {
    destinationDb.close();
    backupDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('fresh restore uses the canonical destination path', () => {
  const dataDir = tempDir('kira-restore-fresh-');
  const backupPath = path.join(dataDir, 'fresh-backup.sqlite');
  const backupDb = createWorkspaceDb(backupPath, ['fresh-value']);
  try {
    const destinationPath = path.join(dataDir, 'agent-workspace.sqlite');
    const result = runScript(restoreScript, ['--confirm-stopped', backupPath], { HERMES_WEB_UI_DATA_DIR: dataDir });
    assert.equal(result.status, 0, result.stderr);
    const [printedDestination] = result.stdout.trim().split(/\r?\n/);
    assert.equal(printedDestination, destinationPath);
    assert.deepEqual(readValues(destinationPath), ['fresh-value']);
    assert.equal(existsSync(path.join(dataDir, 'kira-workspace.sqlite')), false);
  } finally {
    backupDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
