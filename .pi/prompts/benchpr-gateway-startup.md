---
description: Compare current branch vs origin/main for dist gateway startup
---

Input

- Optional base worktree path: $1
  - If missing, use `../openclaw-main-bench`.

Do

Goal: produce a production-like gateway startup comparison for the current branch vs `origin/main`, focused on the Slack-configured startup case from built `dist` artifacts.

1. Fetch `origin/main`.
2. Ensure a detached baseline worktree exists at the chosen path on `origin/main`.
3. In both worktrees:
   - run `pnpm install` if `node_modules` is missing
   - run `pnpm build`
4. From the current branch worktree, run the same benchmark harness twice:

```sh
pnpm test:startup:gateway:slack -- \
  --runs 5 --warmup 1 \
  --output .artifacts/gateway-startup-pr.json

pnpm test:startup:gateway:slack -- \
  --entry <BASE_WORKTREE>/dist/entry.js \
  --runs 5 --warmup 1 \
  --output .artifacts/gateway-startup-main.json
```

5. Compare these metrics for `slackConfiguredSkipChannels`:
   - `summary.readyzMs`
   - `summary.readyLogMs`
   - `summary.healthzMs`
   - `summary.startupTrace`
   - `summary.pluginLoadProfile`
6. Report the before/after delta with command lines used.
7. Prepare PR-ready verification text that lists:
   - benchmark commands
   - test/build commands run
   - whether the branch is faster/slower/noise-level vs `origin/main`

Notes

- `test:startup:gateway:slack` uses built `dist` output, disables bundled-entry source fallback, preserves a fresh per-run Node compile cache, and keeps `OPENCLAW_SKIP_CHANNELS=1` so the benchmark measures startup registration cost without live Slack connection noise.
- Do not merge or push automatically.
