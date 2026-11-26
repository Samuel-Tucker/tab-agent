# Contributing to Tab-Agent

## Running tests locally
```bash
bun install
bun test tests/
bun run ui-check
```

`bun run ui-check` launches real headless Chromium with the unpacked extension against an isolated test daemon on port `7762` (never touching a live daemon on `7752`).

## Release & upstream sync workflow
If you maintain a private daily-driver fork alongside this public repository:
1. Keep private history and `data/` strictly in your private repo — never merge private git history directly into `main`.
2. Promote approved features via clean diffs/patches (`git diff` / selective file sync) followed by:
   - Privacy scan (zero personal paths, business names, or secrets)
   - `bun test tests/`
   - `bun run ui-check`
