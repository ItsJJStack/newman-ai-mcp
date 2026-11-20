# Contributing

Thanks for considering a contribution to `newman-ai-mcp`.

## Development setup

- Node.js 20 or newer
- npm

Clone the repository, install the locked dependencies, then build and test:

```bash
git clone https://github.com/ItsJJStack/newman-ai-mcp.git
cd newman-ai-mcp
npm ci
npm run build
npm test
```

## Before opening a pull request

- Keep changes focused and explain the user-facing effect.
- Add or update tests for behavior changes.
- Run `npm run build` and `npm test`; include their results in the pull request.
- Do not add API keys, tokens, passwords, private collection/environment data, or URLs containing credentials to code, tests, logs, or issues.
- Keep fixture data synthetic. Do not modify fixtures unless the change specifically requires it and explains why.
- Do not add dependencies without explaining why they are needed.
- Preserve the MCP stdio contract: diagnostics must not be written to stdout.

## Pull requests

Open a pull request against `main`. Complete the pull request template and describe any security, compatibility, or migration impact. A maintainer may ask for changes before merging.

## Issues

Use the bug report, feature request, or documentation issue form so maintainers get the context needed to triage the report. For questions or setup help, use GitHub Discussions if enabled. Never include secrets, private collection/environment data, or exploit details in a public issue.

## Reporting security issues

Use the private process in [SECURITY.md](SECURITY.md). Do not disclose an exploitable vulnerability in a public issue.
