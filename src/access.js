// Who may use this Conjure server.
//   People sign in with Cumulus ID (id.cumuluscloud.app), never a token typed into a form:
//   Owner:    a Cumulus ID listed in CID_OWNERS. Full admin. CONJURE_ACCESS_TOKEN turns access
//             control on and signs session cookies; scripts may still send it as a Bearer token.
//   Products: one key per product (cjp_<slug>_...). Only the /v1 prediction API.
// Tokens are stored as SHA-256 hashes; the plain token is shown once when created.
import crypto from "node:crypto";
import { isOwner } from "./cid.js";
import fs from "node:fs/promises";
import path from "node:path";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const now = () => new Date().toISOString();

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Infinitum products that can call @conjure; slugs are what keys and the dashboard use. */
export const KNOWN_PRODUCTS = {
  architect: ":\\ARCHITECT\\", scalvs: "SCALVS.ai", spectre: "+SPCTR", cumulus: "Cumulus://Cloud", mail: "Cumulus://Mail",
  firm: "FIRM Wallet", firmament: "Firmament Network", aether: "ÆTHER", eon: "E(O)N", fabric: "FABRIC", veil: "VEIL</>",
  eidetic: "ei·det·ic", hrvst: "[HRVST]", metatron: "METATRON¹⁰⁰", throne: "#THRONE", academy: "Infinitum Academy",
  revenue: "Infinitum Revenue", exchange: "Cumulus Exchange", nexus: "Infinitum Nexus",
};

export class AccessStore {
  constructor({ file, ownerToken }) {
    this.file = file;
    this.ownerToken = ownerToken || "";
    this.data = { products: [] };
    this.usageFile = path.join(path.dirname(file), "usage.jsonl");
    // Cookie signing key: derived from the owner token so sessions survive restarts.
    this.secret = crypto.createHmac("sha256", this.ownerToken || crypto.randomBytes(32)).update("conjure-session-v2").digest();
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      this.data = { products: [], ...JSON.parse(await fs.readFile(this.file, "utf8")) };
    } catch {}
    return this;
  }

  async save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  get enabled() {
    return Boolean(this.ownerToken);
  }

  /* ---- principals ---- */

  owner() {
    return { kind: "staff", id: "owner", name: "Owner", role: "admin" };
  }

  /** The owner, from the owner token (scripts). */
  staffByToken(token) {
    if (!token) return null;
    return this.ownerToken && safeEqual(token, this.ownerToken) ? this.owner() : null;
  }

  /** The owner, from a verified Cumulus ID profile ({ cid, username, email }) listed in CID_OWNERS. */
  async staffByCid(profile, owners = []) {
    return profile?.cid && isOwner(profile, owners) ? this.owner() : null;
  }

  productByKey(key) {
    if (!key?.startsWith("cjp_")) return null;
    const h = sha(key);
    const p = this.data.products.find((x) => !x.revokedAt && safeEqual(x.hash, h));
    return p ? { kind: "product", id: p.id, slug: p.slug, name: p.name, dailyLimit: p.dailyLimit, record: p } : null;
  }

  /* ---- sessions (signed cookie: <staffId>.<expiry>.<mac>) ---- */

  sessionFor(principal, days = 30) {
    const exp = Date.now() + days * 864e5;
    const body = `${principal.id}.${exp}`;
    return `${body}.${crypto.createHmac("sha256", this.secret).update(body).digest("base64url")}`;
  }

  staffBySession(value) {
    const parts = String(value || "").split(".");
    if (parts.length !== 3) return null;
    const [id, exp, mac] = parts;
    if (!safeEqual(mac, crypto.createHmac("sha256", this.secret).update(`${id}.${exp}`).digest("base64url"))) return null;
    if (!(Number(exp) > Date.now())) return null;
    return id === "owner" ? this.owner() : null;
  }

  /* ---- admin actions ---- */

  async addProduct({ slug, name, dailyLimit }, by) {
    const sl = String(slug ?? "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(sl)) throw new Error("slug must be 2-31 lowercase letters, digits or hyphens");
    if (this.data.products.some((p) => p.slug === sl && !p.revokedAt)) throw new Error(`${sl} already has an active key; rotate it instead`);
    return this.issueProduct(sl, String(name ?? "").trim().slice(0, 80) || KNOWN_PRODUCTS[sl] || sl, dailyLimit, by);
  }

  async issueProduct(slug, name, dailyLimit, by) {
    const key = `cjp_${slug}_${crypto.randomBytes(24).toString("base64url")}`;
    const limit = Math.max(1, Math.min(100000, Math.round(Number(dailyLimit) || 500)));
    const rec = { id: `pk_${crypto.randomBytes(6).toString("hex")}`, slug, name, hash: sha(key), prefix: key.slice(0, slug.length + 9), dailyLimit: limit, createdAt: now(), createdBy: by?.name };
    this.data.products.push(rec);
    await this.save();
    return { product: this.publicProduct(rec), key };
  }

  /** New key for the same product; the old key stops working at once. */
  async rotateProduct(id, by) {
    const p = this.data.products.find((x) => x.id === id && !x.revokedAt);
    if (!p) throw new Error("no active key with that id");
    Object.assign(p, { revokedAt: now(), revokedBy: by?.name });
    return this.issueProduct(p.slug, p.name, p.dailyLimit, by);
  }

  async revokeProduct(id, by) {
    const p = this.data.products.find((x) => x.id === id);
    if (!p || p.revokedAt) return false;
    Object.assign(p, { revokedAt: now(), revokedBy: by?.name });
    await this.save();
    return true;
  }

  async touchProduct(rec) {
    rec.lastUsedAt = now();
    await this.save().catch(() => {});
  }

  publicProduct({ hash: _h, ...p }) {
    return p;
  }

  listProducts() {
    return this.data.products.map((p) => this.publicProduct(p));
  }

  /* ---- usage log ---- */

  async logUsage(entry) {
    await fs.appendFile(this.usageFile, JSON.stringify({ at: now(), ...entry }) + "\n").catch(() => {});
  }
}
