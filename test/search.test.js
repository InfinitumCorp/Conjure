// Conjure Search: the crawler's safety rules, Yandex parsing, ranking and the cited-answer pipeline.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { veilSearch, veilUrl } from "../src/search/veil.js";
import { searchConfigured as anySearchConfigured, webSearch } from "../src/search/index.js";
import { allowedUrl, blockedAddress, extractText, fetchPage } from "../src/search/crawl.js";
import { parseYandexXml, yandexSearch, searchConfigured } from "../src/search/yandex.js";
import { passages, rank, research, asBrief, terms } from "../src/search/research.js";
import { SearchService } from "../src/search/index.js";

describe("crawler safety", () => {
  test("private, loopback, link-local and metadata addresses are blocked", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"]) {
      assert.equal(blockedAddress(ip), true, ip);
    }
    for (const ip of ["93.158.134.3", "8.8.8.8", "172.32.0.1", "2a02:6b8::2:242"]) assert.equal(blockedAddress(ip), false, ip);
  });

  test("only public http(s) URLs on standard ports are accepted", () => {
    assert.ok(allowedUrl("https://ya.ru/news"));
    assert.ok(allowedUrl("http://example.com/a#frag"));
    for (const bad of ["file:///etc/passwd", "ftp://x.com", "http://169.254.169.254/latest", "http://127.0.0.1:4317/", "http://[::1]/", "http://localhost/",
      "http://conjure-russia.ru-central1.internal/", "https://user:pw@example.com/", "https://example.com:8443/", "not a url"]) {
      assert.equal(allowedUrl(bad), null, bad);
    }
  });

  test("a redirect into a private address is refused", async () => {
    const get = async (u) => (u.hostname === "example.com" ? { redirect: "http://169.254.169.254/computeMetadata/v1/" } : { body: "secret", type: "text/plain" });
    await assert.rejects(fetchPage("https://example.com/", { get }), /not a public web address/);
  });

  test("redirect loops stop", async () => {
    const get = async () => ({ redirect: "https://example.com/again" });
    await assert.rejects(fetchPage("https://example.com/", { get }), /too many redirects/);
  });

  test("the real network path refuses a host that resolves to loopback", async () => {
    await assert.rejects(fetchPage("http://localtest.me/"), /public address|ENOTFOUND|EAI_AGAIN|not a public/);
  });
});

describe("page text", () => {
  test("keeps the article, drops scripts, menus and footers, decodes entities", () => {
    const html = `<html><head><title>Rate &amp; ruble</title><script>alert(1)</script><style>p{}</style></head><body>
      <nav>Home | News</nav><main><h1>Key rate</h1><p>The Bank of Russia held the rate at 16&nbsp;% on Friday, citing inflation that is still above target.</p>
      <p>${"Analysts expected the decision. ".repeat(20)}</p></main><footer>© 2026</footer></body></html>`;
    const { title, text } = extractText(html);
    assert.equal(title, "Rate & ruble");
    assert.match(text, /held the rate at 16 %/);
    assert.doesNotMatch(text, /alert|Home \| News|© 2026/);
  });
});

describe("Yandex Search", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?><yandexsearch version="1.0"><response><results><grouping>
    <group><doc id="1"><url>https://www.cbr.ru/press/keypr/</url><domain>www.cbr.ru</domain><title>Банк России сохранил <hlword>ключевую</hlword> ставку</title>
      <headline>Решение совета директоров</headline><passages><passage>Совет директоров принял решение сохранить ставку на уровне 16,00%.</passage></passages></doc></group>
    <group><doc id="2"><url>https://example.com/b</url><domain>example.com</domain><title>Second &amp; more</title><passages><passage>Another one</passage></passages></doc></group>
  </grouping></results></response></yandexsearch>`;

  test("parses titles, domains and passages, with highlight tags removed", () => {
    const r = parseYandexXml(xml);
    assert.equal(r.length, 2);
    assert.deepEqual(r[0], { url: "https://www.cbr.ru/press/keypr/", domain: "www.cbr.ru", title: "Банк России сохранил ключевую ставку", snippet: "Решение совета директоров … Совет директоров принял решение сохранить ставку на уровне 16,00%." });
    assert.equal(r[1].title, "Second & more");
  });

  test("'nothing found' is an empty list; other errors throw", () => {
    assert.deepEqual(parseYandexXml(`<yandexsearch><response><error code="15">Sorry, there are no results</error></response></yandexsearch>`), []);
    assert.throws(() => parseYandexXml(`<yandexsearch><response><error code="31">Key not registered</error></response></yandexsearch>`), /Key not registered \(31\)/);
  });

  test("sends a well-formed request signed with the key and folder", async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ rawData: Buffer.from(xml).toString("base64") }), { status: 200 });
    };
    const env = { CONJURE_SEARCH_KEY: "k", CONJURE_LLM_PROJECT: "b1gfolder" };
    const r = await yandexSearch("ключевая ставка", { count: 5, fetchImpl, env });
    assert.equal(r.length, 2);
    assert.equal(seen.url, "https://searchapi.api.cloud.yandex.net/v2/web/search");
    assert.equal(seen.init.headers.authorization, "Bearer k");
    assert.equal(seen.body.folderId, "b1gfolder");
    assert.equal(seen.body.query.searchType, "SEARCH_TYPE_RU");
    assert.equal(seen.body.region, "225");
    assert.equal(seen.body.responseFormat, "FORMAT_XML");
    const en = await yandexSearch("bank of russia key rate", { fetchImpl, env, fresh: true });
    assert.equal(en.length, 2);
    assert.equal(seen.body.query.searchType, "SEARCH_TYPE_COM");
    assert.equal(seen.body.sortSpec.sortMode, "SORT_MODE_BY_TIME");
    assert.equal(seen.body.region, undefined);
  });

  test("is switched on by a key or VM auth, plus a folder", () => {
    assert.equal(searchConfigured({}), false);
    assert.equal(searchConfigured({ CONJURE_LLM_AUTH: "yandex-vm", CONJURE_LLM_PROJECT: "f" }), true);
    assert.equal(searchConfigured({ CONJURE_SEARCH_KEY: "k", CONJURE_SEARCH_FOLDER: "f" }), true);
    assert.equal(searchConfigured({ CONJURE_LLM_AUTH: "yandex-vm", CONJURE_LLM_PROJECT: "f", CONJURE_SEARCH: "off" }), false);
  });
});

describe("ranking", () => {
  test("Russian and English terms share stems and drop stop words", () => {
    assert.deepEqual(terms("Банк России и ключевая ставка"), ["банк", "россии", "ключев", "ставка"]);
  });

  test("the passage about the question ranks first", () => {
    const items = [
      { n: 1, text: "Weather in Moscow will be cloudy with light snow." },
      { n: 2, text: "The Bank of Russia kept its key rate unchanged at 16 percent." },
      { n: 3, text: "A recipe for borscht with beets." },
    ];
    assert.equal(rank("Bank of Russia key rate decision", items)[0].n, 2);
  });

  test("long text is cut into passages", () => {
    const ps = passages(`${"First paragraph sentence. ".repeat(60)}\n\nShort.\n\n${"Another paragraph here. ".repeat(10)}`);
    assert.ok(ps.length >= 2);
    assert.ok(ps.every((p) => p.length <= 1000));
  });
});

describe("research pipeline", () => {
  const results = {
    "bank of russia key rate": [
      { url: "https://cbr.ru/a", domain: "cbr.ru", title: "Key rate decision", snippet: "The Bank of Russia held the key rate at 16%." },
      { url: "https://news.example/b", domain: "news.example", title: "Analysts on the rate", snippet: "Analysts expect a cut in December." },
    ],
    "ключевая ставка": [{ url: "https://www.cbr.ru/a/", domain: "cbr.ru", title: "Duplicate", snippet: "dup" }],
  };
  const complete = async (system, user) => {
    if (/search queries/.test(system)) return '["bank of russia key rate", "ключевая ставка"]';
    assert.match(user, /\[1\] Key rate decision/);
    assert.match(user, /held the key rate at 16% on Friday/);
    return "The Bank of Russia held its key rate at 16% [1]. Analysts expect a cut [2][9].";
  };
  const search = async (q) => results[q] ?? [];
  const fetchPage = async (url) => {
    if (url.includes("news.example")) throw new Error("HTTP 403");
    return { url, title: "Key rate", text: `The Bank of Russia held the key rate at 16% on Friday. ${"Inflation remains above target. ".repeat(20)}` };
  };

  test("plans, searches, de-duplicates, reads, and answers with citations", async () => {
    const events = [];
    const r = await research("What is the Bank of Russia key rate?", { complete, search, fetchPage, onEvent: (e) => events.push(e.type) });
    assert.deepEqual(r.queries, ["bank of russia key rate", "ключевая ставка"]);
    assert.equal(r.sources.length, 2, "the www/trailing-slash duplicate is merged");
    assert.equal(r.sources[0].read, true);
    assert.equal(r.sources[1].read, false, "a page that refused is used through its snippet");
    assert.deepEqual(r.sources.map((s) => s.cited), [true, true]);
    assert.match(r.answer, /16% \[1\]/);
    assert.ok(["queries", "sources", "read", "answer"].every((t) => events.includes(t)));
    assert.match(asBrief(r), /Sources:\n\[1\] Key rate decision: https:\/\/cbr\.ru\/a/);
  });

  test("a model that won't plan falls back to the question itself", async () => {
    const qs = [];
    await research("Bank of Russia key rate today", {
      complete: async (s) => (/search queries/.test(s) ? "no json here" : "Answer [1]."),
      search: async (q) => (qs.push(q), results["bank of russia key rate"]),
      fetchPage,
    });
    assert.deepEqual(qs, ["Bank of Russia key rate today"]);
  });

  test("nothing found is a clear error", async () => {
    await assert.rejects(research("zzzz qqqq", { complete, search: async () => [], fetchPage }), /found nothing/);
  });

  test("the service caches answers and refuses when search is off", async () => {
    let calls = 0;
    const svc = new SearchService({ configured: () => true, complete, search: async (q) => (calls++, results[q] ?? []), fetchPage });
    await svc.ask("What is the Bank of Russia key rate?");
    const again = await svc.ask("what is the bank of russia   key rate?");
    assert.equal(again.cached, true);
    assert.equal(calls, 2, "the second ask didn't search again");
    const off = new SearchService({ configured: () => false });
    await assert.rejects(off.ask("anything at all"), (e) => e.status === 503);
  });
});

describe("VEIL Search", () => {
  const veilFetch = (seen) => async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return Response.json({ results: [{ title: "<b>Key rate</b>", url: "https://www.cbr.ru/rate", snippet: "16% &amp; holding" }, { title: "bad", url: "javascript:1" }] });
  };

  test("posts the query and returns results in Conjure's shape", async () => {
    const seen = [];
    const r = await veilSearch("key rate", { fetchImpl: veilFetch(seen), env: { VEIL_SEARCH_URL: "https://infinitumveil.app/api/search" } });
    assert.deepEqual(r, [{ url: "https://www.cbr.ru/rate", domain: "cbr.ru", title: "Key rate", snippet: "16% & holding" }]);
    assert.deepEqual(seen, [{ url: "https://infinitumveil.app/api/search", body: { q: "key rate" } }]);
  });

  test("needs an https URL, and counts as search being on", () => {
    assert.equal(veilUrl({ VEIL_SEARCH_URL: "http://infinitumveil.app/api/search" }), null);
    assert.equal(veilUrl({ VEIL_SEARCH_URL: "http://localhost:8787/api/search" }), "http://localhost:8787/api/search");
    assert.equal(anySearchConfigured({ VEIL_SEARCH_URL: "https://infinitumveil.app/api/search" }), true);
    assert.equal(anySearchConfigured({ VEIL_SEARCH_URL: "https://infinitumveil.app/api/search", CONJURE_SEARCH: "off" }), false);
    assert.equal(anySearchConfigured({}), false);
  });

  test("takes over when Yandex fails", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => url.includes("yandex") ? new Response("{}", { status: 500 }) : veilFetch(seen)(url, init);
    const env = { CONJURE_SEARCH_KEY: "k", CONJURE_SEARCH_FOLDER: "f", VEIL_SEARCH_URL: "https://infinitumveil.app/api/search" };
    const r = await webSearch("key rate", { fetchImpl, env });
    assert.equal(r[0].domain, "cbr.ru");
    assert.equal(seen.length, 1);
    await assert.rejects(webSearch("key rate", { fetchImpl, env: { CONJURE_SEARCH_KEY: "k", CONJURE_SEARCH_FOLDER: "f" } }), /Yandex Search answered 500/);
  });
});
