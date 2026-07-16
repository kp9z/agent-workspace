#!/usr/bin/env bash
set -euo pipefail

image_tag="agent-workspace:ci"
container_name="agent-workspace-ci-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$"
mock_log="$(mktemp)"
mock_pid=''

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  if [[ -n "$mock_pid" ]]; then
    kill "$mock_pid" >/dev/null 2>&1 || true
    wait "$mock_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$mock_log"
}
trap cleanup EXIT

docker build --tag "$image_tag" .
MOCK_HERMES_PORT=8642 node scripts/mock-hermes.mjs >"$mock_log" 2>&1 &
mock_pid=$!

mock_ready=false
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8642/health >/dev/null 2>&1; then
    mock_ready=true
    break
  fi
  sleep 1
done
if [[ "$mock_ready" != true ]]; then
  echo 'Mock Hermes did not become ready.' >&2
  cat "$mock_log" >&2
  exit 1
fi

docker run -d --name "$container_name" --network host \
  --tmpfs /app/.data \
  -e AGENT_WORKSPACE_AUTH_MODE=none \
  -e HERMES_BASE_URL=http://127.0.0.1:8642 \
  "$image_tag" >/dev/null

for attempt in $(seq 1 30); do
  if body="$(curl -fsS http://127.0.0.1:3100/api/runtime/health 2>/dev/null)"; then
    if HEALTH_BODY="$body" node -e '
      const health = JSON.parse(process.env.HEALTH_BODY || "null");
      if (health?.status !== "ok" || health?.capabilities?.features?.runs_session_history !== true) {
        process.exit(1);
      }
    '; then
      exit 0
    fi
  fi
  sleep 1
done

echo 'Agent Workspace container did not become healthy.' >&2
docker logs "$container_name" >&2 || true
cat "$mock_log" >&2
exit 1
