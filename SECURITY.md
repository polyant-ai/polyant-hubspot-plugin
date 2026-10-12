# Security Policy

## Supported versions

Security fixes are applied to the `main` branch and to the latest tagged release.
Older releases are not maintained.

## Reporting a vulnerability

Please do not open a public GitHub issue to report a security vulnerability.

Use GitHub's private vulnerability reporting instead:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue: steps to reproduce, affected version, and impact.

If private reporting is not available, email `security@polyant.ai` with the same details.

### What to expect

- We acknowledge reports within 48 hours.
- We aim to triage and confirm within 7 days.
- We target a fix within 30 days for high-severity issues.
- We coordinate disclosure with the reporter and credit them in the release notes
  unless they prefer to stay anonymous.

### Scope

In scope: leaking or mishandling the HubSpot private app token, requests sent to
HubSpot with a record or owner the caller is not entitled to, injection through tool
inputs, and unsafe handling of uploaded file content.

Out of scope: misconfiguration of the HubSpot private app (for example scopes wider
than the agent needs), and issues in third-party dependencies that do not affect this
plugin's code paths (report those upstream).
