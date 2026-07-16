# Contributing

Thank you for helping improve Agent Workspace.

## Before opening a change

- Search existing issues and pull requests.
- Use an issue for substantial features or changes to security, storage, authentication, or the Hermes protocol contract.
- Never include credentials, private chat data, production databases, or personal infrastructure details.

## Development setup

Requirements: Node.js 22 or newer and npm.

```bash
npm install
cp .env.example .env.local
npm run mock-hermes
```

In another shell:

```bash
HERMES_BASE_URL=http://127.0.0.1:8642 npm run dev
```

## Verification

Run before submitting:

```bash
npm test
npm run typecheck
npm run lint -- --max-warnings=0
npm run build
```

Add focused regression coverage for behavior changes. Tests should use temporary directories and mock runtimes rather than personal state or live credentials.

## Pull requests

Keep changes focused and explain:

- the problem and user-visible behavior
- security, migration, or compatibility impact
- tests performed
- screenshots for meaningful UI changes

Preserve migration aliases unless a documented breaking release removes them. Agent Workspace requires Hermes `features.runs_session_history: true`; do not reintroduce transcript-flattening fallback behavior.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
