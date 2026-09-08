# frontend/dev - development-only helpers

Nothing in this directory ships. Vite bundles only what `index.html` imports and
`tsconfig.json` includes only `src/`, so `dev/` is excluded from `vite build` and from
`tsc`.

## mock-server.mjs

A tiny `node:http` server that returns SPEC-shaped sample data (`shared/types.ts`) so the UI can be exercised without ClickHouse, Google ADK, Gemini or
`mcp-clickhouse`. It simulates `POST /runs` progressing through the run phases,
approvals, SRT export, recheck (4 → 0) and reset. All rows, traces and verdicts are
hard-coded samples mirroring the hero values - it is a UI harness, not evidence.

```sh
# terminal 1 - mock API on :8790 (never uses :8787, which belongs to the real backend)
npm --prefix frontend run mock

# terminal 2 - dev server proxying /api to the mock
LOCALELOCK_API_PROXY=http://127.0.0.1:8790 npm --prefix frontend run dev

# or the production build served by vite preview against the mock
npm --prefix frontend run build
LOCALELOCK_API_PROXY=http://127.0.0.1:8790 npm --prefix frontend run preview
```

Environment knobs:

| Variable | Effect |
|---|---|
| `MOCK_PORT` | listen port (default 8790) |
| `MOCK_RESET_KEY` | when set, `POST /admin/reset` requires `X-Demo-Key` (exercises the 401 → key prompt path) |
| `MOCK_FAIL_PHASE` | every new run fails in that phase (`event_received`, `querying_clickhouse`, `deterministic_qc`, `gemini_semantic_review`, `producer_decision`) |
| `MOCK_FALLBACK=1` | marks Q5 as an `app_fallback` trace entry (warning badge path) |
| `MOCK_SPEED` | multiplier for phase timers (e.g. `3` = three times faster) |
| `MOCK_REPO_URL` | value for `links.repo` on `/judge/status` |
