# Agent Workspace

Agent Workspace is a self-hosted, mobile-friendly browser workspace for [Hermes Agent](https://github.com/NousResearch/hermes-agent). It combines persistent chats, projects, image attachments, queued follow-ups, run streaming, approvals, steering, and SQLite-backed history in a compact Next.js PWA.

> **Project status:** pre-1.0 and intended for self-hosting. Review the security and deployment guidance before exposing it to a network.

## Highlights

- Persistent SQLite sessions, messages, tool events, attachments, queue state, pins, and archives
- Stable Hermes `/v1/runs` sessions with reconnectable SSE progress
- Project-scoped system prompts
- Stop, approval, and steering controls
- Image paste/upload for PNG, JPEG, GIF, and WebP
- Google OAuth, shared-secret authentication, or explicit private-network mode
- Same-origin request checks, bounded request bodies, validated image signatures, security headers, and bounded rate limiting
- Online SQLite backup and guarded atomic restore
- Configurable product, agent, and user display names

## Requirements

- Node.js 22 or newer
- npm
- A Hermes API Server reachable from Agent Workspace
- A Hermes release that reports:

  ```json
  {
    "features": {
      "runs_session_history": true
    }
  }
  ```

  This capability is provided by [Hermes Agent PR #52827](https://github.com/NousResearch/hermes-agent/pull/52827). Agent Workspace fails closed when persistent `/v1/runs` history is unavailable rather than silently flattening prior transcripts.

## Quick start with the mock runtime

```bash
cp .env.example .env.local
npm install
npm run mock-hermes
```

In another shell:

```bash
HERMES_BASE_URL=http://127.0.0.1:8642 npm run dev
```

Open <http://127.0.0.1:3100>.

The mock supports deterministic `tool`, `approval`, `slow`, `error`, `remember <text>`, and image scenarios.

## Connect a real Hermes runtime

Set at minimum:

```dotenv
HERMES_BASE_URL=http://127.0.0.1:8642
HERMES_API_KEY=
```

The API key is optional when the Hermes API Server does not require bearer authentication. Agent Workspace also sends a stable `X-Hermes-Session-Key` value, configurable through `AGENT_WORKSPACE_SESSION_KEY`.

## Authentication

Production fails closed unless authentication resolves to a complete valid configuration. Setting `AGENT_WORKSPACE_AUTH_MODE` explicitly is recommended. When it is omitted, a complete Google configuration or a valid shared secret is inferred; absent, partial, or invalid configuration is rejected.

### Google OAuth

```dotenv
AGENT_WORKSPACE_AUTH_MODE=google
APP_BASE_URL=https://workspace.example.com
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_ALLOWED_EMAILS=you@example.com
AUTH_COOKIE_SECRET=
```

`APP_BASE_URL` must be an HTTPS origin outside loopback development. Configure `${APP_BASE_URL}/api/auth/callback` in the Google OAuth client.

### Shared secret

```dotenv
AGENT_WORKSPACE_AUTH_MODE=shared-secret
APP_SHARED_SECRET=use-at-least-24-random-characters
```

Clients use HTTP Basic authentication. The username is ignored and the password is the shared secret.

### Private-network mode

```dotenv
AGENT_WORKSPACE_AUTH_MODE=none
```

Use `none` only when a trusted private network or authenticated reverse proxy is the access boundary. It is never selected implicitly in production.

## Data, backup, and restore

Workspace state is stored in `${HERMES_WEB_UI_DATA_DIR:-.data}/agent-workspace.sqlite` using SQLite WAL mode. Existing installations containing only `kira-workspace.sqlite` continue using that file in place.

Create a transactionally consistent online backup, even while the app is running:

```bash
npm run backup
# or: npm run backup -- /safe/path/workspace.sqlite
```

Restore only after stopping Agent Workspace:

```bash
npm run restore -- --confirm-stopped /safe/path/workspace.sqlite
```

Restore validates the source, refuses when destination WAL/SHM sidecars are present, atomically swaps the database, and preserves the previous database as a rollback file.

## Development

```bash
npm test
npm run typecheck
npm run lint -- --max-warnings=0
npm run build
```

Useful commands:

- `npm run dev` — development server on `127.0.0.1:3100`
- `npm run mock-hermes` — stateful local Hermes simulator
- `npm run smoke:mock-hermes` — smoke test against the simulator
- `npm run smoke` — smoke test against a running deployment
- `npm run backup` / `npm run restore` — SQLite recovery tools

## Deployment

See [docs/deployment.md](docs/deployment.md) for Docker, reverse-proxy, authentication, persistence, and recovery guidance.

## Security and community

- [Security policy](SECURITY.md)
- [Contributing guide](CONTRIBUTING.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Support](SUPPORT.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
