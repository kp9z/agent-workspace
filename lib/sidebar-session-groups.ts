import type { SessionSummaryLike } from './session-merge';

export function groupProjectSessions<T extends SessionSummaryLike>(sessions: readonly T[]) {
  const grouped = new Map<string, T[]>();
  for (const session of sessions) {
    if (!session.project_id) continue;
    const existing = grouped.get(session.project_id);
    if (existing) existing.push(session);
    else grouped.set(session.project_id, [session]);
  }
  return grouped;
}

export function buildPinnedSessionNumbers<T extends { id: string }>(sessions: readonly T[]) {
  return new Map(sessions.map((session, index) => [session.id, index + 1] as const));
}

export function sortSessionsByPinnedNumber<T extends { id: string }>(sessions: T[], pinnedSessionNumbers: ReadonlyMap<string, number>) {
  sessions.sort((a, b) => {
    const aPin = pinnedSessionNumbers.get(a.id);
    const bPin = pinnedSessionNumbers.get(b.id);
    if (aPin && bPin) return aPin - bPin;
    if (aPin) return -1;
    if (bPin) return 1;
    return 0;
  });
  return sessions;
}
