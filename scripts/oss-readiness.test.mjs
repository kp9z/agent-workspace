import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = [
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'SUPPORT.md',
  'CHANGELOG.md',
  'docs/deployment.md',
  'docs/images/workspace-overview.png',
  'docs/images/workspace-settings.png',
  'docs/images/mobile-workspace.png',
];

test('open-source project metadata and community files stay complete', () => {
  for (const file of requiredFiles) {
    assert.equal(existsSync(path.join(rootDir, file)), true, `${file} must exist`);
  }

  const packageJson = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, 'agent-workspace');
  assert.equal(packageJson.private, true, 'npm publishing should remain explicitly disabled');
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.engines.node, '>=22');
  assert.equal(packageJson.scripts.test, 'node --test scripts/*.test.mjs');

  const lock = JSON.parse(readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'));
  assert.equal(lock.name, 'agent-workspace');
  assert.equal(lock.packages[''].name, 'agent-workspace');
  assert.equal(lock.packages[''].license, 'MIT');
});

test('public documentation has no personal deployment copy, stale JSON storage guidance, or broken relative links', () => {
  const markdownFiles = requiredFiles.filter((file) => file.endsWith('.md'));
  for (const file of markdownFiles) {
    const absolutePath = path.join(rootDir, file);
    const content = readFileSync(absolutePath, 'utf8');
    assert.doesNotMatch(content, /Kenny's devices|tail31d70e|do-hemes-instance|sessions\.json|Private Agent Workspace|private browser interface/i, `${file} contains private or stale deployment copy`);

    for (const match of content.matchAll(/\[[^\]]+\]\((?!https?:|mailto:|#)([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target) continue;
      assert.equal(existsSync(path.resolve(path.dirname(absolutePath), target)), true, `${file} links to missing ${match[1]}`);
    }
  }
});

test('the bundled mock advertises the required nested Hermes history capability', () => {
  const mockSource = readFileSync(path.join(rootDir, 'scripts/mock-hermes.mjs'), 'utf8');
  assert.match(mockSource, /features:\s*\{\s*runs_session_history:\s*true\s*\}/);
});
