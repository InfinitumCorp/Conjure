// Synthetic v2ray GeoIPList / GeoSiteList fixtures. The real datasets are fetched, not committed.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acceptDataset, assertAllowedUrl, parseSha256Sum, sha256, validateLock } from "../scripts/fetch-geo.mjs";
import {
  annotateProductRequest,
  clientAddress,
  decodeGeoIPList,
  decodeGeoSiteList,
  geoEnabled,
  loadGeoFiles,
  normalizeDomain,
  openGeo,
  resetGeoCache,
} from "../src/geo.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(fs.readFileSync(path.join(root, "geo.lock.json"), "utf8"));

const PLAIN = 0;
const REGEX = 1;
const ROOT = 2;
const FULL = 3;

function varint(n) {
  const out = [];
  let v = n;
  while (v > 127) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}
const key = (field, wire) => varint((field << 3) | wire);
const lenDelim = (field, buf) => Buffer.concat([key(field, 2), varint(buf.length), buf]);
const str = (field, s) => lenDelim(field, Buffer.from(s));
const vi = (field, n) => Buffer.concat([key(field, 0), varint(n)]);

function cidr(ip, prefix) {
  return Buffer.concat([lenDelim(1, Buffer.from(ip)), vi(2, prefix)]);
}
function geoip(country, cidrs, inverse = false) {
  const parts = [str(1, country), ...cidrs.map((c) => lenDelim(2, c))];
  if (inverse) parts.push(vi(3, 1));
  return Buffer.concat(parts);
}
function geoipList(entries) {
  return Buffer.concat(entries.map((e) => lenDelim(1, e)));
}
function domain(type, value, attribute) {
  const parts = [];
  if (type) parts.push(vi(1, type));
  parts.push(str(2, value));
  if (attribute) parts.push(lenDelim(3, Buffer.concat([str(1, attribute), vi(2, 1)])));
  return Buffer.concat(parts);
}
function geosite(code, domains) {
  return Buffer.concat([str(1, code), ...domains.map((d) => lenDelim(2, d))]);
}
function geositeList(entries) {
  return Buffer.concat(entries.map((e) => lenDelim(1, e)));
}

function fixtureBytes() {
  const geoipDat = geoipList([
    geoip("us", [cidr([1, 2, 3, 0], 24), cidr([1, 2, 3, 4], 32)]),
    geoip("cn", [cidr([1, 2, 0, 0], 16)]),
    geoip("private", [cidr([10, 0, 0, 0], 8)]),
    geoip("zz", [cidr([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 32)]),
    geoip("xx", [cidr([203, 0, 113, 0], 24)], true),
  ]);
  const geositeDat = geositeList([
    geosite("example", [domain(ROOT, "example.test"), domain(FULL, "www.example.test", "ads")]),
    geosite("telemetry", [domain(PLAIN, "tracker")]),
    geosite("re", [domain(REGEX, "(^|\\.)regex\\.test$")]),
  ]);
  return { geoipDat, geositeDat };
}

function writeFixture(dir) {
  const { geoipDat, geositeDat } = fixtureBytes();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "geoip.dat"), geoipDat);
  fs.writeFileSync(path.join(dir, "geosite.dat"), geositeDat);
  return dir;
}

describe("synthetic geo fixtures", () => {
  const { geoipDat, geositeDat } = fixtureBytes();
  const db = openGeo({ geoip: geoipDat, geosite: geositeDat });

  test("decodes GeoIPList and GeoSiteList field layout", () => {
    const ips = decodeGeoIPList(geoipDat);
    assert.equal(ips[0].countryCode, "us");
    assert.equal(ips[0].cidrs.length, 2);
    assert.equal(ips[0].cidrs[0].prefix, 24);
    assert.equal(ips.at(-1).inverseMatch, true);
    const sites = decodeGeoSiteList(geositeDat);
    assert.deepEqual(sites.map((s) => s.countryCode), ["example", "telemetry", "re"]);
    assert.equal(sites[0].domains[1].type, FULL);
  });

  test("maps an address to the longest matching country", () => {
    assert.equal(db.countryForIp("1.2.3.4"), "us");
    assert.equal(db.countryForIp("1.2.3.9"), "us");
    assert.equal(db.countryForIp("1.2.9.9"), "cn");
    assert.equal(db.countryForIp("10.1.2.3"), "private");
    assert.equal(db.countryForIp("203.0.113.9"), null, "inverse_match is not a country");
    assert.equal(db.countryForIp("8.8.8.8"), null);
    assert.equal(db.countryForIp("::ffff:1.2.3.4"), "us");
    assert.equal(db.countryForIp("2001:db8::1"), "zz");
  });

  test("maps a domain to every matching category", () => {
    assert.deepEqual(db.categoriesForDomain("www.example.test"), ["example"]);
    assert.deepEqual(db.categoriesForDomain("https://Tracker.example.test/path"), ["example", "telemetry"]);
    assert.deepEqual(db.categoriesForDomain("example.test"), ["example"]);
    assert.deepEqual(db.categoriesForDomain("notexample.test"), []);
    assert.deepEqual(db.categoriesForDomain("a.regex.test"), ["re"]);
    assert.deepEqual(db.categoriesForDomain("regex.test.evil"), []);
  });

  test("loads the same bytes from a data directory", () => {
    const dir = writeFixture(fs.mkdtempSync(path.join(os.tmpdir(), "geo-fix-")));
    const loaded = loadGeoFiles(dir);
    assert.equal(loaded.countryForIp("1.2.3.4"), "us");
    assert.deepEqual(loaded.categoriesForDomain("sub.example.test"), ["example"]);
  });

  test("rejects a truncated message", () => {
    assert.throws(() => decodeGeoIPList(Buffer.from([0x0a, 0x05, 0x0a])), /truncated/);
  });

  test("normalizes a host without treating a product slug as a url", () => {
    assert.equal(normalizeDomain("Example.TEST."), "example.test");
    assert.equal(normalizeDomain("user@Example.TEST:443"), "example.test");
    assert.equal(normalizeDomain("not a host"), "");
  });
});

describe("geo fetch lock", () => {
  test("pins the v2fly tags and checksums", () => {
    validateLock(lock);
    const byName = Object.fromEntries(lock.files.map((f) => [f.name, f]));
    assert.equal(byName["geoip.dat"].tag, "202611080027");
    assert.equal(byName["geoip.dat"].sha256, "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2");
    assert.equal(byName["geosite.dat"].tag, "20261108011013");
    assert.equal(byName["geosite.dat"].asset, "dlc.dat");
    assert.equal(byName["geosite.dat"].sha256, "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2");
    assert.equal(lock.outDir, "data/geo");
  });

  test("reads an official sha256sum line", () => {
    const text = "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2  geoip.dat\n";
    assert.equal(parseSha256Sum(text, "geoip.dat"), lock.files[0].sha256);
  });

  test("stops before writing when the official checksum disagrees with the lock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-sum-"));
    const dest = path.join(dir, "geoip.dat");
    const bytes = Buffer.from("not the dataset");
    await assert.rejects(
      () => acceptDataset({
        bytes,
        officialText: `${sha256(bytes)}  geoip.dat\n`,
        asset: "geoip.dat",
        expected: lock.files[0].sha256,
        dest,
      }),
      /checksum mismatch/,
    );
    assert.equal(fs.existsSync(dest), false);
  });

  test("stops before writing when the bytes disagree with the official checksum", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-sum-"));
    const dest = path.join(dir, "geoip.dat");
    await assert.rejects(
      () => acceptDataset({
        bytes: Buffer.from("tampered"),
        officialText: `${lock.files[0].sha256}  geoip.dat\n`,
        asset: "geoip.dat",
        expected: lock.files[0].sha256,
        dest,
      }),
      /checksum mismatch/,
    );
    assert.equal(fs.existsSync(dest), false);
  });

  test("writes only after both checksums match", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-sum-"));
    const dest = path.join(dir, "geosite.dat");
    const bytes = Buffer.from("tiny");
    const sum = sha256(bytes);
    await acceptDataset({ bytes, officialText: `${sum}  dlc.dat\n`, asset: "dlc.dat", expected: sum, dest });
    assert.equal(fs.readFileSync(dest).toString(), "tiny");
  });

  test("refuses Loyalsoldier, sing-box, and any url outside the two v2fly releases", () => {
    assert.throws(() => assertAllowedUrl("https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/20261108/geoip.dat"), /non-v2fly/);
    assert.throws(() => assertAllowedUrl("https://github.com/SagerNet/sing-geoip/releases/download/20261108/geoip.dat"), /non-v2fly/);
    assert.throws(() => assertAllowedUrl("https://example.com/geoip.dat"), /not a v2fly/);
    assert.throws(() => validateLock({ ...lock, files: lock.files.map((f) => ({ ...f, url: "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/download/x/geoip.dat" })) }), /non-v2fly|not a v2fly|not tag/);
  });
});

describe("opt-in cyber geo annotation", () => {
  const dir = writeFixture(fs.mkdtempSync(path.join(os.tmpdir(), "geo-hook-")));
  const loopback = (forwarded) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": forwarded } });

  test("stays off unless the flag is set", () => {
    assert.equal(geoEnabled({}), false);
    assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "0" }), false);
    assert.equal(geoEnabled({ INFINITUM_GEO_ENABLED: "1" }), true);
    resetGeoCache();
    assert.equal(annotateProductRequest(loopback("1.2.3.4"), { domain: "www.example.test", env: {}, dir }), null);
  });

  test("annotates from the socket, and from a forwarded header only on loopback", () => {
    resetGeoCache();
    const env = { INFINITUM_GEO_ENABLED: "1" };
    const note = annotateProductRequest(loopback("1.2.3.4"), { domain: "https://tracker.example.test/a", env, dir });
    assert.deepEqual(note, { country: "us", categories: ["example", "telemetry"] });
    const remote = { socket: { remoteAddress: "1.2.9.9" }, headers: { "x-forwarded-for": "1.2.3.4" } };
    assert.equal(clientAddress(remote), "1.2.9.9");
    assert.equal(annotateProductRequest(remote, { domain: "", env, dir }).country, "cn");
  });
});

function startServer(extraEnv = {}) {
  const port = 49000 + Math.floor(Math.random() * 400) * 2;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conjure-geo-"));
  const data = path.join(tmp, "data");
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
      CONJURE_DATA: data,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    data,
    log: () => log,
    ready: (async () => {
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(`${base}/healthz`)).ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`server did not start:\n${log}`);
    })(),
    stop: () => child.kill(),
  };
}

async function waitUsage(file) {
  for (let i = 0; i < 40; i++) {
    try {
      const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length) return lines.map((l) => JSON.parse(l));
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

async function forecast(s, headers) {
  await s.ready;
  const res = await fetch(`${s.base}/v1/predictions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      question: "will the launch hold?",
      source: "https://tracker.example.test/a",
      rounds: 1,
      agents: 4,
      geo: { country: "xx", categories: ["injected"] },
      geoNote: { country: "xx", categories: ["injected"] },
    }),
  });
  assert.equal(res.status, 202);
  const started = await res.json();
  assert.equal(started.geo, undefined, "the product response stays free of the annotation");
  let view = started;
  for (let i = 0; i < 100 && !["done", "failed", "cancelled"].includes(view.status); i++) {
    await new Promise((r) => setTimeout(r, 50));
    view = await (await fetch(`${s.base}/v1/predictions/${started.id}`)).json();
  }
  assert.equal(view.status, "done", s.log());
  assert.equal(view.geo, undefined);
  return waitUsage(path.join(s.data, "usage.jsonl"));
}

describe("product usage log", () => {
  test("default requests are logged without a geo note", async () => {
    const s = startServer();
    try {
      const lines = await forecast(s);
      assert.equal(lines.length, 1);
      assert.equal(Object.hasOwn(lines[0], "geo"), false);
      assert.equal(lines[0].kind, "prediction");
    } finally {
      s.stop();
    }
  });

  test("a flagged request records country and categories for every product call", async () => {
    const dir = writeFixture(fs.mkdtempSync(path.join(os.tmpdir(), "geo-srv-")));
    const s = startServer({ INFINITUM_GEO_ENABLED: "1", INFINITUM_GEO_DIR: dir });
    try {
      const lines = await forecast(s, { "x-forwarded-for": "1.2.3.4" });
      assert.equal(lines.length, 1);
      assert.deepEqual(lines[0].geo, { country: "us", categories: ["example", "telemetry"] });
      assert.equal(s.log().includes("cyber geo annotation on"), true);
    } finally {
      s.stop();
    }
  });
});
