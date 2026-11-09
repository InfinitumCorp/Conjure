// Staff preferences. Missing file means every setting is at its default.
import fs from "node:fs/promises";
import path from "node:path";

export function conjureDataDir() {
  return path.resolve(process.env.CONJURE_DATA || "conjure-data");
}

export class SettingsStore {
  constructor(file) {
    this.file = file;
    this.data = { geoRouting: false };
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
      this.data.geoRouting = parsed?.geoRouting === true;
    } catch {
      this.data.geoRouting = false;
    }
    return this;
  }

  get geoRouting() {
    return this.data.geoRouting === true;
  }

  view() {
    return { geoRouting: this.geoRouting };
  }

  async setGeoRouting(on) {
    this.data.geoRouting = on === true;
    await this.save();
    return this.geoRouting;
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ geoRouting: this.geoRouting }, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
}
