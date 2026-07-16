# Deployment guide

Agent Workspace is a self-hosted web application and should normally run behind an HTTPS reverse proxy. The provided Compose configuration uses host networking and binds Next.js to `127.0.0.1:3100`; adapt it deliberately for your environment.

## 1. Prepare the environment

```bash
cp .env.example .env.local
```

Core settings:

- `HERMES_BASE_URL`: Hermes API Server URL reachable from the host
- `HERMES_API_KEY`: optional Hermes bearer token
- `HERMES_RUNTIME_NAME`, `HERMES_PROFILE`, `HERMES_EXECUTION_HOST`: UI labels
- `HERMES_WEB_UI_DATA_DIR`: data directory; defaults to `.data` locally and `/app/.data` in Docker
- `HERMES_WEB_UI_BACKUP_DIR`: optional default backup destination directory

The Hermes runtime must return `features.runs_session_history: true` from `/v1/capabilities`. See Hermes Agent PR #52827.

## 2. Configure application authentication

Production requires a complete valid authentication configuration. Set `AGENT_WORKSPACE_AUTH_MODE` explicitly where possible. If it is omitted, Agent Workspace infers Google mode only from a complete Google configuration or shared-secret mode from a valid secret; absent, partial, and invalid configurations fail closed.

### Google

Set `AGENT_WORKSPACE_AUTH_MODE=google` plus `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, a nonempty `GOOGLE_ALLOWED_EMAILS`, a separate `AUTH_COOKIE_SECRET`, and an HTTPS `APP_BASE_URL`.

Authorize this redirect URI:

```text
${APP_BASE_URL}/api/auth/callback
```

### Shared secret

Set `AGENT_WORKSPACE_AUTH_MODE=shared-secret` and an `APP_SHARED_SECRET` of at least 24 random characters.

### Private network

Set `AGENT_WORKSPACE_AUTH_MODE=none` only when a trusted private network or authenticated proxy provides the access boundary. Do not expose this mode directly to the public internet.

## 3. Build and start

The Dockerfile packages a host-built Next.js standalone output:

```bash
npm install
npm run build
docker compose up -d --build
```

Check health:

```bash
curl -fsS http://127.0.0.1:3100/api/runtime/health
```

A healthy response also confirms the required Hermes session-history capability.

## 4. Reverse proxy

Terminate TLS at a trusted reverse proxy and forward to `127.0.0.1:3100`. Preserve the original scheme and client address using proxy-managed headers. Do not accept client-supplied forwarding headers unchanged.

Agent Workspace's in-memory rate limits are per process. They use the first `X-Forwarded-For` value, then `X-Real-IP`, then a shared unknown bucket. Multi-process or multi-instance deployments should enforce an additional distributed limit at the proxy or edge.

The app emits CSP, HSTS in production, anti-framing, MIME-sniffing, referrer, permissions, COOP/CORP, and API no-store headers. The current CSP retains `unsafe-inline` for Next.js compatibility.

## 5. Persistence

Mount the data directory persistently. Compose uses the `hermes-web-ui-data` volume at `/app/.data`.

The canonical database is `agent-workspace.sqlite`. For migration compatibility, an existing-only `kira-workspace.sqlite` is used in place when the canonical file is absent.

### Online backup

Backups are safe while the app is running:

```bash
npm run backup
npm run backup -- /safe/path/agent-workspace.sqlite
```

The script uses SQLite's online backup API, validates the result with `quick_check`, and refuses to overwrite an existing path.

### Restore

Stop Agent Workspace first:

```bash
docker compose down
npm run restore -- --confirm-stopped /safe/path/agent-workspace.sqlite
docker compose up -d
```

Restore refuses to proceed if destination `-wal` or `-shm` sidecars remain. Investigate why they exist and confirm no process has the database open; do not remove active sidecars. A successful restore preserves the previous database beside it as a timestamped `.pre-restore-...sqlite` rollback file.

## 6. Verification

```bash
npm test
npm run typecheck
npm run lint -- --max-warnings=0
npm run smoke
curl -fsS http://127.0.0.1:3100/api/runtime/health
```

For persistence verification, create a disposable session, back up the database, restart the service, and confirm the session remains available. Test restore only with a disposable deployment before relying on it operationally.
