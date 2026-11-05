# Conjure milestones

Status key: ✅ done · 🔨 in progress · ⏳ blocked · ⬜ not started

## M1 — Core engine ✅
- Plan → forge → verify → repair → deliver pipeline on `claude-opus-5-5`
- Sandboxed workspace (path confinement, size and count limits)
- CLI, local web UI with live preview, offline mock provider
- 7 offline tests (now 17)

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

## M5 — Live validation ⏳ (harness ready; needs an API key in `.env`)
- ✅ Eval harness: `npm run eval -- --yes` runs 5 representative intents and records pass rate, repairs, tokens, cost
- ⏳ Run it live and record the baseline
- Tune prompts and effort level from those results

## M6 — Ship it 🔨
- ✅ Download a deliverable as a zip: `conjure zip <dir>` or the UI's **Download .zip** button (zero-dependency writer, transcript excluded, verified with Python's `zipfile` and Windows `Expand-Archive`)
- ⏳ One-click deploy of a web deliverable (e.g. Vercel; needs the Vercel connector authorized via `/mcp`)
- ✅ Conjure lives in `Documents/Conjure` under git (initialized; nothing committed yet)
