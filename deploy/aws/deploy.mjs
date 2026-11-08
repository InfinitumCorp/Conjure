#!/usr/bin/env node
// Deploys Conjure to AWS with the AWS CLI (v2) and your configured credentials.
//
//   node deploy/aws/deploy.mjs                 create the stack, or update the running instance
//   node deploy/aws/deploy.mjs --status        show the stack's URL and state
//   node deploy/aws/deploy.mjs --destroy --yes delete the stack (instance, IP, network)
//
// Options: --profile <p> (default: AWS_PROFILE), --region <r> (default: AWS_REGION, then the
//          profile's configured region, then us-east-1),
//          --stack <name> (default conjure), --instance-type <t> (default t4g.small).
//
// Secrets never pass through the command line or the template:
//   /conjure/access-token       generated on first deploy, saved locally to .conjure-access-token
//   /conjure/anthropic-api-key  copied from ANTHROPIC_API_KEY in .env when it is set
// Both are SSM SecureString parameters, read by the instance at install time.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { values: opt } = parseArgs({
  options: {
    profile: { type: "string" },
    region: { type: "string" },
    stack: { type: "string", default: "conjure" },
    "instance-type": { type: "string", default: "t4g.small" },
    status: { type: "boolean" },
    destroy: { type: "boolean" },
    yes: { type: "boolean" },
  },
});

const step = (s) => console.log(`\n» ${s}`);
// Use the AWS CLI on PATH, or its default Windows install locations (a shell opened before
// the install may not have the new PATH yet).
const AWS = (() => {
  if (process.platform !== "win32" || spawnSync("aws", ["--version"]).status === 0) return "aws";
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Amazon", "AWSCLIV2", "aws.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Amazon", "AWSCLIV2", "aws.exe"),
  ];
  return candidates.find((c) => fs.existsSync(c)) || "aws";
})();
function aws(args, { input, allowFail = false, quiet = false } = {}) {
  const r = spawnSync(AWS, [...args, "--region", region, "--output", "json"], { encoding: "utf8", input, maxBuffer: 64 << 20 });
  if (r.error?.code === "ENOENT") die("AWS CLI not found. Install AWS CLI v2, then run `aws configure` (or `aws sso login`).");
  if (r.status !== 0) {
    if (allowFail) return null;
    die(`aws ${args.slice(0, 2).join(" ")} failed:\n${(r.stderr || r.stdout).trim()}`);
  }
  if (!quiet && process.env.CONJURE_DEPLOY_DEBUG) console.log(r.stdout);
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}
function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (opt.profile) process.env.AWS_PROFILE = opt.profile; // every aws call below inherits it
let region = opt.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
if (!region) {
  const r = spawnSync(AWS, ["configure", "get", "region"], { encoding: "utf8" });
  if (r.error?.code === "ENOENT") die("AWS CLI not found. Install AWS CLI v2, then run `aws configure` (or `aws sso login`).");
  region = r.stdout.trim() || "us-east-1";
}
const STACK = opt.stack;

const ident = aws(["sts", "get-caller-identity"], { allowFail: true });
if (!ident) die("No working AWS credentials. Run `aws login` (browser sign-in), `aws configure` or `aws sso login`, then try again.");
console.log(`✦ Conjure → AWS  account ${ident.Account}  region ${region}  stack ${STACK}${process.env.AWS_PROFILE ? `  profile ${process.env.AWS_PROFILE}` : ""}`);

const stackInfo = () => aws(["cloudformation", "describe-stacks", "--stack-name", STACK], { allowFail: true })?.Stacks?.[0];
const outputs = (s) => Object.fromEntries((s?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));

if (opt.status) {
  const s = stackInfo();
  if (!s) die(`stack ${STACK} does not exist in ${region}`);
  console.log(`  status: ${s.StackStatus}`);
  for (const [k, v] of Object.entries(outputs(s))) console.log(`  ${k}: ${v}`);
  process.exit(0);
}

if (opt.destroy) {
  if (!opt.yes) die("--destroy deletes the instance and every deliverable on it. Re-run with --destroy --yes to confirm.");
  step(`deleting stack ${STACK}`);
  aws(["cloudformation", "delete-stack", "--stack-name", STACK]);
  aws(["cloudformation", "wait", "stack-delete-complete", "--stack-name", STACK]);
  console.log("✓ deleted. The deploy bucket and the /conjure/* SSM parameters were kept.");
  process.exit(0);
}

// --- 1. Deploy bucket ---
const bucket = `conjure-deploy-${ident.Account}-${region}`;
step(`deploy bucket s3://${bucket}`);
if (!aws(["s3api", "head-bucket", "--bucket", bucket], { allowFail: true })) {
  const create = ["s3api", "create-bucket", "--bucket", bucket];
  if (region !== "us-east-1") create.push("--create-bucket-configuration", `LocationConstraint=${region}`);
  aws(create);
  aws(["s3api", "put-public-access-block", "--bucket", bucket, "--public-access-block-configuration",
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"]);
  console.log("  created (private)");
} else console.log("  exists");

/** Minimal POSIX ustar archive of `rels` (paths relative to root), so packaging needs no tar binary. */
function ustar(rels) {
  const blocks = [];
  const field = (buf, off, len, str) => buf.write(str, off, len, "utf8");
  const octal = (buf, off, len, n) => field(buf, off, len, n.toString(8).padStart(len - 1, "0") + "\0");
  for (const rel of rels) {
    const full = path.join(root, rel);
    const st = fs.statSync(full);
    if (!st.isFile()) continue;
    let name = rel, prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const i = rel.slice(0, 155).lastIndexOf("/");
      if (i <= 0 || Buffer.byteLength(rel.slice(i + 1)) > 100) die(`path too long for the release archive: ${rel}`);
      prefix = rel.slice(0, i); name = rel.slice(i + 1);
    }
    const data = fs.readFileSync(full);
    const h = Buffer.alloc(512);
    field(h, 0, 100, name);
    octal(h, 100, 8, /\.(sh|mjs)$/.test(rel) || rel.startsWith("bin/") ? 0o755 : 0o644);
    octal(h, 108, 8, 0); octal(h, 116, 8, 0);
    octal(h, 124, 12, data.length);
    octal(h, 136, 12, Math.floor(st.mtimeMs / 1000));
    h.fill(0x20, 148, 156); // checksum placeholder
    h[156] = 0x30; // regular file
    field(h, 257, 6, "ustar\0"); field(h, 263, 2, "00");
    field(h, 345, 155, prefix);
    let sum = 0;
    for (const b of h) sum += b;
    field(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// --- 2. Release tarball from the working tree (tracked + untracked, minus ignored files) ---
step("packaging release");
const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const files = git(["ls-files", "-co", "--exclude-standard"]).stdout.split("\n")
  .filter((f) => f && fs.existsSync(path.join(root, f)) && !/^(android|test|eval|conjured)\//.test(f));
if (!files.includes("deploy/aws/install.sh") || !files.includes("src/server.js")) die("run this from the Conjure repository");
const sha = git(["rev-parse", "--short", "HEAD"]).stdout.trim() || "nogit";
const dirty = git(["status", "--porcelain"]).stdout.trim() ? "-dirty" : "";
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const key = `releases/${stamp}-${sha}${dirty}.tar.gz`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conjure-"));
const tarball = path.join(tmp, "conjure.tar.gz");
fs.writeFileSync(tarball, zlib.gzipSync(ustar(files), { level: 9 }));
console.log(`  ${files.length} files, ${(fs.statSync(tarball).size / 1024).toFixed(0)} KB → ${key}`);
aws(["s3", "cp", tarball, `s3://${bucket}/${key}`, "--only-show-errors"]);

// --- 3. Secrets in SSM Parameter Store ---
step("secrets (SSM Parameter Store)");
const tokenFile = path.join(root, ".conjure-access-token");
const putSecret = (name, value) =>
  aws(["ssm", "put-parameter", "--name", name, "--type", "SecureString", "--overwrite", "--cli-input-json",
    JSON.stringify({ Value: value })], { quiet: true });
const hasParam = (name) => Boolean(aws(["ssm", "get-parameter", "--name", name], { allowFail: true, quiet: true }));
if (!hasParam("/conjure/access-token")) {
  const token = crypto.randomBytes(24).toString("base64url");
  putSecret("/conjure/access-token", token);
  fs.writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
  console.log("  access token created → saved to .conjure-access-token (git-ignored)");
} else {
  console.log(`  access token exists${fs.existsSync(tokenFile) ? " (copy in .conjure-access-token)" : ""}`);
}
let apiKey = process.env.ANTHROPIC_API_KEY || "";
const envFile = path.join(root, ".env");
if (!apiKey && fs.existsSync(envFile)) {
  apiKey = /^ANTHROPIC_API_KEY=(.*)$/m.exec(fs.readFileSync(envFile, "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
}
if (apiKey) {
  putSecret("/conjure/anthropic-api-key", apiKey);
  console.log("  Anthropic API key stored (live mode)");
} else {
  console.log("  no ANTHROPIC_API_KEY in .env: the server runs in offline (mock) mode until you add one and redeploy");
}

// --- 4. Stack ---
const template = path.join(root, "deploy", "aws", "conjure.yaml");
let s = stackInfo();
if (s && /ROLLBACK_COMPLETE$|^DELETE_COMPLETE$/.test(s.StackStatus) && s.StackStatus !== "UPDATE_ROLLBACK_COMPLETE") {
  die(`stack ${STACK} is in ${s.StackStatus}; delete it with --destroy --yes and deploy again`);
}
const fresh = !s;
step(fresh ? "creating stack (about 3-5 minutes)" : "updating stack");
const deployArgs = ["cloudformation", "deploy", "--template-file", template, "--stack-name", STACK,
  "--capabilities", "CAPABILITY_IAM", "--no-fail-on-empty-changeset", "--parameter-overrides",
  `CodeBucket=${bucket}`, `InstanceType=${opt["instance-type"]}`];
if (fresh) deployArgs.push(`CodeKey=${key}`);
if (opt["instance-type"].startsWith("t3")) deployArgs.push("ImageId=/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64");
const d = spawnSync(AWS, [...deployArgs, "--region", region], { stdio: "inherit" });
if (d.status !== 0) die("CloudFormation deploy failed; see the stack events in the AWS console");
s = stackInfo();
const out = outputs(s);

// --- 5. Roll the new release onto a running instance ---
if (!fresh) {
  step(`installing ${key} on ${out.InstanceId} (SSM Run Command)`);
  const host = (u) => new URL(u).host;
  const commands = [
    "set -euo pipefail",
    `aws s3 cp --region ${region} --only-show-errors s3://${bucket}/${key} /tmp/conjure-release.tar.gz`,
    "rm -rf /tmp/conjure-boot && mkdir -p /tmp/conjure-boot",
    "tar -xzf /tmp/conjure-release.tar.gz -C /tmp/conjure-boot deploy/aws/install.sh",
    "install -m 0755 /tmp/conjure-boot/deploy/aws/install.sh /opt/conjure/install.sh",
    `/opt/conjure/install.sh ${bucket} ${key} ${host(out.AppUrl)} ${host(out.PreviewUrl)} ${region}`,
  ];
  const cmd = aws(["ssm", "send-command", "--instance-ids", out.InstanceId, "--document-name", "AWS-RunShellScript",
    "--comment", `conjure ${key}`.slice(0, 100), "--parameters", JSON.stringify({ commands, executionTimeout: ["900"] })]);
  const id = cmd.Command.CommandId;
  let inv;
  for (let i = 0; i < 180; i++) {
    inv = aws(["ssm", "get-command-invocation", "--command-id", id, "--instance-id", out.InstanceId], { allowFail: true, quiet: true });
    if (inv && !["Pending", "InProgress", "Delayed"].includes(inv.Status)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log((inv?.StandardOutputContent || "").trim().split("\n").slice(-5).map((l) => "  " + l).join("\n"));
  if (inv?.Status !== "Success") die(`install ${inv?.Status ?? "timed out"}:\n${(inv?.StandardErrorContent || "").trim().slice(-2000)}`);
}

// --- 6. Wait for HTTPS ---
step(`waiting for ${out.AppUrl}`);
let ok = false;
for (let i = 0; i < 90 && !ok; i++) {
  try {
    const r = await fetch(`${out.AppUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
    ok = r.ok;
  } catch {}
  if (!ok) await new Promise((r) => setTimeout(r, 5000));
}
if (!ok) die(`${out.AppUrl} is not answering yet. First boot installs Node and gets a certificate; check again with --status in a few minutes.`);
console.log(`\n✓ Conjure is live: ${out.AppUrl}`);
console.log(`  previews: ${out.PreviewUrl}`);
console.log(`  sign in with the token in .conjure-access-token`);
console.log(`  Android app: adb shell am start -n com.conjure.app/.MainActivity --es url ${out.AppUrl}/`);
