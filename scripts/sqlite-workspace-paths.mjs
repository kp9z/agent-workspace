import { existsSync } from 'node:fs';
import path from 'node:path';

export const CANONICAL_DB_NAME = 'agent-workspace.sqlite';
export const LEGACY_DB_NAME = 'kira-workspace.sqlite';

export function getWorkspaceDataDir(cwd = process.cwd()) {
  return process.env.HERMES_WEB_UI_DATA_DIR || path.join(cwd, '.data');
}

export function workspaceDbPath(dataDir, fileName = CANONICAL_DB_NAME) {
  return path.join(dataDir, fileName);
}

export function selectExistingWorkspaceDbPath(dataDir, fileExists = existsSync) {
  const canonicalPath = workspaceDbPath(dataDir, CANONICAL_DB_NAME);
  if (fileExists(canonicalPath)) return canonicalPath;

  const legacyPath = workspaceDbPath(dataDir, LEGACY_DB_NAME);
  if (fileExists(legacyPath)) return legacyPath;

  return null;
}

export function selectWorkspaceDbPath(dataDir, fileExists = existsSync) {
  const existing = selectExistingWorkspaceDbPath(dataDir, fileExists);
  if (existing) return existing;
  return workspaceDbPath(dataDir, CANONICAL_DB_NAME);
}

export function isoSafeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function sidecarPaths(dbPath) {
  return {
    wal: `${dbPath}-wal`,
    shm: `${dbPath}-shm`,
  };
}

export function hasWorkspaceSidecars(dbPath, fileExists = existsSync) {
  const { wal, shm } = sidecarPaths(dbPath);
  return fileExists(wal) || fileExists(shm);
}
