# Security Policy

## Supported Versions

Only the latest GitHub release is maintained.

## API Key Storage

Current versions store API keys in plaintext local configuration files under:

```text
%LOCALAPPDATA%\WindsurfCascadeProxy\
```

Do not share this directory publicly.

## Reporting a Vulnerability

If you find a security issue, please open a GitHub issue with minimal reproduction details.

Do not include real API keys, account tokens, or private endpoint URLs in public issues.

## Scope

This project is an unofficial local proxy tool. It only listens on `127.0.0.1` by design.

Users are responsible for complying with the terms of Windsurf and their upstream model providers.
