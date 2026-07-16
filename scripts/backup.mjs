import { existsSync } from 'node:fs';
import { link, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  getWorkspaceDataDir,
  isoSafeTimestamp,
  selectExistingWorkspaceDbPath,
} from './sqlite-workspace-paths.mjs';

function quickCheckValue(rows) {
  return rows.length === 1 ? Object.values(rows[0])[0] : undefined;
}

function formatQuickCheckFailure(rows) {
  return rows.map((row) => Object.values(row)[0]).join('; ');
}

async function main() {
  const cwd = process.cwd();
  const dataDir = getWorkspaceDataDir(cwd);
  const source = selectExistingWorkspaceDbPath(dataDir);
  if (!source) {
    throw new Error(`No SQLite workspace database found in ${dataDir}`);
  }

  const backupDir = process.env.HERMES_WEB_UI_BACKUP_DIR || path.join(cwd, 'backups');
  const destination = process.argv[2]
    ? path.resolve(cwd, process.argv[2])
    : path.join(backupDir, `agent-workspace-${isoSafeTimestamp()}.sqlite`);

  if (path.resolve(source) === path.resolve(destination)) {
    throw new Error('Refusing to back up a database onto itself.');
  }

  if (existsSync(destination)) {
    throw new Error(`Backup already exists: ${destination}`);
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const tempPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.tmp-${process.pid}-${randomUUID()}`,
  );

  let sourceDb;
  let verifyDb;
  let failure;
  let published = false;
  try {
    sourceDb = new Database(source, { readonly: true, fileMustExist: true });
    await sourceDb.backup(tempPath);

    verifyDb = new Database(tempPath, { readonly: true, fileMustExist: true });
    const rows = verifyDb.prepare('pragma quick_check').all();
    if (quickCheckValue(rows) !== 'ok') {
      throw new Error(`Backup quick_check failed for ${destination}: ${formatQuickCheckFailure(rows)}`);
    }
    verifyDb.close();
    verifyDb = undefined;
    try {
      // Hard-link publication is atomic and refuses to replace an existing path.
      await link(tempPath, destination);
      published = true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        throw new Error(`Backup already exists: ${destination}`);
      }
      throw error;
    }
  } catch (error) {
    failure = error;
  } finally {
    if (verifyDb) verifyDb.close();
    if (sourceDb) sourceDb.close();
  }

  await rm(tempPath, { force: true }).catch(() => undefined);
  if (failure) throw failure;
  if (!published) throw new Error('Backup was not published.');
  console.log(destination);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
