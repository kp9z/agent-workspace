import type { Attachment, Message, ToolEvent } from './types';

function attachmentSignature(attachment: Attachment) {
  return JSON.stringify([
    attachment.id,
    attachment.type,
    attachment.name,
    attachment.mime_type,
    attachment.url ?? '',
    attachment.data_url ?? '',
    attachment.size_bytes,
  ]);
}

function toolEventSignature(toolEvent: ToolEvent) {
  return JSON.stringify([
    toolEvent.id,
    toolEvent.tool_call_id ?? '',
    toolEvent.tool_name,
    toolEvent.phase,
    toolEvent.summary,
    toolEvent.status ?? '',
    toolEvent.output ?? '',
    toolEvent.created_at,
    toolEvent.updated_at ?? '',
  ]);
}

export function messageRenderSignature(message: Message) {
  return JSON.stringify([
    message.id,
    message.role,
    message.status,
    message.created_at,
    message.content,
    message.attachments?.map(attachmentSignature) ?? [],
    message.tool_events?.map(toolEventSignature) ?? [],
    typeof message.metadata?.render_version === 'number' || typeof message.metadata?.render_version === 'string'
      ? message.metadata.render_version
      : '',
  ]);
}
