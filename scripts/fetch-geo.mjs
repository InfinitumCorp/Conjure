#!/usr/bin/env node
// Download the pinned v2fly geoip.dat and geosite.dat (dlc.dat) files.
// Writes only to data/geo/, which is gitignored. Refuses any other publisher.
// Checks each file against the official .sha256sum asset and the lockfile.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_PREFIXES = [
  "https://github.com/v2fly/geoip/releases/download/",
  "https://github.com/v2fly/domain-list-community/releases/download/",
];

export function assertV2flyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`refusing geo URL ${url}`);
  }
  const full = parsed.href;
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error(`refusing geo URL ${url}`);
  if (/loyalsoldier|sing-box|singbox/i.test(full)) throw new Error(`refusing non-v2fly geo URL ${url}`);
  if (!ALLOWED_PREFIXES.some((prefix) => full.startsWith(prefix))) throw new Error(`refusing non-v2fly geo URL ${url}`);
  return full;
}

/** First 64-hex digest in an official .sha256sum asset. */
export function parseSha256Sum(text) {
  const match = String(text).match(/\b([a-f0-9]{64})\b/i);
  if (!match) throw new Error("official sha256sum asset has no digest");
  return match[1].toLowerCase();
}

export function assertChecksum(bytes, expected, label) {
  const got = crypto.createHash("sha256").update(bytes).digest("hex");
  const want = String(expected).toLowerCase();
  if (got !== want) throw new Error(`checksum mismatch for ${label}: downloaded ${got}, expected ${want}`);
  return got;
}

/**
 * Download one lockfile entry. Stops before writing when the official
 * .sha256sum asset disagrees with the lockfile or the bytes.
 */
export async function fetchLockedFile(entry, { outDir, fetchImpl = globalThis.fetch } = {}) {
  if (!entry?.name || !entry.url || !entry.sha256sumUrl || !entry.sha256) throw new Error("geo lock entry is incomplete");
  assertV2flyUrl(entry.url);
  assertV2flyUrl(entry.sha256sumUrl);
  const sumRes = await fetchImpl(entry.sha256sumUrl);
  if (!sumRes.ok) throw new Error(`could not download ${entry.sha256sumUrl} (${sumRes.status})`);
  const sumText = await sumRes.text();
  const official = parseSha256Sum(sumText);
  if (official !== entry.sha256.toLowerCase()) {
    throw new Error(`checksum mismatch for ${entry.name}: lockfile ${entry.sha256} but official sha256sum is ${official}`);
  }
  const named = sumText.trim().split(/\s+/)[1];
  if (named && named !== entry.name && named !== entry.upstream) {
    throw new Error(`official sha256sum names ${named}, not ${entry.upstream || entry.name}`);
  }
  const fileRes = await fetchImpl(entry.url);
  if (!fileRes.ok) throw new Error(`could not download ${entry.url} (${fileRes.status})`);
  const bytes = Buffer.from(await fileRes.arrayBuffer());
  assertChecksum(bytes, official, entry.name);
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, entry.name);
  const partial = `${dest}.${process.pid}.partial`;
  fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, dest);
  return { name: entry.name, sha256: official, bytes: bytes.length };
}

export async function fetchGeoDatasets({ lockPath = path.join(root, "geo.lock.json"), outDir = path.join(root, "data", "geo"), fetchImpl } = {}) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (lock.publisher !== "v2fly") throw new Error("geo lockfile publisher must be v2fly");
  if (!Array.isArray(lock.files) || lock.files.length === 0) throw new Error("geo lockfile has no files");
  const saved = [];
  for (const entry of lock.files) saved.push(await fetchLockedFile(entry, { outDir, fetchImpl }));
  return saved;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  fetchGeoDatasets()
    .then((saved) => {
      for (const file of saved) console.log(`ok ${file.name} ${file.sha256} (${file.bytes} bytes)`);
    })
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}
