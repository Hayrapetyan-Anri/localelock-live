# LocaleLock Live

A release gate for subtitles. It checks whether a localized version of a film can ship, shows what's wrong, and lets a producer fix it and re-check.

Live app: https://d2du1guhsljezu.cloudfront.net
Judge page: https://d2du1guhsljezu.cloudfront.net/judge

Built for the Agentic Cinema hackathon, ClickHouse track. Uses the Agent Development Kit (ADK) for TypeScript with Gemini 2.5 Flash, talking to ClickHouse Cloud through the official `mcp-clickhouse` server.

## The problem

A film goes out in twenty countries on the same day. Two hours before launch the Spanish subtitles come back from the vendor, and the director has changed a line of English dialogue since that translation was made. Can it legally ship in that locale? Today someone opens the file and reads it.

## What it does

The gate runs over one delivery and returns the blockers with the rows behind each one. A producer approves the repairs, the app writes a corrected SRT, ingests it as a new version, and runs the gate again. The demo goes from `RELEASE HELD / 4 blockers` to `READY TO RELEASE / 0`, and that last state is a stored run computed from queries, not a UI flag.

Three of the four checks are plain SQL: cue overlap, reading speed, glossary drift. Those are arithmetic, and a model has no business guessing at them. Gemini handles the one thing SQL can't, which is whether a translated line still means what the source means. It gets a single source/target pair rather than the file, and a human still approves the result.

The agent can't write. The MCP server runs with `CLICKHOUSE_ALLOW_WRITE_ACCESS=false` and connects as a `localelock_agent` user that holds only `GRANT SELECT` with `readonly=1`, so a write is refused by ClickHouse itself. Findings, approvals and new versions are written by the app over its own connection, after someone approves.

## The demo

1. Two hours before release. The producer opens *The Last Tram*, Spanish (Latin America), v7, and sees RELEASE HELD with 4 blockers, a countdown, the vendor delivery, and the source revision r3 that changed line 231 after the translation was made.
2. One click starts a persisted run. An ADK `LlmAgent` on Gemini 2.5 Flash works through a fixed six-query plan using `list_tables` and `run_query` against ClickHouse Cloud. Each tool call lands in a trace with the sanitized SQL, duration and row count.
3. The four blockers:
   - Cue 118 overlaps cue 119 by 420 ms, found with a `leadInFrame` window function.
   - Cue 204 reads at 24.6 CPS against a 20 CPS limit, 59 code points in 2.4 s.
   - The glossary says Mara Voss and the delivery says Maria Voss.
   - Cue 231 changed in the source after the vendor translated against r2. Gemini sees only that pair, `Do not send it yet.` against `Envialo ahora.`, and returns MEANING_REVERSED with a suggested line.
4. Every card says what failed, which cue and version, the evidence, the repair, and how bad it is. The Gemini suggestion has to be approved by hand.
5. Export and recheck. The app applies the repairs, re-verifies them, builds `the-last-tram.es.v8.approved.srt`, stores `patch_hash = sha256(srt)` and ingests v8. Clicking twice is harmless.
6. READY TO RELEASE, 0 blockers. The agent queries v8 and the overlap, reading-speed and glossary queries come back empty, and Gemini calls the corrected pair MEANING_PRESERVED. Refresh and it holds. There's a reset link in the footer for the next run.

## Architecture

```text
  Vendor delivery v7 / source revision r3     (localization_events in ClickHouse Cloud)
        |
        v
  Frontend (React + Vite, S3 + CloudFront) --POST /runs--> API Gateway --> ApiFunction (Lambda, 29 s)
                                                                              | async invoke
                                                                              v
                                                                   WorkerFunction (Lambda, 10 min)
                                                                              |
                              ADK LlmAgent + Gemini 2.5 Flash
                                                                              |
                              official mcp-clickhouse server (stdio, read-only)
                                                                              |
                              ClickHouse Cloud (128,452 synthetic rows)
                                                                              |
              deterministic rules on the returned rows  ->  4 blockers  ->  RELEASE HELD
                                                                              |
              producer approves  ->  corrected SRT (sha256)  ->  v8 ingested by the app
                                                                              |
              second agent run through mcp-clickhouse  ->  READY / 0
```

## Where things live

| | |
|---|---|
| ADK agent driving the query plan | [`backend/src/agent/releaseGateAgent.ts`](backend/src/agent/releaseGateAgent.ts) |
| ADK agent for the semantic review | [`backend/src/agent/semanticReviewer.ts`](backend/src/agent/semanticReviewer.ts) |
| Gemini model construction | [`backend/src/agent/gemini.ts`](backend/src/agent/gemini.ts) |
| `mcp-clickhouse` spawn and protocol | [`backend/src/agent/mcp.ts`](backend/src/agent/mcp.ts) |
| One pooled MCP process per run | [`backend/src/agent/pooledToolset.ts`](backend/src/agent/pooledToolset.ts) |
| The six queries the agent runs | [`backend/src/domain/queries.ts`](backend/src/domain/queries.ts) |
| Schema, client and writes | [`backend/src/db/clickhouse.ts`](backend/src/db/clickhouse.ts) |
| Catalog-wide analytics | [`backend/src/domain/catalog.ts`](backend/src/domain/catalog.ts) |

## Running it locally

Needs Node 22+, Docker and Python 3.11+.

```bash
# 1. ClickHouse for development
docker run -d --name ll-ch -p 8123:8123 -e CLICKHOUSE_PASSWORD=localdev -e CLICKHOUSE_DB=localelock clickhouse/clickhouse-server:latest

# 2. Dependencies, plus the MCP server in a repo-local venv
npm --prefix backend install && npm --prefix frontend install
python3 -m venv backend/.venv && backend/.venv/bin/pip install mcp-clickhouse==0.6.0

# 3. Secrets (never committed)
cp .env.example ~/.localelock/.env && $EDITOR ~/.localelock/.env

# 4. Seed the synthetic rows, then run the loop from the terminal
npm --prefix backend run seed -- --force
npm --prefix backend run run-gate

# 5. App on http://localhost:5173, API on :8787
npm --prefix backend run dev &
npm --prefix frontend run dev
```

`npm --prefix backend test` runs the unit suite. `scripts/e2e-local.sh` drives the whole loop and exits non-zero on any mismatch.

## Deploy

```bash
scripts/deploy.sh
```

This builds the Lambda container image (Node 22 base plus a `uv`-managed CPython 3.12 and `mcp-clickhouse`), pushes it to ECR, deploys the CloudFormation stack, uploads the frontend to S3 and invalidates CloudFront. Secrets sit in SSM Parameter Store and are read at cold start, so none of them are in the image or the repo.

## About the data

All of it is synthetic. *The Last Tram* is an original short written for this project, and the surrounding catalog of 44 titles is generated. No real studio, vendor or customer data is involved, and the UI says so on every screen.

The agent calls, the Gemini calls, the MCP server, the queries and their rows, the stored runs and the SRT hash are all real. If ClickHouse, the MCP server or Gemini is unavailable the run is marked `FAILED` with a reason, rather than falling back to something invented.

## License

MIT, see [LICENSE](LICENSE).
