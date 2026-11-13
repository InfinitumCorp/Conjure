# Conjure milestones

Status key: ✅ done · 🔨 in progress · ⏳ blocked · ⬜ not started

## M1 — Core engine ✅
- Plan → forge → verify → repair → deliver pipeline on `claude-opus-5-5`
- Sandboxed workspace (path confinement, size and count limits)
- CLI, local web UI with live preview, offline mock provider
- 7 offline tests (now 30, including server integration tests)

## M2 — Reliability and visibility ✅
- Cancel a run from the CLI (Ctrl+C) or the UI (Stop button); the in-flight API request is aborted
- `transcript.jsonl` per run: every event, for debugging and auditing
- Token usage including cache reads and writes, plus a cost estimate per run
- API calls: configurable timeout and retries (`CONJURE_TIMEOUT_MS`, `CONJURE_MAX_RETRIES`, default 3 retries)

## M3 — Stronger verification ✅
- HTML: every local `src` / `href` (scripts, stylesheets, images, links) must point to a file that exists
- CSS: balanced braces and comments
- package.json: `main` and `bin` must point to files that exist
- Runtime execution of generated code stays **off**: it is untrusted model output

## M4 — Iterate on a result ✅
- `conjure refine <dir> "<change>"`: apply a follow-up change to an existing deliverable, re-verify, record it in `conjure.json` history
- Refine from the web UI's history list

## M5 — Live validation 🔨
- ✅ Eval harness: `npm run eval -- --yes` runs 5 representative intents and records pass rate, repairs, tokens, cost
- ✅ Baseline on open-weight models (2026-11-12, conjure-llm gateway, Workers AI Qwen3 30B, thinking off): **4/5 passed**, all four on the first try (pomodoro, todo, converter, csv-stats, 9-15 s each); markdown previewer failed after 3 repair rounds with no files written
- ✅ Fix that made it pass: open-weight servers ignored `response_format`, so the plan schema is now also in the system prompt, the plan is parsed leniently (code fences, surrounding prose) and retried once (was 0/5 before)
- ⬜ Baseline on the Russia models (Yandex AI Studio qwen3.6-35b-a3b), which will run Conjure from now on
- ⬜ Get the markdown case through: the forge loop's tool calls on open-weight models

## M6 — Ship it ✅
- ✅ Download a deliverable as a zip: `conjure zip <dir>` or the UI's **Download .zip** button (zero-dependency writer, transcript excluded, verified with Python's `zipfile` and Windows `Expand-Archive`)
- ✅ Conjure lives in `Documents/Conjure` under git
- ✅ Installable web app (manifest, icons) and Android app (`android/`, built without Gradle, tested on a TECNO KM4 / Android 15)
- ✅ Hosted on AWS (us-east-2): EC2 + Caddy HTTPS on sslip.io, sign-in token, secrets in SSM, one-command deploy (`deploy/aws/deploy.mjs`)
- ✅ Hardening: security headers, cross-site and non-JSON POSTs refused, run records private on the preview host, runs survive dropped connections
- ⬜ One-click deploy of a *deliverable* (e.g. Vercel; needs the Vercel connector authorized via `/mcp`)

## M7 — After launch ⬜
- Run the live eval (M5) once the API key is in `.env`, then redeploy to switch the server to live Claude
- A custom domain instead of sslip.io
- Backups of `/var/lib/conjure` (EBS snapshots or S3) and basic alarms
- A release-signed APK (currently signed with the debug key) for wider distribution
