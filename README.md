# ✦ Conjure

Conjure turns a one-line intent ("a pomodoro timer with a task list") into a small, **working, verified** deliverable: a folder of files that opens and runs. It is built on Claude (`claude-opus-5-5` by default) through the official Anthropic SDK.

## How it works

```
intent ──► PLAN ──► FORGE ──► VERIFY ──► DELIVER
            │         ▲          │
            │         └─ REPAIR ◄┘  (failures fed back, up to 3 rounds)
            └─ structured JSON plan: name, files, acceptance criteria
```

| Phase   | What happens | Code |
|---------|--------------|------|
| Plan    | One Claude call with a JSON-schema structured output. Returns the product name, file list and acceptance criteria. | `src/engine.js` |
| Forge   | An agentic tool loop: Claude calls `write_file`, `read_file`, `list_files`, `run_checks` and `finish`. | `src/engine.js` |
| Verify  | Deterministic checks: JS syntax (`node --check`, inline `<script>` blocks included), JSON validity, HTML structure (title, viewport, balanced scripts), CSS balance, every local `src`/`href`/`url()`/`import` pointing to a real file, and every planned file present. Generated code is never executed. | `src/verify.js` |
| Repair  | Failed checks go back to Claude as the `finish` tool result, and it fixes them. | `src/engine.js` |
| Deliver | Writes `conjure.json` (plan, verification results, token usage, cost estimate, timing, change history) and `transcript.jsonl` (every event of every run) next to the output. | `src/engine.js` |
| Refine  | Applies a follow-up change to an existing deliverable through the same forge, verify and repair loop, and appends it to `conjure.json` history. | `src/engine.js` |

Runs can be cancelled with Ctrl+C in the CLI or the **Stop** button in the UI; the in-flight API request is aborted and the transcript is still saved. Cost estimates use list prices in `src/pricing.js`. Milestones are tracked in [MILESTONES.md](MILESTONES.md).

**Safety:** model-supplied paths are confined to the deliverable's folder (`src/workspace.js`), with file-size and file-count limits. Tool inputs are validated before they run. Refusals are surfaced, not ignored. Server-side refusal fallback is on (`fallbacks: "default"`); set `CONJURE_FALLBACKS=0` to turn it off. The web UI listens on 127.0.0.1 only and serves conjured output from a separate port, so generated code can't call the Conjure API.

## Run it

```bash
npm install
npm test                                          # 17 tests, offline
node src/cli.js "a habit tracker"                 # build something new
node src/cli.js refine conjured/<folder> "add dark mode"   # change it
node src/cli.js zip conjured/<folder>                      # package it as a .zip
node src/cli.js list                              # list deliverables, newest first
npm start                                         # web UI at http://localhost:4317
```

With no `ANTHROPIC_API_KEY` set, Conjure uses the **mock provider**: a scripted stand-in that returns responses in the same shape as the real API, so the whole pipeline runs offline. For live Claude, put the key in `.env` (git-ignored; see `.env.example`), or run `set-key.ps1` to enter it without it showing on screen.

CLI flags: `--mock`, `--model <id>`, `--out <dir>`, `--flaw` (mock only: injects a bug to show the repair loop), `-q`.

Environment variables: `CONJURE_MODEL`, `CONJURE_OUT` (default `./conjured`), `CONJURE_FALLBACKS`, `CONJURE_TIMEOUT_MS` (per API request), `CONJURE_MAX_RETRIES` (default 3; retries rate limits, overloads and connection errors), `CONJURE_MOCK=1`, `CONJURE_MOCK_DELAY` (ms per mock turn, for testing Stop), `PORT`, `PREVIEW_PORT`.

## Evaluate it

`eval/intents.json` holds five representative requests (three web apps, a Node CLI script, a live-preview tool). The harness runs each through Conjure and writes `eval-report.md` and `eval-results.json` with pass rate, repair rounds, tokens and estimated cost.

```bash
npm run eval -- --mock                 # offline check of the harness (free)
npm run eval -- --yes                  # live against Claude (spends API credit)
npm run eval -- --only todo,markdown --yes
```

A live run without `--yes` stops and tells you what it would do, so the eval never spends credit by accident.

## Use as a library

```js
import { conjure } from "./src/engine.js";
import { ClaudeProvider } from "./src/providers.js";

const result = await conjure({
  intent: "a unit converter",
  provider: new ClaudeProvider(),
  outDir: "./conjured",
  onEvent: (e) => console.log(e.type),
});
console.log(result.workspace, result.verification.ok);
```

A provider is any object with `turn({system, messages, tools, jsonSchema, effort, onText})` that returns an Anthropic-shaped message. Add a provider to plug in another backend.
