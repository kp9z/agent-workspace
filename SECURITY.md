# Security policy

## Supported versions

Agent Workspace is pre-1.0. Security fixes are applied to the latest release and the default branch.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use private vulnerability reporting from the repository's **Security** tab. If that feature is unavailable, contact the maintainer privately through the contact method on the repository owner's GitHub profile.

Include:

- affected version or commit
- reproduction steps or proof of concept
- expected impact
- suggested mitigation, if known

Do not access data that is not yours, disrupt a deployment, or publish details before a fix is available. You should receive an acknowledgement within seven days. Timelines for validation, remediation, and disclosure depend on severity and complexity.

## Deployment responsibility

Agent Workspace is self-hosted. Operators are responsible for TLS termination, network exposure, secrets, OAuth configuration, Hermes API access, backups, and updates. Production authentication fails closed unless explicitly configured; `AGENT_WORKSPACE_AUTH_MODE=none` is suitable only behind a trusted private access boundary.
