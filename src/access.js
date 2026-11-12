// Who may use this Conjure server.
//   People sign in with Cumulus ID (id.cumuluscloud.app), never a token typed into a form:
//   Users:    anyone with a Cumulus ID. Each account sees, cancels and downloads only its own
//             builds, and gets what its Conjure plan allows (see plans.js).
//   Owner:    a Cumulus ID listed in CID_OWNERS. Full admin. CONJURE_ACCESS_TOKEN turns access
//             control on and signs session cookies; scripts may still send it as a Bearer token.
//   Staff:    Infinitum staff, matched by their Cumulus ID (or email until it is linked). Role
//             "admin" or "staff". Each also gets a cjs_ token, for scripts only. Admins can see
//             every account's builds and runs; staff work in their own space like users.
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
    this.data = { staff: [], products: [], users: [] };
    this.usageFile = path.join(path.dirname(file), "usage.jsonl");
    // Cookie signing key: derived from the owner token so sessions survive restarts.
    this.secret = crypto.createHmac("sha256", this.ownerToken || crypto.randomBytes(32)).update("conjure-session-v2").digest();
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      this.data = { staff: [], products: [], users: [], ...JSON.parse(await fs.readFile(this.file, "utf8")) };
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

  /** A staff member or the owner, from a sign-in token. */
  staffByToken(token) {
    if (!token) return null;
    if (this.ownerToken && safeEqual(token, this.ownerToken)) return this.owner();
    if (!token.startsWith("cjs_")) return null;
    const h = sha(token);
    const s = this.data.staff.find((x) => !x.revokedAt && safeEqual(x.hash, h));
    return s ? { kind: "staff", id: s.id, name: s.name, role: s.role } : null;
  }

  /**
   * The owner or a staff member, from a verified Cumulus ID profile ({ cid, username, email }).
   * A staff record added by email is linked to the first Cumulus ID that signs in with that email.
   */
  async staffByCid(profile, owners = []) {
    if (!profile?.cid) return null;
    if (isOwner(profile, owners)) return this.owner();
    const email = String(profile.email || "").toLowerCase();
    let s = this.data.staff.find((x) => !x.revokedAt && x.cid && x.cid === profile.cid);
    if (!s && email) s = this.data.staff.find((x) => !x.revokedAt && !x.cid && x.email && x.email.toLowerCase() === email);
    if (!s) return null;
    if (!s.cid) {
      s.cid = profile.cid;
      await this.save();
    }
    return { kind: "staff", id: s.id, name: s.name, role: s.role };
  }

  /** Staff or owner when listed; otherwise the person's own Conjure account, created on first sign-in. */
  async signInByCid(profile, owners = []) {
    return (await this.staffByCid(profile, owners)) || this.userByCid(profile);
  }

  /** The account for a Cumulus ID. Ids are a keyed hash of the cid, so they can't be guessed. */
  async userByCid(profile) {
    if (!profile?.cid) return null;
    const id = `u_${crypto.createHmac("sha256", this.secret).update(`cid:${profile.cid}`).digest("hex").slice(0, 24)}`;
    let u = this.data.users.find((x) => x.id === id);
    const name = String(profile.username || profile.handle || profile.email || "").trim().slice(0, 80) || "Cumulus ID";
    if (!u) {
      u = { id, cid: String(profile.cid).slice(0, 120), name, createdAt: now() };
      this.data.users.push(u);
    } else if (u.revokedAt) {
      return null;
    }
    Object.assign(u, { name, lastSignInAt: now() });
    await this.save();
    return this.userPrincipal(u);
  }

  userPrincipal(u) {
    return { kind: "user", id: u.id, name: u.name, role: "user" };
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

  /** The owner, a staff member or a user, from a session cookie. */
  bySession(value) {
    const parts = String(value || "").split(".");
    if (parts.length !== 3) return null;
    const [id, exp, mac] = parts;
    if (!safeEqual(mac, crypto.createHmac("sha256", this.secret).update(`${id}.${exp}`).digest("base64url"))) return null;
    if (!(Number(exp) > Date.now())) return null;
    if (id === "owner") return this.owner();
    if (id.startsWith("u_")) {
      const u = this.data.users.find((x) => x.id === id && !x.revokedAt);
      return u ? this.userPrincipal(u) : null;
    }
    const s = this.data.staff.find((x) => x.id === id && !x.revokedAt);
    return s ? { kind: "staff", id: s.id, name: s.name, role: s.role } : null;
  }

  /* ---- per-account space ---- */

  /**
   * The folder name for a principal's builds under the output directory. A keyed hash, so preview
   * URLs (served without sign-in, from another origin) can't be guessed from an account id.
   */
  spaceFor(principal) {
    return `k_${crypto.createHmac("sha256", this.secret).update(`space:${principal.id}`).digest("hex").slice(0, 24)}`;
  }

  /** Verified builds this account has made this calendar month (UTC). */
  buildsThisMonth(principal) {
    const month = now().slice(0, 7);
    const u = this.usageRow(principal);
    return u.month === month ? u.builds : 0;
  }

  async countBuild(principal) {
    const month = now().slice(0, 7);
    const u = this.usageRow(principal);
    if (u.month !== month) Object.assign(u, { month, builds: 0 });
    u.builds += 1;
    await this.save().catch(() => {});
  }

  usageRow(principal) {
    this.data.builds ??= {};
    return (this.data.builds[principal.id] ??= { month: now().slice(0, 7), builds: 0 });
  }

  /* ---- the person's Cumulus ID access token, sealed into its own cookie ---- */

  /** AES-256-GCM, bound to the account, so it can't be read or moved to another account. */
  sealToken(principal, token, maxAgeS) {
    const key = crypto.createHash("sha256").update(this.secret).update("cid-token-v1").digest();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([c.update(JSON.stringify({ u: principal.id, t: token, exp: Date.now() + maxAgeS * 1000 }), "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
  }

  openToken(principal, value) {
    try {
      const raw = Buffer.from(String(value || ""), "base64url");
      if (raw.length < 29) return null;
      const key = crypto.createHash("sha256").update(this.secret).update("cid-token-v1").digest();
      const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      const v = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"));
      return v.u === principal.id && v.exp > Date.now() && typeof v.t === "string" ? v.t : null;
    } catch {
      return null;
    }
  }

  /* ---- admin actions ---- */

  async addStaff({ name, email, role, cid }, by) {
    const n = String(name ?? "").trim().slice(0, 80);
    if (!n) throw new Error("name is required");
    const token = `cjs_${crypto.randomBytes(24).toString("base64url")}`;
    const rec = { id: `st_${crypto.randomBytes(6).toString("hex")}`, name: n, email: String(email ?? "").trim().slice(0, 120) || undefined, cid: String(cid ?? "").trim().slice(0, 120) || undefined, role: role === "admin" ? "admin" : "staff", hash: sha(token), prefix: token.slice(0, 10), createdAt: now(), createdBy: by?.name };
    this.data.staff.push(rec);
    await this.save();
    return { staff: this.publicStaff(rec), token };
  }

  async revokeStaff(id, by) {
    const s = this.data.staff.find((x) => x.id === id);
    if (!s || s.revokedAt) return false;
    Object.assign(s, { revokedAt: now(), revokedBy: by?.name });
    await this.save();
    return true;
  }

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

  publicStaff({ hash: _h, ...s }) {
    return s;
  }

  publicProduct({ hash: _h, ...p }) {
    return p;
  }

  listStaff() {
    return this.data.staff.map((s) => this.publicStaff(s));
  }

  listUsers() {
    return this.data.users.map(({ cid: _c, ...u }) => ({ ...u, buildsThisMonth: this.buildsThisMonth(u) }));
  }

  listProducts() {
    return this.data.products.map((p) => this.publicProduct(p));
  }

  /* ---- usage log ---- */

  async logUsage(entry) {
    await fs.appendFile(this.usageFile, JSON.stringify({ at: now(), ...entry }) + "\n").catch(() => {});
  }
}
