/**
 * Decodo Fast Search — live Google organic. Auth from env / .env.
 */

import { readFileSync } from "node:fs";
import { employerInTitle, isPersonSlug, otherEmployerInTitle } from "./identity-lock";

export { companyOnCard, isPersonSlug } from "./identity-lock";

const ENDPOINT = "https://fastsearch.decodo.com/v0/search";

function auth(): string {
  if (process.env.DECODO_BASIC_AUTH) return process.env.DECODO_BASIC_AUTH;
  try {
    const env = readFileSync("/workspace/.env", "utf8");
    const m = env.match(/^DECODO_BASIC_AUTH=(.*)$/m);
    return m?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

export type DecodoHit = {
  name: string;
  title?: string;
  slug: string;
  url: string;
  location?: string;
  company?: string;
  domain?: string;
  linkedinUrl?: string;
};

type Organic = {
  link?: string;
  title?: string;
  description?: string;
};

export async function decodoSearch(query: string, page = 1): Promise<Organic[]> {
  const AUTH = auth();
  if (!AUTH || !query.trim()) return [];
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(12_000),
      headers: {
        Accept: "application/json",
        Authorization: AUTH,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, page }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { organic?: Organic[] };
    return Array.isArray(data.organic) ? data.organic : [];
  } catch {
    return [];
  }
}

export async function decodoShards(queries: string[]): Promise<Organic[][]> {
  return Promise.all(queries.map((q) => decodoSearch(q)));
}

export function isPlausibleName(name: string): boolean {
  const bits = name
    .replace(/[^\p{L}\s.'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (bits.length < 2 || bits.length > 5) return false;
  if (bits.some((b) => b.length < 2)) return false;
  if (bits.some((b) => /^(the|and|for|with|from|linkedin|profile|view)$/i.test(b))) return false;
  return bits.every((b) => /^[\p{L}][\p{L}.'-]*$/u.test(b));
}


function parseHead(row: Organic): DecodoHit | null {
  const url = (row.link ?? "").split("?")[0] ?? "";
  const slugM = url.match(/linkedin\.com\/in\/([a-zA-Z0-9_%\-]+)/i);
  if (!slugM) return null;
  const slug = decodeURIComponent(slugM[1]!);
  if (!isPersonSlug(slug)) return null;
  const head = (row.title ?? "")
    .replace(/\s*\|\s*LinkedIn.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const bits = head.split(/\s*[-–|]\s*/);
  const name = (bits[0] ?? "").trim();
  if (!isPlausibleName(name)) return null;
  const title = bits.slice(1).join(" - ").replace(/\s+at\s*$/i, "").trim();
  return { name, title: title || undefined, slug, url, linkedinUrl: `https://www.linkedin.com/in/${slug}/` };
}

export function peopleFromOrganic(rows: Organic[], companyName: string, domain?: string): DecodoHit[] {
  const out: DecodoHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const parsed = parseHead(row);
    if (!parsed || seen.has(parsed.slug)) continue;
    const blob = `${row.title ?? ""} ${row.description ?? ""}`;
    if (companyName.length >= 3 && !employerInTitle(row.title ?? "", companyName, domain)) continue;
    if (otherEmployerInTitle(row.title ?? "", companyName, domain)) continue;
    if (/\b(former|ex-|previously|alumni)\b/i.test(blob)) continue;
    seen.add(parsed.slug);
    out.push(parsed);
  }
  return out;
}

export function isDistinctiveCompany(name: string): boolean {
  const n = name.replace(/\s+/g, " ").trim();
  const words = n.split(" ").filter(Boolean);
  if (n.length < 8) return false;
  if (words.length >= 2 && n.length >= 10) return true;
  return n.length >= 16;
}

const XRAY_TITLES = [
  "Director",
  "Manager",
  "Vice President",
  "Engineer",
  "Sales",
  "Operations",
  "Analyst",
  "President",
  "Coordinator",
  "Consultant",
  "Founder",
  "Architect",
];

export async function xrayPeopleAtCompanies(
  companies: Array<{ name: string }>,
  geo?: string,
): Promise<DecodoHit[]> {
  const queries: string[] = [];
  const pinned = companies.length === 1;
  for (const c of companies) {
    const name = c.name.replace(/"/g, "").trim();
    if (!pinned && !isDistinctiveCompany(name)) continue;
    if (name.length < 2) continue;
    queries.push(`site:linkedin.com/in "at ${name}"`);
    for (const t of XRAY_TITLES.slice(0, 4)) {
      queries.push(`site:linkedin.com/in "at ${name}" ${t}${geo ? ` "${geo}"` : ""}`);
    }
  }
  const pages = await decodoShards(queries.slice(0, 16));
  const out: DecodoHit[] = [];
  const seen = new Set<string>();
  for (const rows of pages) {
    for (const row of rows) {
      const parsed = parseHead(row);
      if (!parsed || seen.has(parsed.slug)) continue;
      seen.add(parsed.slug);
      out.push(parsed);
    }
  }
  return out;
}

export async function liveLinkedInByFilters(opts: {
  keywords?: string;
  title?: string;
  geo?: string;
  industry?: string;
}): Promise<DecodoHit[]> {
  const parts = [
    opts.title ? `"${opts.title}"` : "",
    opts.keywords ? `"${opts.keywords}"` : "",
    opts.geo ? `"${opts.geo}"` : "",
    opts.industry ? `"${opts.industry}"` : "",
  ].filter(Boolean);
  if (!parts.length) return [];
  const q = `site:linkedin.com/in ${parts.join(" ")}`;
  const rows = (await Promise.all([decodoSearch(q, 1), decodoSearch(q, 2)])).flat();
  const out: DecodoHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const parsed = parseHead(row);
    if (!parsed || seen.has(parsed.slug)) continue;
    seen.add(parsed.slug);
    out.push(parsed);
  }
  return out;
}
