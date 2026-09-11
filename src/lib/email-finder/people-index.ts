/**
 * Fresh people index — competitor millisecond path.
 * Not a multi-year dump: records expire (default 14d). Live harvest
 * writes here; Discover reads first, then fills.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

export type IndexedPerson = {
  name: string;
  title?: string;
  location?: string;
  url: string;
  slug: string;
  source: "linkedin" | "theorg" | "google";
  company?: string;
  keywords: string[];
  geo?: string;
  industry?: string;
  seenAt: number;
};

const FILE = "/workspace/data/people-index.json";
const TTL_MS = 14 * 24 * 3600_000;
const MAX = 80_000;

type FileShape = { updatedAt: number; records: IndexedPerson[] };

let mem: IndexedPerson[] | null = null;

function load(): IndexedPerson[] {
  if (mem) return mem;
  try {
    const j = JSON.parse(readFileSync(FILE, "utf8")) as FileShape;
    const cut = Date.now() - TTL_MS;
    mem = (j.records ?? []).filter((r) => r.seenAt > cut).slice(-MAX);
  } catch {
    mem = [];
  }
  return mem;
}

function save() {
  if (!mem) return;
  try {
    mkdirSync("/workspace/data", { recursive: true });
    writeFileSync(
      FILE,
      JSON.stringify({ updatedAt: Date.now(), records: mem.slice(-MAX) }),
    );
  } catch {
    /* disk */
  }
}

export function indexAdd(rows: IndexedPerson[]) {
  const list = load();
  const seen = new Set(list.map((r) => r.slug));
  let n = 0;
  const now = Date.now();
  for (const r of rows) {
    if (!r.slug || seen.has(r.slug)) continue;
    seen.add(r.slug);
    list.push({ ...r, seenAt: r.seenAt || now });
    n++;
  }
  if (n) save();
}

export function indexQuery(opts: {
  keywords?: string;
  geo?: string;
  industry?: string;
  company?: string;
  title?: string;
  limit?: number;
}): IndexedPerson[] {
  const list = load();
  const kw = (opts.keywords ?? "").toLowerCase().trim();
  const geo = (opts.geo ?? "").toLowerCase().trim();
  const industry = (opts.industry ?? "").toLowerCase().trim();
  const company = (opts.company ?? "").toLowerCase().trim();
  const title = (opts.title ?? "").toLowerCase().trim();
  const out: IndexedPerson[] = [];
  for (const r of list) {
    const blob = `${r.name} ${r.title ?? ""} ${r.company ?? ""} ${r.keywords.join(" ")}`.toLowerCase();
    if (kw && !blob.includes(kw) && !r.keywords.some((k) => k.includes(kw))) continue;
    if (title && !(r.title ?? "").toLowerCase().includes(title)) continue;
    if (company && !(r.company ?? "").toLowerCase().includes(company)) continue;
    if (industry && !(r.industry ?? "").toLowerCase().includes(industry) && !blob.includes(industry))
      continue;
    if (geo) {
      const loc = `${r.location ?? ""} ${r.geo ?? ""}`.toLowerCase();
      if (loc && !loc.includes(geo) && !geo.includes("united states")) {
        /* keep if location unknown — tagged at ingest */
      }
      if (geo.includes("united states") || geo === "us") {
        if (loc && /india|china|brazil|france|germany|uk\b|united kingdom/.test(loc) && !/united states|usa|us\b/.test(loc))
          continue;
      }
    }
    out.push(r);
    if (out.length >= (opts.limit ?? 50_000)) break;
  }
  return out;
}

export function indexSize() {
  return load().length;
}
