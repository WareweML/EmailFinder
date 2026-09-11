/**
 * 90-day hit cache. Same window Prospeo uses (re-enrich = 0 credits for 90 days).
 * Not a 125M warehouse — only numbers we actually resolved live.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const PATH = "/workspace/data/phone-cache.json";
const TTL_MS = 90 * 24 * 60 * 60 * 1000;

type Row = { e164: string; display: string; source: string; at: number };

function load(): Record<string, Row> {
  try {
    if (!existsSync(PATH)) return {};
    return JSON.parse(readFileSync(PATH, "utf8")) as Record<string, Row>;
  } catch {
    return {};
  }
}

function save(db: Record<string, Row>) {
  mkdirSync(dirname(PATH), { recursive: true });
  const now = Date.now();
  const fresh: Record<string, Row> = {};
  for (const [k, v] of Object.entries(db)) {
    if (now - v.at < TTL_MS) fresh[k] = v;
  }
  writeFileSync(PATH, JSON.stringify(fresh));
}

export function cacheKey(opts: { fullName: string; domain?: string; linkedinUrl?: string }): string {
  const li = (opts.linkedinUrl ?? "").toLowerCase().match(/linkedin\.com\/in\/([^/?#]+)/);
  if (li?.[1]) return `li:${li[1]}`;
  const name = opts.fullName.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const dom = (opts.domain ?? "").toLowerCase().replace(/^www\./, "");
  return `n:${name}|${dom}`;
}

export function cacheGet(key: string): Row | null {
  const row = load()[key];
  if (!row || Date.now() - row.at > TTL_MS) return null;
  return row;
}

export function cacheSet(key: string, row: Omit<Row, "at">) {
  const db = load();
  db[key] = { ...row, at: Date.now() };
  save(db);
}
