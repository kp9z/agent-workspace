import { getSession } from '@/lib/store';
import { serverPerfMark, utf8ByteLength } from '@/lib/server-perf';
import { sessionEventName, subscribeToSession } from '@/lib/session-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function encodeSse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function enqueueSse(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, event: string, payload: unknown) {
  const frame = encodeSse(event, payload);
  const frameBytes = utf8ByteLength(frame);
  serverPerfMark('sse:event', {
    event,
    payload_bytes: frameBytes,
    sse_bytes: frameBytes,
  });
  controller.enqueue(encoder.encode(frame));
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getSession(id);
  if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      enqueueSse(controller, encoder, 'session', session);
      unsubscribe = subscribeToSession(id, (event) => {
        try {
          enqueueSse(controller, encoder, sessionEventName(event), event.type === 'snapshot' ? event.session : event);
        } catch {
          unsubscribe?.();
        }
      });
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          unsubscribe?.();
        }
      }, 15_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
