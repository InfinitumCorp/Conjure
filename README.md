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

Runs can be cancelled with Ctrl+C in the CLI or the **Stop** button in the UI; the in-flight API request is aborted and the transcript is still saved. In the web UI a run keeps going if the browser disconnects (for example a phone screen locks): the page shows it as in progress when you come back, and the result lands in History. Set `CONJURE_ABORT_ON_DISCONNECT=1` to cancel on disconnect instead. Cost estimates use list prices in `src/pricing.js`. Milestones are tracked in [MILESTONES.md](MILESTONES.md).

**Safety:** model-supplied paths are confined to the deliverable's folder (`src/workspace.js`), with file-size and file-count limits. Tool inputs are validated before they run. Refusals are surfaced, not ignored. Server-side refusal fallback is on (`fallbacks: "default"`); set `CONJURE_FALLBACKS=0` to turn it off. The web UI listens on 127.0.0.1 only and serves conjured output from a separate port, so generated code can't call the Conjure API.

## Run it

```bash
npm install
npm test                                          # 30 tests, offline
node src/cli.js "a habit tracker"                 # build something new
node src/cli.js refine conjured/<folder> "add dark mode"   # change it
node src/cli.js zip conjured/<folder>                      # package it as a .zip
node src/cli.js list                              # list deliverables, newest first
npm start                                         # web UI at http://localhost:4317
```

With no `ANTHROPIC_API_KEY` set, Conjure uses the **mock provider**: a scripted stand-in that returns responses in the same shape as the real API, so the whole pipeline runs offline. For live Claude, put the key in `.env` (git-ignored; see `.env.example`), or run `set-key.ps1` to enter it without it showing on screen.

CLI flags: `--mock`, `--model <id>`, `--out <dir>`, `--flaw` (mock only: injects a bug to show the repair loop), `-q`.

Environment variables: `CONJURE_MODEL`, `CONJURE_OUT` (default `./conjured`), `CONJURE_FALLBACKS`, `CONJURE_TIMEOUT_MS` (per API request), `CONJURE_MAX_RETRIES` (default 3; retries rate limits, overloads and connection errors), `CONJURE_MOCK=1`, `CONJURE_MOCK_DELAY` (ms per mock turn, for testing Stop), `PORT`, `PREVIEW_PORT`.

## On your phone

**Install as a web app (PWA):** open the UI in the phone's browser and choose *Add to Home screen*; it ships a manifest and icons.

**Android app:** `android/` holds a small WebView app (`com.conjure.app`), built without Gradle:

```bash
bash android/build.sh                               # -> android/build/conjure.apk (needs Android SDK + JDK)
CONJURE_URL=https://app.<ip>.sslip.io bash android/build.sh   # same, opening your AWS server by default
adb install -r android/build/conjure.apk
adb reverse tcp:4317 tcp:4317 && adb reverse tcp:4318 tcp:4318
npm start                                           # the app opens http://localhost:4317 on the phone
```

To point the app at another server: use **Use this server** on its "Can't reach Conjure" screen, or `adb shell am start -n com.conjure.app/.MainActivity --es url http://host:4317/` (remembered). Zip downloads go to the phone's Downloads folder and carry the sign-in session.

## Deploy to AWS

`deploy/aws/` runs Conjure on one EC2 instance (Amazon Linux 2023, `t4g.small` by default, roughly $15/month with its Elastic IP). Caddy serves it over HTTPS on two free `sslip.io` hostnames: `app.<ip>.sslip.io` for the UI and `preview.<ip>.sslip.io` for previews, so generated code stays on a separate origin.

```bash
aws configure                          # or: aws sso login   (AWS CLI v2)
node deploy/aws/deploy.mjs --profile infinitum   # first run creates everything; later runs roll out the working tree
node deploy/aws/deploy.mjs --status    # URL and stack state
node deploy/aws/deploy.mjs --destroy --yes
```

- **Sign-in:** the first deploy generates an access token, stores it in SSM Parameter Store (`/conjure/access-token`) and saves a copy to `.conjure-access-token` (git-ignored). With `CONJURE_ACCESS_TOKEN` set, every page and API call needs it (cookie after `/login`, or `Authorization: Bearer`); cross-site and non-JSON POSTs are refused.
- **Live mode:** if `.env` has `ANTHROPIC_API_KEY`, the deploy stores it as `/conjure/anthropic-api-key`; without it the server runs in offline mock mode.
- **Previews:** the preview host serves only a deliverable's own files (never `conjure.json` or `transcript.jsonl`) and needs no sign-in, so anyone with a deliverable's exact URL can open it. Folder names carry a random suffix.
- **Data:** deliverables live on the instance's disk (`/var/lib/conjure`) and are deleted with the stack.
- **No SSH:** port 22 is closed; use SSM Session Manager. The template (`deploy/aws/conjure.yaml`) builds its own VPC, so it doesn't depend on a default VPC.
- **Android:** `adb shell am start -n com.conjure.app/.MainActivity --es url https://app.<ip>.sslip.io/`

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
