import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

export function transpileTsFiles(rootDir, files) {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'hermes-web-ui-ts-tests-'));
  for (const file of files) {
    const srcPath = path.join(rootDir, file);
    const outPath = path.join(outDir, file.replace(/\.ts$/, '.js').replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs'));
    mkdirSync(path.dirname(outPath), { recursive: true });
    const source = readFileSync(srcPath, 'utf8');
    const transpiled = ts.transpileModule(source, {
      fileName: srcPath,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        sourceMap: false,
      },
    });
    writeFileSync(outPath, transpiled.outputText);
  }
  return {
    outDir,
    cleanup() {
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}
