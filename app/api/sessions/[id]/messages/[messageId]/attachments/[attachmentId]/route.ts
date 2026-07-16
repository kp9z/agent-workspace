import { existsSync, readFileSync } from 'node:fs';
import { getDb } from '@/lib/db';
import { serverPerfMark } from '@/lib/server-perf';
import { isSafeAttachmentFilePath } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AttachmentRow = {
  id: string;
  message_id: string;
  session_id: string;
  name: string;
  mime_type: string;
  data_url: string | null;
  file_path: string | null;
  size_bytes: number;
};

function attachmentBytes(row: AttachmentRow) {
  if (row.file_path) {
    if (!isSafeAttachmentFilePath(row.file_path) || !existsSync(row.file_path)) return null;
    return readFileSync(row.file_path);
  }
  if (!row.data_url) return null;
  const [, base64 = ''] = row.data_url.split(',', 2);
  return base64 ? Buffer.from(base64, 'base64') : null;
}

function safeFilename(name: string) {
  const trimmed = name.trim().replace(/[\r\n"\\]/g, '_');
  return trimmed.slice(0, 120) || 'attachment';
}

export async function GET(_request: Request, context: { params: Promise<{ id: string; messageId: string; attachmentId: string }> }) {
  const { id, messageId, attachmentId } = await context.params;
  const row = getDb().prepare(`
    select
      attachments.id,
      attachments.message_id,
      messages.session_id,
      attachments.name,
      attachments.mime_type,
      attachments.data_url,
      attachments.file_path,
      attachments.size_bytes
    from attachments
    join messages on messages.id = attachments.message_id
    where attachments.id = ? and messages.id = ? and messages.session_id = ?
  `).get(attachmentId, messageId, id) as AttachmentRow | undefined;

  if (!row) return Response.json({ error: 'Attachment not found' }, { status: 404 });

  const bytes = attachmentBytes(row);
  if (!bytes) return Response.json({ error: 'Attachment not found' }, { status: 404 });

  serverPerfMark('attachment:serve', {
    session_id: id,
    message_id: messageId,
    attachment_id: attachmentId,
    bytes: bytes.length,
  });

  return new Response(bytes, {
    headers: {
      'Content-Type': row.mime_type,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      'Content-Disposition': `inline; filename="${safeFilename(row.name)}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
