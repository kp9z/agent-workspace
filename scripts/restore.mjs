import { existsSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  getWorkspaceDataDir,
  hasWorkspaceSidecars,
  isoSafeTimestamp,
  selectWorkspaceDbPath,
} from './sqlite-workspace-paths.mjs';

function usageError() {
  throw new Error('Usage: node scripts/restore.mjs --confirm-stopped <backup-file>');
}

function quickCheckValue(rows) {
  return rows.length === 1 ? Object.values(rows[0])[0] : undefined;
}

function formatQuickCheckFailure(rows) {
  return rows.map((row) => Object.values(row)[0]).join('; ');
}

async function verifySQLiteFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Backup file does not exist: ${filePath}`);
  }

  const fileStats = statSync(filePath);
  if (!fileStats.isFile()) {
    throw new Error(`Backup file must be a regular SQLite file: ${filePath}`);
  }

  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('pragma quick_check').all();
    if (quickCheckValue(rows) !== 'ok') {
      throw new Error(`Backup quick_check failed for ${filePath}: ${formatQuickCheckFailure(rows)}`);
    }
  } finally {
    db.close();
  }
}

async function main() {
  const cwd = process.cwd();
  const args = process.argv.slice(2);
  const confirmStopped = args.includes('--confirm-stopped');
  const positionals = args.filter((arg) => arg !== '--confirm-stopped');

  if (!confirmStopped || positionals.length !== 1) {
    usageError();
  }

  const sourceBackup = path.resolve(cwd, positionals[0]);
  const dataDir = getWorkspaceDataDir(cwd);
  const destination = selectWorkspaceDbPath(dataDir);

  if (path.resolve(sourceBackup) === path.resolve(destination)) {
    throw new Error('Refusing to restore a database from the live destination path.');
  }

  await mkdir(dataDir, { recursive: true });
  await verifySQLiteFile(sourceBackup);

  const tempPath = path.join(dataDir, `.restore-${isoSafeTimestamp()}-${process.pid}.sqlite`);
  const rollbackPath = `${destination}.pre-restore-${isoSafeTimestamp()}-${process.pid}.sqlite`;

  let sourceDb;
  let tempDb;
  let failure;
  let movedDestination = false;
  try {
    sourceDb = new Database(sourceBackup, { readonly: true, fileMustExist: true });
    await sourceDb.backup(tempPath);

    tempDb = new Database(tempPath, { readonly: true, fileMustExist: true });
    const rows = tempDb.prepare('pragma quick_check').all();
    if (quickCheckValue(rows) !== 'ok') {
      throw new Error(`Restored temp database quick_check failed for ${tempPath}: ${formatQuickCheckFailure(rows)}`);
    }
    tempDb.close();
    tempDb = undefined;
    sourceDb.close();
    sourceDb = undefined;

    if (hasWorkspaceSidecars(destination)) {
      throw new Error(
        `Refusing to restore while destination WAL/SHM sidecars exist for ${destination}. Stop the app and remove stale sidecars before retrying.`,
      );
    }

    if (existsSync(destination)) {
      await rename(destination, rollbackPath);
      movedDestination = true;
    }

    try {
      await rename(tempPath, destination);
    } catch (renameError) {
      if (movedDestination) {
        try {
          await rename(rollbackPath, destination);
        } catch (rollbackError) {
          throw new Error(
            `Failed to restore ${destination} after a partial restore: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      }
      throw renameError;
    }

    console.log(destination);
    if (movedDestination) console.log(rollbackPath);
  } catch (error) {
    failure = error;
  } finally {
    if (tempDb) tempDb.close();
    if (sourceDb) sourceDb.close();
    await rm(tempPath, { force: true });
  }

  if (failure) {
    if (movedDestination && existsSync(rollbackPath) && !existsSync(destination)) {
      try {
        await rename(rollbackPath, destination);
      } catch {
        // Leave the rollback file behind if it cannot be restored automatically.
      }
    }
    await rm(tempPath, { force: true });
    throw failure;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
