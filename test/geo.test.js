// Synthetic v2ray GeoIPList / GeoSiteList fixtures. These are not the v2fly datasets.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createConjure, infinitumGeoEnabled } from "../client/conjure.mjs";
import { annotate, geoEnabled, GeoDB, loadGeoDb, normalizeIp, resetGeoCache } from "../src/geo.js";
import { SettingsStore } from "../src/settings.js";
import { assertChecksum, assertV2flyUrl, fetchLockedFile, parseSha256Sum } from "../scripts/fetch-geo.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 127) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}
const key = (field, wire) => varint((field << 3) | wire);
const lenDelim = (field, data) => Buffer.concat([key(field, 2), varint(data.length), Buffer.from(data)]);
const protoString = (field, value) => lenDelim(field, Buffer.from(value));
const protoVarint = (field, value) => Buffer.concat([key(field, 0), varint(value)]);
const cidr = (octets, prefix) => Buffer.concat([lenDelim(1, Buffer.from(octets)), protoVarint(2, prefix)]);
function geoip(country, cidrs, reverse = false) {
  const parts = [protoString(1, country), ...cidrs.map((item) => lenDelim(2, item))];
  if (reverse) parts.push(protoVarint(3, 1));
  return Buffer.concat(parts);
}
const geoipList = (entries) => Buffer.concat(entries.map((entry) => lenDelim(1, entry)));
function domain(type, value) {
  const attr = lenDelim(3, Buffer.concat([protoString(1, "attr"), protoVarint(2, 1)]));
  return Buffer.concat([protoVarint(1, type), protoString(2, value), attr]);
}
function geosite(category, domains) {
  return Buffer.concat([protoString(1, category), ...domains.map((item) => lenDelim(2, item))]);
}
const geositeList = (entries) => Buffer.concat(entries.map((entry) => lenDelim(1, entry)));

function fixtures() {
  const ip = geoipList([
    geoip("ZZ", [cidr([203, 0, 113, 0], 24), cidr([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 32)]),
    geoip("US", [cidr([203, 0, 113, 128], 25)]),
    geoip("CN", [cidr([198, 51, 100, 0], 24)]),
    geoip("AA", [cidr([203, 0, 113, 0], 24)], true),
  ]);
  const site = geositeList([
    geosite("ads", [domain(2, "example.com")]),
    geosite("both", [domain(2, "example.com")]),
    geosite("exact", [domain(3, "exact.test")]),
    geosite("kw", [domain(0, "tracker")]),
    geosite("re", [domain(1, String.raw`^news\d+\.other$`)]),
  ]);
  return { ip, site };
}

function writeFixtures(dir) {
  const { ip, site } = fixtures();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "geoip.dat"), ip);
  fs.writeFileSync(path.join(dir, "geosite.dat"), site);
  return dir;
}

describe("geo dat loader", () => {
  let db;
  before(() => {
    const { ip, site } = fixtures();
    db = new GeoDB(ip, site);
  });

  test("maps an address to the longest-prefix country", () => {
    assert.equal(db.lookupIp("203.0.113.10"), "ZZ");
    assert.equal(db.lookupIp("203.0.113.200"), "US");
    assert.equal(db.lookupIp("198.51.100.5"), "CN");
    assert.equal(db.lookupIp("2001:db8::1"), "ZZ");
    assert.equal(db.lookupIp("::ffff:203.0.113.10"), "ZZ");
    assert.equal(db.lookupIp("8.8.8.8"), "AA");
    assert.equal(db.lookupIp("2001:db9::1"), null);
    assert.equal(db.lookupIp("not-an-ip"), null);
    assert.equal(db.lookupIp("example.com"), null);
  });

  test("maps a domain to categories in dataset order", () => {
    assert.deepEqual(db.lookupCategories("www.example.com"), ["ads", "both"]);
    assert.equal(db.lookupCategory("example.com"), "ads");
    assert.deepEqual(db.lookupCategories("notexample.com"), []);
    assert.deepEqual(db.lookupCategories("exact.test"), ["exact"]);
    assert.deepEqual(db.lookupCategories("a.exact.test"), []);
    assert.deepEqual(db.lookupCategories("cdn.tracker.test"), ["kw"]);
    assert.deepEqual(db.lookupCategories("news12.other"), ["re"]);
    assert.deepEqual(db.lookupCategories("news12.example.com"), ["ads", "both"]);
  });

  test("reads the same bytes from a fixture directory and annotates text", () => {
    const dir = writeFixtures(fs.mkdtempSync(path.join(os.tmpdir(), "geo-fix-")));
    resetGeoCache();
    const loaded = loadGeoDb(dir);
    assert.equal(loaded.lookupIp("198.51.100.9"), "CN");
    const found = annotate({ dir, ip: "203.0.113.10", text: "see https://www.example.com/a" });
    assert.deepEqual(found, { country: "ZZ", categories: ["ads", "both"], route: "country:ZZ" });
    assert.equal(annotate({ dir, text: "no host here" }), null);
    assert.equal(annotate({ dir, ip: "1.2.3.4", text: "no host here" }).country, "AA");
    assert.equal(annotate({ dir, text: "cdn.tracker.test/app" }).route, "category:kw");
    assert.throws(() => loadGeoDb(path.join(dir, "missing")), /missing geoip\.dat/);
    assert.throws(() => new GeoDB(Buffer.from([0x0a, 0x05]), Buffer.alloc(0)), /truncated geo dat/);
  });
});

describe("geo routing switch", () => {
  test("stays off unless the env or the saved toggle opts in", () => {
    assert.equal(geoEnabled({}), false);
    assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "" }, false), false);
    assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "1" }, false), true);
    assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "0" }, true), false);
    assert.equal(geoEnabled({}, true), true);
    assert.equal(infinitumGeoEnabled({}), false);
    assert.equal(infinitumGeoEnabled({ INFINITUM_GEO_ENABLED: "yes" }), true);
  });

  test("normalizes addresses and refuses names", () => {
    assert.equal(normalizeIp(" 203.0.113.10 "), "203.0.113.10");
    assert.equal(normalizeIp("[2001:db8::1]"), "2001:db8::1");
    assert.equal(normalizeIp("::ffff:198.51.100.5"), "198.51.100.5");
    assert.equal(normalizeIp("example.com"), null);
  });

  test("persists the toggle and treats a missing file as off", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-set-"));
    const file = path.join(dir, "settings.json");
    const store = await new SettingsStore(file).load();
    assert.equal(store.geoRouting, false);
    assert.equal(fs.existsSync(file), false);
    assert.equal(await store.setGeoRouting(true), true);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).geoRouting, true);
    const again = await new SettingsStore(file).load();
    assert.deepEqual(again.view(), { geoRouting: true });
    await again.setGeoRouting(false);
    assert.equal(again.geoRouting, false);
  });
});

describe("geo fetch lock", () => {
  test("refuses publishers other than v2fly", () => {
    assert.throws(() => assertV2flyUrl("https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/x/geoip.dat"), /non-v2fly/);
    assert.throws(() => assertV2flyUrl("https://github.com/SagerNet/sing-box/releases/download/x/geoip.db"), /non-v2fly/);
    assert.throws(() => assertV2flyUrl("http://github.com/v2fly/geoip/releases/download/x/geoip.dat"), /refusing/);
    assert.equal(assertV2flyUrl("https://github.com/v2fly/geoip/releases/download/202611080027/geoip.dat"), "https://github.com/v2fly/geoip/releases/download/202611080027/geoip.dat");
  });

  test("stops on a checksum mismatch and does not keep the file", async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-fetch-"));
    const bytes = Buffer.from("not-the-dataset");
    const good = crypto.createHash("sha256").update(bytes).digest("hex");
    assert.equal(parseSha256Sum(`${good}  dlc.dat\n`), good);
    assert.throws(() => assertChecksum(bytes, "a".repeat(64), "geosite.dat"), /checksum mismatch/);
    const fetchImpl = async (url) => {
      if (url.endsWith(".sha256sum")) return new Response(`${"ab".repeat(32)}  dlc.dat\n`);
      return new Response(bytes);
    };
    await assert.rejects(
      fetchLockedFile({
        name: "geosite.dat",
        upstream: "dlc.dat",
        url: "https://github.com/v2fly/domain-list-community/releases/download/20261108011013/dlc.dat",
        sha256sumUrl: "https://github.com/v2fly/domain-list-community/releases/download/20261108011013/dlc.dat.sha256sum",
        sha256: good,
      }, { outDir, fetchImpl }),
      /checksum mismatch/,
    );
    assert.equal(fs.existsSync(path.join(outDir, "geosite.dat")), false);

    const ok = await fetchLockedFile({
      name: "geosite.dat",
      upstream: "dlc.dat",
      url: "https://github.com/v2fly/domain-list-community/releases/download/20261108011013/dlc.dat",
      sha256sumUrl: "https://github.com/v2fly/domain-list-community/releases/download/20261108011013/dlc.dat.sha256sum",
      sha256: good,
    }, {
      outDir,
      fetchImpl: async (url) => (url.endsWith(".sha256sum") ? new Response(`${good}  dlc.dat\n`) : new Response(bytes)),
    });
    assert.equal(ok.sha256, good);
    assert.equal(fs.readFileSync(path.join(outDir, "geosite.dat")).equals(bytes), true);
  });
});

function startServer(extraEnv = {}) {
  const port = 49000 + Math.floor(Math.random() * 1000) * 2;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "geo-srv-"));
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "",
      CONJURE_MOCK: "1",
      INFINITUM_GEO_ENABLED: "",
      PORT: String(port),
      PREVIEW_PORT: String(port + 1),
      CONJURE_OUT: path.join(tmp, "out"),
      CONJURE_DATA: path.join(tmp, "data"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const ready = (async () => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`server did not start:\n${log}`);
  })();
  return { base, tmp, ready, log: () => log, stop: () => child.kill() };
}

describe("geo routing in the product server", () => {
  const fixturesDir = writeFixtures(fs.mkdtempSync(path.join(os.tmpdir(), "geo-srv-fix-")));
  let s;
  before(async () => {
    s = startServer({ INFINITUM_GEO_DIR: fixturesDir });
    await s.ready;
  });
  after(() => s.stop());

  const post = (body) => fetch(`${s.base}/v1/predictions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rounds: 1, agents: 4, ...body }),
  });

  test("the toggle is off, visible, and ignored until saved", async () => {
    assert.equal(fs.existsSync(path.join(s.tmp, "data", "settings.json")), false);
    assert.deepEqual(await (await fetch(`${s.base}/api/settings`)).json(), { geoRouting: false });
    const studio = await (await fetch(`${s.base}/studio`)).text();
    const dashboard = await (await fetch(`${s.base}/`)).text();
    assert.match(studio, /id="geo"/);
    assert.match(studio, /Geo routing/);
    assert.match(dashboard, /id="geo"/);
    assert.equal((await fetch(`${s.base}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ geoRouting: "yes" }) })).status, 400);
    const off = await (await post({ question: "https://www.example.com", clientIp: "203.0.113.10", geo: { route: "country:EVIL", country: "EVIL" } })).json();
    assert.equal(off.geo, undefined);
    assert.equal(s.log().includes("geo route"), false);
  });

  test("saving the toggle annotates country and category, and turning it off stops", async () => {
    assert.deepEqual(await (await fetch(`${s.base}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ geoRouting: true }) })).json(), { geoRouting: true });
    const on = await (await post({ question: "see https://www.example.com/x", clientIp: "203.0.113.10", geo: { route: "country:EVIL" } })).json();
    assert.equal(on.geo.country, "ZZ");
    assert.deepEqual(on.geo.categories, ["ads", "both"]);
    assert.equal(on.geo.route, "country:ZZ");
    assert.match(s.log(), /geo route country:ZZ/);
    let done;
    for (let i = 0; i < 100; i++) {
      done = await (await fetch(`${s.base}/v1/predictions/${on.id}`)).json();
      if (done.status === "done" || done.status === "failed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(done.geo.route, "country:ZZ");
    const usageFile = path.join(s.tmp, "data", "usage.jsonl");
    let usage = "";
    for (let i = 0; i < 20 && !usage.includes("country:ZZ"); i++) {
      usage = fs.existsSync(usageFile) ? fs.readFileSync(usageFile, "utf8") : "";
      if (!usage.includes("country:ZZ")) await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(usage, /"route":"country:ZZ"/);
    assert.deepEqual(await (await fetch(`${s.base}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ geoRouting: false }) })).json(), { geoRouting: false });
    const again = await (await post({ question: "https://www.example.com", clientIp: "203.0.113.10" })).json();
    assert.equal(again.geo, undefined);
  });
});

describe("geo env gate", () => {
  const ask = (base, body) => fetch(`${base}/v1/predictions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "https://www.example.com", clientIp: "203.0.113.10", rounds: 1, agents: 4, ...body }),
  });

  test("INFINITUM_GEO_ENABLED=0 keeps a saved toggle from annotating", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "geo-off-"));
    const fixturesDir = writeFixtures(path.join(tmp, "fix"));
    fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "data", "settings.json"), JSON.stringify({ geoRouting: true }));
    const s = startServer({ INFINITUM_GEO_ENABLED: "0", INFINITUM_GEO_DIR: fixturesDir, CONJURE_DATA: path.join(tmp, "data"), CONJURE_OUT: path.join(tmp, "out") });
    await s.ready;
    try {
      const body = await (await ask(s.base)).json();
      assert.equal(body.geo, undefined);
      assert.equal(s.log().includes("geo route"), false);
    } finally {
      s.stop();
    }
  });

  test("INFINITUM_GEO_ENABLED=1 annotates even when the toggle is off", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "geo-on-"));
    const fixturesDir = writeFixtures(path.join(tmp, "fix"));
    const s = startServer({ INFINITUM_GEO_ENABLED: "1", INFINITUM_GEO_DIR: fixturesDir, CONJURE_DATA: path.join(tmp, "data"), CONJURE_OUT: path.join(tmp, "out") });
    await s.ready;
    try {
      const body = await (await ask(s.base)).json();
      assert.equal(body.geo.country, "ZZ");
      assert.equal(body.geo.route, "country:ZZ");
    } finally {
      s.stop();
    }
  });
});

describe("client geo forwarding", () => {
  test("does not send clientIp unless INFINITUM_GEO_ENABLED is set", async () => {
    const seen = [];
    const previous = process.env.INFINITUM_GEO_ENABLED;
    delete process.env.INFINITUM_GEO_ENABLED;
    const fetchImpl = async (_url, opts) => {
      seen.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: "pr_x", status: "done", question: "q", agents: 4, rounds: 1, poles: { for: "yes" }, report: { outcome: "n", probability: 0.5, confidence: "low" } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const conjure = createConjure({ url: "http://127.0.0.1:9", key: "cjp_test", fetch: fetchImpl });
    try {
      await conjure.handleMention("@conjure will example.com ship?", { clientIp: "203.0.113.10", wait: false });
      assert.equal(seen[0].clientIp, undefined);
      assert.equal(Object.hasOwn(seen[0], "clientIp"), false);
      process.env.INFINITUM_GEO_ENABLED = "1";
      await conjure.handleMention("@conjure will example.com ship?", { clientIp: "203.0.113.10", wait: false });
      assert.equal(seen[1].clientIp, "203.0.113.10");
    } finally {
      if (previous === undefined) delete process.env.INFINITUM_GEO_ENABLED;
      else process.env.INFINITUM_GEO_ENABLED = previous;
    }
  });
});

describe("cli geo flag", () => {
  test("persists --geo and --no-geo without changing the default help path", () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "geo-cli-"));
    const env = { ...process.env, CONJURE_DATA: data, INFINITUM_GEO_ENABLED: "", ANTHROPIC_API_KEY: "" };
    const help = spawnSync(process.execPath, ["src/cli.js", "--help"], { cwd: root, env, encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--geo/);
    assert.equal(fs.existsSync(path.join(data, "settings.json")), false);
    const on = spawnSync(process.execPath, ["src/cli.js", "--geo"], { cwd: root, env, encoding: "utf8" });
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /Geo routing is on/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, "settings.json"), "utf8")).geoRouting, true);
    const off = spawnSync(process.execPath, ["src/cli.js", "--no-geo"], { cwd: root, env, encoding: "utf8" });
    assert.equal(off.status, 0, off.stderr);
    assert.match(off.stdout, /Geo routing is off/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, "settings.json"), "utf8")).geoRouting, false);
  });
});
