#!/usr/bin/env node
// Download the pinned v2fly geoip.dat and geosite.dat (dlc.dat) into data/geo/.
// Checks each official .sha256sum asset against geo.lock.json, then checks the
// bytes. On any mismatch it stops and writes nothing for that file.
//   node scripts/fetch-geo.mjs
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED = {
  "geoip.dat": {
    project: "v2fly/geoip",
    asset: "geoip.dat",
    prefix: "/v2fly/geoip/releases/download/",
  },
  "geosite.dat": {
    project: "v2fly/domain-list-community",
    asset: "dlc.dat",
    prefix: "/v2fly/domain-list-community/releases/download/",
  },
};

const BANNED = [/loyalsoldier/i, /sing-box/i, /singbox/i, /sagernet/i];

export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Official sha256sum(1) text: "<64 hex>  <filename>". */
export function parseSha256Sum(text, asset) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = /^([a-fA-F0-9]{64})\s+\*?(\S+)$/.exec(line);
    if (m && (!asset || m[2] === asset || m[2].endsWith(`/${asset}`))) return m[1].toLowerCase();
  }
  const only = lines.length === 1 && /^([a-fA-F0-9]{64})$/.exec(lines[0]);
  if (only) return only[1].toLowerCase();
  throw new Error(`official checksum file has no SHA-256 line for ${asset}`);
}

export function assertAllowedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid dataset URL: ${url}`);
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error(`dataset URL is not a v2fly GitHub release asset: ${url}`);
  }
  if (BANNED.some((re) => re.test(url))) throw new Error(`refusing non-v2fly dataset URL: ${url}`);
  const ok = Object.values(ALLOWED).some((spec) => parsed.pathname.startsWith(spec.prefix));
  if (!ok) throw new Error(`dataset URL is not a pinned v2fly release asset: ${url}`);
  return parsed;
}

export function validateLock(lock) {
  if (!lock || !Array.isArray(lock.files)) throw new Error("geo.lock.json is missing files");
  const names = lock.files.map((f) => f.name).slice().sort();
  if (names.join(",") !== "geoip.dat,geosite.dat") {
    throw new Error("geo.lock.json must list geoip.dat and geosite.dat, and nothing else");
  }
  const outDir = String(lock.outDir || "data/geo");
  if (path.isAbsolute(outDir) || outDir.split(/[\\/]/).includes("..")) {
    throw new Error("geo.lock.json outDir must stay inside the repo");
  }
  for (const file of lock.files) {
    const spec = ALLOWED[file.name];
    if (!spec) throw new Error(`unexpected dataset ${file.name}`);
    if (file.project !== spec.project) throw new Error(`${file.name} must come from ${spec.project}`);
    if (file.asset !== spec.asset) throw new Error(`${file.name} must use asset ${spec.asset}`);
    if (!/^[0-9]{8,}$/.test(String(file.tag || ""))) throw new Error(`${file.name} tag is not a v2fly release tag`);
    if (!/^[a-f0-9]{64}$/.test(String(file.sha256 || ""))) throw new Error(`${file.name} sha256 must be 64 hex characters`);
    for (const key of ["url", "sha256sumUrl"]) {
      const parsed = assertAllowedUrl(file[key]);
      if (!parsed.pathname.startsWith(`${spec.prefix}${file.tag}/`)) {
        throw new Error(`${file.name} ${key} is not tag ${file.tag}`);
      }
    }
    if (!file.url.endsWith(`/${file.asset}`)) throw new Error(`${file.name} url must end with /${file.asset}`);
    if (!file.sha256sumUrl.endsWith(`/${file.asset}.sha256sum`)) {
      throw new Error(`${file.name} sha256sumUrl must name ${file.asset}.sha256sum`);
    }
  }
  return { outDir, files: lock.files };
}

/**
 * Accept bytes only when the official checksum text matches the lockfile and
 * the bytes. Throws before writing on either mismatch.
 */
export async function acceptDataset({ bytes, officialText, asset, expected, dest }) {
  const official = parseSha256Sum(officialText, asset);
  const want = String(expected).toLowerCase();
  if (official !== want) {
    throw new Error(`checksum mismatch for ${asset}: official .sha256sum is ${official}, lockfile has ${want}. Stopped before writing.`);
  }
  const got = sha256(bytes);
  if (got !== official) {
    throw new Error(`checksum mismatch for ${asset}: downloaded file is ${got}, official .sha256sum is ${official}. Stopped before writing.`);
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.part`;
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, dest);
  return official;
}

async function download(url) {
  assertAllowedUrl(url);
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "conjure-geo-fetch", accept: "application/octet-stream" },
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchLockedDatasets({ lockPath = path.join(root, "geo.lock.json"), destRoot = root } = {}) {
  const lock = validateLock(JSON.parse(await fs.readFile(lockPath, "utf8")));
  const outDir = path.resolve(destRoot, lock.outDir);
  if (outDir !== destRoot && !outDir.startsWith(destRoot + path.sep)) throw new Error("refusing to write outside the repo");
  const written = [];
  for (const file of lock.files) {
    const dest = path.join(outDir, file.name);
    const officialText = (await download(file.sha256sumUrl)).toString("utf8");
    const official = parseSha256Sum(officialText, file.asset);
    if (official !== file.sha256) {
      throw new Error(`checksum mismatch for ${file.asset}: official .sha256sum is ${official}, lockfile has ${file.sha256}. Stopped before writing.`);
    }
    try {
      const existing = await fs.readFile(dest);
      if (sha256(existing) === official) {
        console.log(`ok ${file.name} (already matches ${official})`);
        written.push(dest);
        continue;
      }
    } catch {}
    const bytes = await download(file.url);
    await acceptDataset({ bytes, officialText, asset: file.asset, expected: file.sha256, dest });
    console.log(`fetched ${file.name} from ${file.project}@${file.tag} (${official})`);
    written.push(dest);
  }
  return written;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  fetchLockedDatasets().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
