/**
 * Local LinkedIn slug index. Competitors do not hit LinkedIn 100k/day.
 * First resolve is paid/public; every later lookup is this file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FILE = "/workspace/data/li-profiles.json";

export type IndexedProfile = {
  fullName: string;
  title?: string;
  company?: string;
  domain?: string;
  location?: string;
  linkedinUrl: string;
  slug: string;
  experience?: Array<{ title?: string; company?: string; current?: boolean }>;
  at: number;
};

let mem: Record<string, IndexedProfile> | null = null;

function load(): Record<string, IndexedProfile> {
  try {
    mem = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, IndexedProfile>;
  } catch {
    mem = mem ?? {};
  }
  return mem!;
}

function titleCaseName(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

export function getIndexedProfile(slug: string): IndexedProfile | null {
  const row = load()[slug.toLowerCase()];
  if (!row?.fullName) return null;
  return { ...row, fullName: titleCaseName(row.fullName) };
}

export function putIndexedProfile(p: Omit<IndexedProfile, "at">): void {
  const db = load();
  db[p.slug.toLowerCase()] = {
    ...p,
    fullName: titleCaseName(p.fullName),
    at: Date.now(),
  };
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(db));
  } catch {
    /* */
  }
}
