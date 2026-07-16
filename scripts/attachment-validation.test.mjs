import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { transpileTsFiles } from './test-utils/transpile-ts.mjs';

const rootDir = path.resolve(new URL('..', import.meta.url).pathname);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff]);
const gifBytes = Buffer.from('GIF89a');
const webpBytes = Buffer.from('RIFF1234WEBP');

function dataUrl(mimeType, bytes) {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

function withTempDataDir(run) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'kira-attachment-validation-'));
  process.env.HERMES_WEB_UI_DATA_DIR = dataDir;
  return Promise.resolve()
    .then(() => run(dataDir))
    .finally(() => {
      rmSync(dataDir, { recursive: true, force: true });
    });
}

test('shared attachment validator normalizes valid images and rejects malformed inputs', async () => {
  const { outDir, cleanup } = transpileTsFiles(rootDir, [
    'lib/attachments.ts',
    'lib/db.ts',
    'lib/types.ts',
    'lib/session-events.ts',
    'lib/tool-events.ts',
    'lib/workspace-env.ts',
    'lib/server-perf.ts',
    'lib/store.ts',
  ]);
  const tempNodeModules = path.join(outDir, 'node_modules');
  mkdirSync(tempNodeModules, { recursive: true });
  mkdirSync(path.join(tempNodeModules, '@'), { recursive: true });
  symlinkSync(path.join(rootDir, 'node_modules', 'better-sqlite3'), path.join(tempNodeModules, 'better-sqlite3'), 'dir');
  symlinkSync(path.join(outDir, 'lib'), path.join(tempNodeModules, '@', 'lib'), 'dir');
  try {
    await withTempDataDir(async () => {
      const require = createRequire(import.meta.url);
      const { validateAttachments, MAX_IMAGE_BYTES, sanitizeAttachmentName, normalizeAttachmentId } = require(path.join(outDir, 'lib/attachments.js'));
      const { attachmentDir, attachmentFilePath, isSafeAttachmentFilePath } = require(path.join(outDir, 'lib/store.js'));

      const validCases = [
        { mimeType: 'image/png', bytes: pngBytes, name: '  名/字\u0000  ', expectedName: '名字' },
        { mimeType: 'image/jpeg', bytes: jpegBytes, name: '  photo\\name  ', expectedName: 'photoname' },
        { mimeType: 'image/gif', bytes: gifBytes, name: '  gif\u0001 name  ', expectedName: 'gif name' },
        { mimeType: 'image/webp', bytes: webpBytes, name: '  webp/名  ', expectedName: 'webp名' },
      ];

      const attachments = validCases.map((entry, index) => validateAttachments([{
        id: index === 0 ? '550E8400-E29B-41D4-A716-446655440000' : index === 1 ? 'not-a-uuid' : undefined,
        type: 'image',
        name: entry.name,
        mime_type: entry.mimeType,
        data_url: dataUrl(entry.mimeType, entry.bytes),
        size_bytes: entry.bytes.length,
      }])[0]);

      assert.equal(attachments.length, 4);
      assert.equal(attachments[0].id, '550e8400-e29b-41d4-a716-446655440000');
      for (const [index, attachment] of attachments.entries()) {
        assert.equal(attachment.type, 'image');
        assert.equal(attachment.mime_type, validCases[index].mimeType);
        assert.equal(attachment.name, validCases[index].expectedName);
        assert.equal(attachment.data_url, dataUrl(validCases[index].mimeType, validCases[index].bytes));
        assert.equal(attachment.size_bytes, validCases[index].bytes.length);
      }
      assert.match(attachments[1].id, uuidPattern);

      assert.equal(sanitizeAttachmentName('  a\u0000b/\\c\r\n  ', 7), 'abc');
      assert.equal(sanitizeAttachmentName('   ', 7), 'image-7');
      assert.equal(normalizeAttachmentId('550E8400-E29B-41D4-A716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
      assert.match(normalizeAttachmentId('malicious/../../id'), uuidPattern);

      const validPath = attachmentFilePath({ id: '550E8400-E29B-41D4-A716-446655440000', mime_type: 'image/png' });
      const invalidPath = attachmentFilePath({ id: 'malicious/../../id', mime_type: 'image/png' });
      const repeatedInvalidPath = attachmentFilePath({ id: 'malicious/../../id', mime_type: 'image/png' });
      const attachmentRoot = path.resolve(attachmentDir());
      assert.equal(path.resolve(validPath).startsWith(`${attachmentRoot}${path.sep}`), true);
      assert.equal(path.resolve(invalidPath).startsWith(`${attachmentRoot}${path.sep}`), true);
      assert.equal(path.basename(validPath), '550e8400-e29b-41d4-a716-446655440000.png');
      assert.match(path.basename(invalidPath), /^legacy-[0-9a-f]{32}\.png$/);
      assert.equal(repeatedInvalidPath, invalidPath);
      assert.equal(isSafeAttachmentFilePath('/etc/passwd'), false);

      assert.throws(() => validateAttachments(['not-an-object']), /attachment 1 is invalid/);
      assert.throws(() => validateAttachments([{ id: 'bad', type: 'image', name: 'x', mime_type: 'image/png', data_url: 'data:image/png;base64,AAAAA', size_bytes: 3 }]), /canonical base64/);
      assert.throws(() => validateAttachments([{ id: 'bad', type: 'image', name: 'x', mime_type: 'image/png', data_url: 'data:image/png;base64,AAAA AAAA', size_bytes: 6 }]), /canonical base64/);
      assert.throws(() => validateAttachments([{ id: 'bad', type: 'image', name: 'x', mime_type: 'image/png', data_url: 'data:image/png;base64,', size_bytes: 0 }]), /must not be empty/);
      assert.throws(() => validateAttachments([{ id: 'bad', type: 'image', name: 'x', mime_type: 'image/png', data_url: `data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')}`, size_bytes: MAX_IMAGE_BYTES + 1 }]), /between 1 byte and 4194304 bytes/);
      assert.throws(() => validateAttachments([{ id: 'bad', type: 'image', name: 'x', mime_type: 'image/png', data_url: dataUrl('image/png', pngBytes), size_bytes: pngBytes.length + 1 }]), /must match decoded image length/);
      assert.throws(() => validateAttachments([{ id: 'bad', type: 'image', name: 'x', mime_type: 'image/png', data_url: dataUrl('image/png', pngBytes), size_bytes: 3.5 }]), /positive safe integer/);
      assert.throws(() => validateAttachments([{ id: 'bad', type: 'image', name: 'x', mime_type: 'image/png', data_url: dataUrl('image/png', pngBytes), size_bytes: '8' }]), /positive safe integer/);
      assert.throws(() => validateAttachments([{ id: 'bad', type: 'image', name: 'x', mime_type: 'image/png', data_url: dataUrl('image/jpeg', jpegBytes), size_bytes: jpegBytes.length }]), /matching data URL/);
      assert.throws(() => validateAttachments([{ id: 'bad', type: 'image', name: 'x', mime_type: 'image/jpeg', data_url: dataUrl('image/jpeg', pngBytes), size_bytes: pngBytes.length }]), /jpeg signature/);
      assert.throws(() => validateAttachments([{ id: 'bad', type: 'image', name: 'x', mime_type: 'image/gif', data_url: dataUrl('image/gif', pngBytes), size_bytes: pngBytes.length }]), /gif signature/);
      assert.throws(() => validateAttachments([{ id: 'bad', type: 'image', name: 'x', mime_type: 'image/webp', data_url: dataUrl('image/webp', pngBytes), size_bytes: pngBytes.length }]), /webp signature/);
      assert.throws(() => validateAttachments([{ id: 'bad', type: 'image', name: 'x', mime_type: 'image/png', data_url: dataUrl('image/png', pngBytes), size_bytes: pngBytes.length }, { id: 'bad2', type: 'image', name: 'x', mime_type: 'image/png', data_url: dataUrl('image/png', pngBytes), size_bytes: pngBytes.length }, { id: 'bad3', type: 'image', name: 'x', mime_type: 'image/png', data_url: dataUrl('image/png', pngBytes), size_bytes: pngBytes.length }, { id: 'bad4', type: 'image', name: 'x', mime_type: 'image/png', data_url: dataUrl('image/png', pngBytes), size_bytes: pngBytes.length }]), /at most 3 attachments are supported/);
      assert.throws(() => validateAttachments([{ id: 'bad', type: 'image', name: 'x', mime_type: 'image/bmp', data_url: 'data:image/bmp;base64,AAAA', size_bytes: 3 }]), /unsupported image type/);
    });
  } finally {
    cleanup();
  }
});

test('message and queue routes import the shared attachment validator', () => {
  const messageRouteSource = readFileSync(path.join(rootDir, 'app/api/sessions/[id]/messages/route.ts'), 'utf8');
  const queueRouteSource = readFileSync(path.join(rootDir, 'app/api/queue/route.ts'), 'utf8');
  for (const source of [messageRouteSource, queueRouteSource]) {
    assert.match(source, /from '@\/lib\/attachments'/);
    assert.equal(/function validateAttachments\(/.test(source), false);
    assert.equal(/const MAX_ATTACHMENTS/.test(source), false);
  }
});

