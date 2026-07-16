import { getWorkspaceDebugPerfEnabled } from './workspace-env';

export function serverPerfEnabled() {
  return getWorkspaceDebugPerfEnabled();
}

export function serverPerfMark(name: string, detail?: Record<string, unknown>) {
  if (!serverPerfEnabled()) return;
  console.info(`[agent-workspace-perf] ${name}`, {
    time: Math.round(performance.now()),
    ...detail,
  });
}

export function utf8ByteLength(value: string | Uint8Array) {
  return typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength;
}

export function payloadByteLength(payload: unknown) {
  const serialized = JSON.stringify(payload);
  return serialized ? Buffer.byteLength(serialized) : 0;
}
