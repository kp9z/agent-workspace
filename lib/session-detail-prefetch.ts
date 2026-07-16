export type SessionDetailPrefetchState = {
  cached: boolean;
  prefetching: boolean;
  isDraft?: boolean;
};

export function shouldPrefetchSessionDetail(sessionId: string | null | undefined, state: SessionDetailPrefetchState) {
  if (!sessionId || state.isDraft) return false;
  return !state.cached && !state.prefetching;
}

export function getSidebarSessionNavigation(sessionIds: readonly string[], currentIndex: number, direction: 1 | -1) {
  if (sessionIds.length === 0) return { sessionId: null, lookaheadSessionId: null };

  const fallbackIndex = direction > 0 ? 0 : sessionIds.length - 1;
  const nextIndex = currentIndex >= 0
    ? (currentIndex + direction + sessionIds.length) % sessionIds.length
    : fallbackIndex;
  const lookaheadIndex = (nextIndex + direction + sessionIds.length) % sessionIds.length;

  return {
    sessionId: sessionIds[nextIndex] ?? null,
    lookaheadSessionId: sessionIds[lookaheadIndex] ?? null,
  };
}
