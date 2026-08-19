/**
 * Session cache of emails we just verified live.
 * Not a historical people dump — job changes make those stale.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { PatternId, ResultSource, VerificationStatus } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const INDEX_FILE = path.join(DATA_DIR, "email-index.json");

export interface IndexRecord {
  email: string;
  domain: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  sources: Array<{ url: string; kind: string; seenAt: string }>;
  patternId?: PatternId | null;
  confidence: number;
  status: VerificationStatus | "found";
  firstSeen: string;
  lastSeen: string;
  hitCount: number;
}

interface IndexFile {
  version: 1;
  updatedAt: string;
  records: IndexRecord[];
}

let cache: Map<string, IndexRecord> | null = null;
let loadPromise: Promise<void> | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

async function ensureLoaded(): Promise<void> {
  if (cache) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    cache = new Map();
    try {
      const raw = await fs.readFile(INDEX_FILE, "utf8");
      const parsed = JSON.parse(raw) as IndexFile;
      for (const r of parsed.records ?? []) {
        cache.set(emailKey(r.email), r);
      }
    } catch {
      cache = new Map();
    }
  })();
  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 400);
}

async function flush(): Promise<void> {
  if (!dirty || !cache) return;
  dirty = false;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const payload: IndexFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      records: Array.from(cache.values()).sort((a, b) =>
        a.domain.localeCompare(b.domain),
      ),
    };
    await fs.writeFile(INDEX_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    dirty = true;
  }
}

export async function upsertIndexRecord(
  partial: Omit<IndexRecord, "firstSeen" | "lastSeen" | "hitCount"> & {
    firstSeen?: string;
    lastSeen?: string;
    hitCount?: number;
  },
): Promise<IndexRecord> {
  await ensureLoaded();
  const key = emailKey(partial.email);
  const now = new Date().toISOString();
  const existing = cache!.get(key);
  if (existing) {
    const sourceUrls = new Set(existing.sources.map((s) => s.url));
    for (const s of partial.sources) {
      if (!sourceUrls.has(s.url)) {
        existing.sources.push(s);
        sourceUrls.add(s.url);
      }
    }
    existing.confidence = Math.max(existing.confidence, partial.confidence);
    if (partial.status === "valid" || existing.status === "found") {
      existing.status = partial.status;
    }
    existing.firstName = partial.firstName ?? existing.firstName;
    existing.lastName = partial.lastName ?? existing.lastName;
    existing.title = partial.title ?? existing.title;
    existing.patternId = partial.patternId ?? existing.patternId;
    existing.lastSeen = now;
    existing.hitCount += 1;
    scheduleFlush();
    return existing;
  }
  const rec: IndexRecord = {
    email: key,
    domain: partial.domain.toLowerCase(),
    firstName: partial.firstName,
    lastName: partial.lastName,
    title: partial.title,
    sources: partial.sources,
    patternId: partial.patternId,
    confidence: partial.confidence,
    status: partial.status,
    firstSeen: partial.firstSeen ?? now,
    lastSeen: partial.lastSeen ?? now,
    hitCount: partial.hitCount ?? 1,
  };
  cache!.set(key, rec);
  scheduleFlush();
  return rec;
}

export async function getEmailsForDomain(
  domain: string,
): Promise<IndexRecord[]> {
  await ensureLoaded();
  const d = domain.toLowerCase();
  return Array.from(cache!.values())
    .filter((r) => r.domain === d)
    .sort((a, b) => b.confidence - a.confidence);
}

export async function findPersonInIndex(
  first: string,
  last: string,
  domain: string,
): Promise<IndexRecord | null> {
  await ensureLoaded();
  const d = domain.toLowerCase();
  const f = first.toLowerCase();
  const l = last.toLowerCase();
  const records = Array.from(cache!.values()).filter((r) => r.domain === d);

  for (const r of records) {
    if (
      r.firstName?.toLowerCase() === f &&
      r.lastName?.toLowerCase() === l
    ) {
      return r;
    }
  }

  for (const r of records) {
    const local = r.email.split("@")[0] ?? "";
    if (
      f &&
      l &&
      (local.includes(`${f}.${l}`) ||
        local.includes(`${f}${l}`) ||
        local.includes(`${f}_${l}`) ||
        local.includes(`${f[0]}${l}`) ||
        local.includes(`${f}${l[0]}`))
    ) {
      return r;
    }
  }

  return null;
}

export async function indexStats(): Promise<{
  totalEmails: number;
  domains: number;
}> {
  await ensureLoaded();
  const domains = new Set(Array.from(cache!.values()).map((r) => r.domain));
  return { totalEmails: cache!.size, domains: domains.size };
}

export async function listIndexedDomains(): Promise<string[]> {
  await ensureLoaded();
  return [
    ...new Set(Array.from(cache!.values()).map((r) => r.domain)),
  ].sort();
}

export function indexSourceTags(): ResultSource[] {
  return ["public_index"];
}
