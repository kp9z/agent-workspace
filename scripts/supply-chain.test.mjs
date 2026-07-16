import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(rootDir, '.github', 'workflows');
const workflowFiles = ['ci.yml', 'dependency-review.yml', 'codeql.yml'];

function read(relativePath) {
  return readFileSync(path.join(rootDir, relativePath), 'utf8');
}

test('CI, dependency review, CodeQL, and Dependabot configuration are present', () => {
  for (const file of workflowFiles) {
    assert.equal(existsSync(path.join(workflowDir, file)), true, `${file} must exist`);
  }
  assert.equal(existsSync(path.join(rootDir, '.github', 'dependabot.yml')), true);
  const dependabot = read('.github/dependabot.yml');
  assert.match(dependabot, /dependency-name:\s*node[\s\S]*version-update:semver-major/, 'Docker Dependabot must not propose unsupported Node major upgrades');

  const ci = read('.github/workflows/ci.yml');
  for (const command of [
    'npm ci',
    'npm audit --omit=dev --audit-level=moderate',
    'npm test',
    'npm run typecheck',
    'npm run lint -- --max-warnings=0',
    'npm run build',
    'bash scripts/ci-container-smoke.sh',
  ]) {
    assert.match(ci, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const dependencyReview = read('.github/workflows/dependency-review.yml');
  assert.match(dependencyReview, /if: \$\{\{ github\.event\.repository\.private == false \}\}/);

  const codeql = read('.github/workflows/codeql.yml');
  assert.match(codeql, /upload: \$\{\{ github\.event\.repository\.private && 'never' \|\| 'always' \}\}/);
});

test('third-party workflow actions are pinned to immutable commit SHAs with least-privilege defaults', () => {
  for (const file of workflowFiles) {
    const source = read(`.github/workflows/${file}`);
    assert.doesNotMatch(source, /permissions:\s*write-all/);
    if (file === 'codeql.yml') {
      assert.match(source, /permissions:\n  actions: read\n  contents: read\n  security-events: write/);
    }
    for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gm)) {
      const action = match[1];
      assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/, `${file} has an unpinned action: ${action}`);
    }
  }
});

test('production dependency override and Docker context exclusions remain explicit', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.dependencies.next, '16.2.10');
  assert.equal(packageJson.devDependencies['eslint-config-next'], '16.2.10');
  assert.equal(packageJson.overrides.postcss, '8.5.15');

  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages['node_modules/next'].version, '16.2.10');
  assert.equal(lock.packages['node_modules/postcss'].version, '8.5.15');

  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^FROM node:22-slim@sha256:[0-9a-f]{64} AS runner$/m);

  const dockerIgnore = read('.dockerignore');
  for (const excluded of ['node_modules', '.env.local', '.env.*.local', '.data', 'backups', '.git']) {
    assert.match(dockerIgnore, new RegExp(`^${excluded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }

  const gitIgnore = read('.gitignore');
  for (const excluded of ['node_modules/', '.next/', '.env.*', '.data/', 'backups/']) {
    assert.match(gitIgnore, new RegExp(`^${excluded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }

  const containerSmoke = read('scripts/ci-container-smoke.sh');
  assert.match(containerSmoke, /runs_session_history !== true/);
  assert.match(containerSmoke, /Mock Hermes did not become ready/);
});
