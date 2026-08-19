# Security Policy

## Supported Version

Security updates are applied to the latest `main` branch.

## Reporting a Vulnerability

Do not open a public issue for suspected credential exposure, authentication bypass, remote code execution, or data disclosure. Contact the repository owner privately with:

- the affected revision and component;
- reproducible steps with sensitive values removed;
- expected and observed behavior;
- an assessment of impact;
- a suggested mitigation when available.

The maintainer will acknowledge a complete report, reproduce the issue, coordinate a fix, and publish remediation details after affected deployments have had time to update.

## Deployment Guidance

- Keep `.env`, `.env.local`, private keys, logs, database volumes, and index data outside source control.
- Bind model and index services to trusted networks.
- Use dedicated credentials with the minimum required index permissions.
- Rotate credentials immediately if they appear in terminal output, screenshots, commits, or build artifacts.
- Put an authenticated HTTPS reverse proxy in front of port 9222 before exposing a deployment to untrusted networks.
