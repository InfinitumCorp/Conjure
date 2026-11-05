// Sandboxed workspace: every path the model supplies is untrusted and is
// confined to the workspace root before any read or write.
import fs from "node:fs/promises";
import path from "node:path";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 60;

export class Workspace {
  constructor(root) {
    this.root = path.resolve(root);
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    return this;
  }

  resolve(relPath) {
    if (typeof relPath !== "string" || relPath.trim() === "") {
      throw new WorkspaceError("path must be a non-empty string");
    }
    const target = path.resolve(this.root, relPath);
    const rel = path.relative(this.root, target);
    if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
      throw new WorkspaceError(`path escapes the workspace: ${relPath}`);
    }
    return target;
  }

  async write(relPath, contents) {
    if (typeof contents !== "string") throw new WorkspaceError("contents must be a string");
    if (Buffer.byteLength(contents) > MAX_FILE_BYTES) {
      throw new WorkspaceError(`file too large (max ${MAX_FILE_BYTES} bytes)`);
    }
    const target = this.resolve(relPath);
    const existing = await this.list();
    const rel = this.rel(target);
    if (!existing.includes(rel) && existing.length >= MAX_FILES) {
      throw new WorkspaceError(`too many files (max ${MAX_FILES})`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, "utf8");
    return rel;
  }

  async read(relPath) {
    return fs.readFile(this.resolve(relPath), "utf8");
  }

  async list() {
    const out = [];
    const walk = async (dir) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(this.rel(full));
      }
    };
    await walk(this.root);
    return out.sort();
  }

  rel(full) {
    return path.relative(this.root, full).split(path.sep).join("/");
  }
}

export class WorkspaceError extends Error {}
