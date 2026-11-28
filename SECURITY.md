# Security policy

## Supported versions

Security fixes are applied to the default branch and to the current major
release line (currently `v0.x`). Release tags matching `v*.*.*` are immutable.
The floating major tag (`v0`) is moved by the release workflow.

## Reporting a vulnerability

Please report security issues privately. Do not open a public GitHub
issue for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/toyamagu-2021/github-s3-artifact/security/advisories/new)
for this repository. If that form is unavailable, email the repository
owner through the address on their GitHub profile.

Include the affected version or commit, the component, and a short
description of the impact. Please allow time for a fix before any
public disclosure.

## Dependencies

This project uses npm packages and GitHub Actions. Dependency updates are
opened by Dependabot.

## AWS end-to-end workflow

`.github/workflows/aws-e2e.yml` is opt-in (`AWS_E2E_ENABLED`), assumes a role
with GitHub OIDC, and is not a required status check. It does not run on
pull requests. Presigned URLs for its test objects remain in the Actions UI
for five minutes.
