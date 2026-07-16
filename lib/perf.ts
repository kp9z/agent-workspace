export function perfEnabled() {
  if (typeof window === 'undefined') return false;
  return (
    window.location.search.includes('debug=perf') ||
    window.localStorage.getItem('agent-workspace:debug:perf') === '1' ||
    window.localStorage.getItem('kira:debug:perf') === '1'
  );
}

export function perfMark(name: string, detail?: Record<string, unknown>) {
  if (typeof window === 'undefined' || !perfEnabled()) return;
  console.info(`[agent-workspace-perf] ${name}`, {
    time: Math.round(performance.now()),
    ...detail,
  });
}
