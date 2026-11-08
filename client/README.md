# @conjure in this product

Conjure™ is Infinitum's live prediction model. Anyone using this product can type **@conjure** and a question, e.g. `@conjure will the March launch slip?`. A swarm of AI agents plays the question out and a report agent writes the forecast, which the product posts back.

`conjure.mjs` is the whole client: no dependencies, works in Node 18+, Cloudflare Workers, Deno and Bun. It is synced from `InfinitumCorp/Conjure` (`client/`); don't edit the copy here.

## Set up

1. An Infinitum admin issues this product's key on the Conjure staff dashboard (Products → Issue key).
2. Set these in the product's **server** environment (Cloudflare/Vercel secrets, `.env` locally):

   | Variable | Value |
   |---|---|
   | `CONJURE_URL` | The Conjure service URL |
   | `CONJURE_PRODUCT_KEY` | `cjp_<product>_…` (server secret: never send it to a browser) |

3. Pass user text through `handleMention` wherever people write: messages, comments, notes, search, chat.

```js
import { conjureFromEnv } from "./conjure/conjure.mjs";

const conjure = conjureFromEnv(env); // null until both variables are set

// In a request handler: start the forecast and return at once.
const out = await conjure?.handleMention(text, { context: recordNotes, user: userId, source: "thread", wait: false });
if (out) return reply(out.text, { conjureId: out.prediction?.id });

// Later (poll, or in a background job): read progress or the finished forecast.
const p = await conjure.get(id);           // p.status, p.round, p.report
```

`handleMention` returns `null` when the text has no `@conjure`, so it is safe to call on every message. `formatForecast(prediction)` turns a forecast into a reply. Every forecast is visible to Infinitum staff on the Conjure dashboard, metered against this product's daily limit.
