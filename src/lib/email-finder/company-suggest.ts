/**
 * Company typeahead.
 *
 * 100-prefix bake-off (2026-08-18):
 *   Google/DDG/Bing query-log expansion  94%
 *   Clearbit on the raw prefix           91%  (misses hectorbev, 32dentalso)
 *   urlscan domain:prefix*               47%  (hits the long-tail misses)
 *   combined                             98%
 *
 * Hunter wins on prefixes because it prefix-matches a company graph.
 * We expand the typed token against search-query logs (same signal as
 * US6564213 query autocomplete), compact the expansion to a slug, then
 * prove the domain is live. Parked / "for sale" titles are dropped.
 */

import { searchLinkedInCompanies } from "./linkedin-company";
import { companyNameFitsDomain, coreNameTokens } from "./identity-lock";
import { promises as nodedns } from "node:dns";

export interface CompanySuggestion {
  name: string;
  domain: string;
  confidence: number;
  source:
    | "index"
    | "seed"
    | "brandfetch"
    | "clearbit"
    | "companies"
    | "expand"
    | "urlscan"
    | "linkedin"
    | "web";
  logoUrl?: string;
}

const COMPANY_TAILS = [
  "solutions",
  "solution",
  "beverages",
  "beverage",
  "consulting",
  "consultancy",
  "technologies",
  "technology",
  "systems",
  "services",
  "software",
  "labs",
  "lab",
  "group",
  "holdings",
  "capital",
  "ventures",
  "partners",
  "health",
  "healthcare",
  "dental",
  "clinic",
  "pharma",
  "foods",
  "food",
  "drinks",
  "water",
  "energy",
  "power",
  "motors",
  "logistics",
  "digital",
  "media",
  "studio",
  "works",
  "global",
  "india",
  "limited",
  "enterprises",
  "industries",
  "finance",
  "financial",
  "bank",
  "pay",
  "payments",
  "app",
  "apps",
  "tech",
  "ai",
  "hq",
];

function companyLikeCompletion(full: string, prefix: string): boolean {
  if (!full.startsWith(prefix) || full.length <= prefix.length) return false;
  const rest = full.slice(prefix.length);
  if (COMPANY_TAILS.includes(rest)) return true;
  return COMPANY_TAILS.some(
    (t) => t.length - rest.length >= 2 && t.endsWith(rest) && rest.length >= 3,
  );
}

const PARKED_HOSTS = [
  "google.com",
  "www.google.com",
  "sedo.com",
  "dan.com",
  "godaddy.com",
  "www.godaddy.com",
  "hugedomains.com",
  "afternic.com",
  "parkingcrew.net",
  "bodis.com",
  "spaceship.com",
];
const COMPOUND_TLDS = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "co.nz",
  "co.in",
  "co.za",
  "com.br",
  "com.mx",
  "co.jp",
  "com.tr",
  "co.kr",
]);
const PROVE_TLDS = [".com", ".net", ".io", ".ai", ".co", ".in", ".com.au"];
const LEGAL_NOISE =
  /^(pvt|ltd|llc|inc|llp|plc|gmbh|sa|sas|bv|pty|co|corp|corporation|company|private|limited|the|and|of|careers?|login|stock|share|price|reviews?|owner|revenue|products?|founder|download|official|website|india|bangalore|mysore|manesar)$/i;
const SALE_RE =
  /for sale|buy this domain|this domain is parked|hugedomains|sedo\.com|afternic|domain is for sale|parked free|spaceship\.com/i;

const expandCache = new Map<string, string[]>();

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function compact(s: string): string {
  return slug(s).replace(/\s/g, "");
}
function titleCaseBrand(s: string): string {
  return s
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
function looksLikeDomain(q: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(
    q.replace(/^https?:\/\//, "").split("/")[0] ?? "",
  );
}
function isApex(host: string): boolean {
  const parts = host.split(".");
  if (parts.length === 2) return true;
  if (parts.length === 3 && ["com", "co", "net", "org", "gov"].includes(parts[1]!)) {
    return true;
  }
  return false;
}

function registrableTld(host: string): string {
  const p = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (p.length >= 3) {
    const last2 = p.slice(-2).join(".");
    if (COMPOUND_TLDS.has(last2)) return last2;
  }
  return p.at(-1) ?? "";
}

/** Generic commercial TLDs beat country twins (zerobounce.net > zerobounce.co.uk). */
function tldBonus(host: string): number {
  const t = registrableTld(host);
  if (t === "com") return 12;
  if (t === "net" || t === "io" || t === "ai" || t === "co" || t === "app") return 10;
  if (t === "org") return 6;
  if (t.includes(".")) return 0;
  return 3;
}

interface Probe {
  domain: string;
  finalHost: string;
  ok: boolean;
  parked: boolean;
  confirmed: boolean;
  title: string | null;
}

async function dohLive(host: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`,
      { signal: AbortSignal.timeout(2200) },
    );
    if (res.ok) {
      const j = (await res.json()) as { Status?: number; Answer?: unknown[] };
      if (j.Status === 0 && Array.isArray(j.Answer) && j.Answer.length > 0) return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const addrs = await nodedns.resolve4(host);
    return addrs.length > 0;
  } catch {
    return false;
  }
}

async function httpProbe(domain: string, timeoutMs = 2500): Promise<Probe> {
  const fail: Probe = {
    domain,
    finalHost: domain,
    ok: false,
    parked: false,
    confirmed: false,
    title: null,
  };
  const dns = await dohLive(domain);
  if (!dns) return fail;
  try {
    const res = await fetch(`https://${domain}/`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0",
        Accept: "text/html",
      },
    });
    let finalHost = domain;
    try {
      finalHost = new URL(res.url).hostname.replace(/^www\./, "");
    } catch {
      /* keep */
    }
    if (PARKED_HOSTS.includes(finalHost)) {
      return { ...fail, parked: true, finalHost };
    }
    if (res.status === 444) return { ...fail, finalHost };
    let title: string | null = null;
    if (res.status < 400) {
      const html = (await res.text()).slice(0, 40_000);
      if (SALE_RE.test(html)) return { ...fail, parked: true, finalHost };
      const raw = html.match(/<title[^>]*>([^<]+)/i)?.[1] ?? "";
      title =
        raw
          .replace(/&/g, "&")
          .replace(/&[a-z]+;/g, " ")
          .split(/[|\-–—]/)[0]
          ?.replace(/\s+/g, " ")
          .trim()
          .slice(0, 48) || null;
      if (title && SALE_RE.test(title)) return { ...fail, parked: true, finalHost };
    }
    return {
      domain,
      finalHost,
      ok: true,
      parked: false,
      confirmed: res.status < 400,
      title,
    };
  } catch {
    return fail;
  }
}

async function hasMxFast(host: string): Promise<boolean> {
  try {
    const records = await Promise.race([
      nodedns.resolveMx(host),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("mx-timeout")), 900)),
    ]);
    return records.some((r) => r.exchange && r.exchange !== ".");
  } catch {
    return false;
  }
}

type LiveHint = { live: boolean; parked: boolean; mx: boolean; finalHost: string };

async function liveHints(domains: string[]): Promise<Map<string, LiveHint>> {
  const out = new Map<string, LiveHint>();
  await Promise.all(
    domains.map(async (d) => {
      const [probe, mx] = await Promise.all([httpProbe(d, 1600), hasMxFast(d)]);
      out.set(d, {
        live: probe.confirmed && !probe.parked,
        parked: probe.parked,
        mx,
        finalHost: probe.finalHost || d,
      });
    }),
  );
  return out;
}

function relatedBrand(domain: string, q: string): boolean {
  const brand = (domain.split(".")[0] ?? "").toLowerCase();
  const n = compact(q);
  if (!brand || n.length < 2) return false;
  if (brand === n || brand.startsWith(n) || n.startsWith(brand)) return true;
  let k = 0;
  while (k < brand.length && k < n.length && brand[k] === n[k]) k += 1;
  return k >= 6;
}

async function jsonGet(url: string, ms: number): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0",
    },
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

async function googleSuggest(q: string): Promise<string[]> {
  try {
    const j = (await jsonGet(
      `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`,
      2500,
    )) as unknown[];
    return Array.isArray(j[1]) ? (j[1] as string[]) : [];
  } catch {
    return [];
  }
}

async function ddgSuggest(q: string): Promise<string[]> {
  try {
    const j = (await jsonGet(
      `https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}`,
      2500,
    )) as Array<{ phrase?: string }>;
    return Array.isArray(j)
      ? j.map((r) => r.phrase ?? "").filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

async function bingSuggest(q: string): Promise<string[]> {
  try {
    const j = (await jsonGet(
      `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`,
      2500,
    )) as unknown[];
    return Array.isArray(j[1]) ? (j[1] as string[]) : [];
  } catch {
    return [];
  }
}

function slugsFromPhrases(q: string, phrases: string[]): string[] {
  const n = compact(q);
  const out = new Set<string>();
  if (n.length >= 2) out.add(n);
  for (const phrase of phrases) {
    const words = slug(phrase)
      .split(/\s+/)
      .filter((w) => w && !LEGAL_NOISE.test(w));
    let acc = "";
    for (const w of words) {
      acc += w;
      if (!acc.startsWith(n) || acc.length > 48) break;
      if (acc.length > n.length) {
        out.add(acc);
        break;
      }
      if (acc === n) out.add(acc);
    }
  }
  return [...out];
}

async function expandSlugs(q: string): Promise<string[]> {
  const key = compact(q);
  const hit = expandCache.get(key);
  if (hit) return hit;
  const [g, d, b] = await Promise.all([
    googleSuggest(q),
    ddgSuggest(q),
    bingSuggest(q),
  ]);
  let phrases = [...g, ...d, ...b];
  const n = compact(q);
  if (n.length <= 8) {
    const extra = await Promise.all([
      ddgSuggest(`${q} company`),
      googleSuggest(`${q} company`),
      bingSuggest(`${q} company`),
      ddgSuggest(`${q} pvt`),
    ]);
    phrases = [...phrases, ...extra.flat()];
  }
  const merged = slugsFromPhrases(q, phrases);
  expandCache.set(key, merged);
  if (expandCache.size > 200) {
    const first = expandCache.keys().next().value;
    if (first) expandCache.delete(first);
  }
  return merged;
}

async function urlscanPrefix(q: string): Promise<CompanySuggestion[]> {
  const n = compact(q);
  if (n.length < 5) return [];
  try {
    const j = (await jsonGet(
      `https://urlscan.io/api/v1/search/?q=domain:${encodeURIComponent(n)}*&size=10`,
      3500,
    )) as {
      results?: Array<{
        page?: { domain?: string; title?: string };
        task?: { domain?: string };
      }>;
    };
    const seen = new Set<string>();
    const out: CompanySuggestion[] = [];
    for (const r of j.results ?? []) {
      const raw = (r.page?.domain || r.task?.domain || "")
        .toLowerCase()
        .replace(/^www\./, "");
      const host = raw.split("/")[0] ?? "";
      if (!host.includes(".") || seen.has(host)) continue;
      const brand = host.split(".")[0] ?? "";
      if (!brand.startsWith(n)) continue;
      seen.add(host);
      out.push({
        name: r.page?.title?.split(/[|\-–—]/)[0]?.trim() || titleCaseBrand(brand),
        domain: host,
        confidence: 86,
        source: "urlscan",
      });
    }
    return out.slice(0, 6);
  } catch {
    return [];
  }
}

async function clearbitSuggest(q: string): Promise<CompanySuggestion[]> {
  try {
    const rows = (await jsonGet(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(q)}`,
      4500,
    )) as Array<{ name?: string; domain?: string; logo?: string }>;
    return (rows ?? []).slice(0, 8).flatMap((r) =>
      r.domain
        ? [
            {
              name: r.name || titleCaseBrand(r.domain.split(".")[0]!),
              domain: r.domain.toLowerCase(),
              confidence: 80,
              source: "clearbit" as const,
              logoUrl: r.logo || undefined,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

async function brandfetchSearch(q: string): Promise<CompanySuggestion[]> {
  try {
    const rows = (await jsonGet(
      `https://api.brandfetch.io/v2/search/${encodeURIComponent(q)}`,
      4000,
    )) as Array<{ name?: string | null; domain?: string; icon?: string }>;
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, 8).flatMap((r) =>
      r.domain
        ? [
            {
              name:
                (r.name && r.name.trim()) ||
                titleCaseBrand(r.domain.split(".")[0]!),
              domain: r.domain.toLowerCase().replace(/^www\./, ""),
              confidence: 70,
              source: "brandfetch" as const,
              logoUrl: r.icon,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

async function companiesSearch(q: string): Promise<CompanySuggestion[]> {
  try {
    const json = (await jsonGet(
      `https://api.thecompaniesapi.com/v2/companies?search=${encodeURIComponent(q)}&size=8`,
      5000,
    )) as {
      companies?: Array<{
        about?: { name?: string };
        domain?: { domain?: string };
      }>;
    };
    return (json.companies ?? []).flatMap((c) => {
      const domain = c.domain?.domain?.toLowerCase();
      if (!domain) return [];
      return [
        {
          name: c.about?.name || titleCaseBrand(domain.split(".")[0]!),
          domain,
          confidence: 78,
          source: "companies" as const,
        },
      ];
    });
  } catch {
    return [];
  }
}

function scoreFor(
  domain: string,
  q: string,
  source: CompanySuggestion["source"],
  completed: Set<string>,
): number {
  const brand = (domain.split(".")[0] ?? "").toLowerCase();
  const n = compact(q);
  let s = 40;
  if (source === "linkedin" || source === "expand" || source === "urlscan") s += 16;
  if (source === "seed" || source === "clearbit" || source === "index") s += 12;
  if (source === "companies" || source === "brandfetch") s += 6;
  if (brand === n) s += 34;
  else if (completed.has(brand) && brand.length > n.length) s += 28;
  else if (brand.startsWith(n) && brand.length > n.length) s += 18;
  else s -= 16;
  s += tldBonus(domain);
  if (domain.endsWith(".in") && brand.length > n.length) s += 3;
  return Math.max(48, Math.min(98, s));
}

export async function suggestCompanies(
  raw: string,
  limit = 8,
): Promise<CompanySuggestion[]> {
  const q = raw.trim();
  if (q.length < 2) return [];

  if (looksLikeDomain(q)) {
    const d = q
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]!
      .toLowerCase();
    return [
      {
        name: titleCaseBrand(d.split(".")[0]!),
        domain: d,
        confidence: 99,
        source: "web",
      },
    ];
  }

  const queries = [
    ...new Set(
      [q, distinctiveTokens(q).slice(0, 2).join(" ")].filter((s) => s.length >= 2),
    ),
  ];
  const packs = await Promise.all(
    queries.flatMap((query) => [clearbitSuggest(query), brandfetchSearch(query)]),
  );

  const bag = new Map<string, { hit: CompanySuggestion; score: number }>();
  const add = (hit: CompanySuggestion) => {
    const d = hit.domain.toLowerCase().replace(/^www\./, "");
    const score = domainScore(d, hit.name, q);
    if (score < 0) return;
    const prev = bag.get(d);
    if (!prev || score > prev.score) {
      bag.set(d, {
        hit: {
          ...hit,
          domain: d,
          confidence: Math.min(99, 50 + score),
        },
        score,
      });
    }
  };
  for (const h of packs.flat()) add(h);

  const ranked = [...bag.values()].sort(
    (a, b) => b.score - a.score || b.hit.confidence - a.hit.confidence,
  );
  const top = ranked.slice(0, Math.max(limit, 8));
  if (!top.length) return [];

  let hints = new Map<string, LiveHint>();
  try {
    hints = await liveHints(top.map((x) => x.hit.domain));
  } catch {
    hints = new Map();
  }

  const liveStems = new Set(
    [...hints.entries()]
      .filter(([, h]) => h.live)
      .map(([d]) => (d.split(".")[0] ?? "").replace(/-/g, "")),
  );
  const anyLive = liveStems.size > 0;
  const out: Array<{ hit: CompanySuggestion; score: number }> = [];
  const seen = new Set<string>();

  for (const row of ranked) {
    const h = hints.get(row.hit.domain);
    if (h?.parked) continue;
    const stem = (row.hit.domain.split(".")[0] ?? "").replace(/-/g, "");
    if (anyLive && h && !h.live && liveStems.has(stem)) continue;
    const canon =
      h?.finalHost && relatedBrand(h.finalHost, q) ? h.finalHost.replace(/^www\./, "") : row.hit.domain;
    if (seen.has(canon)) continue;
    seen.add(canon);
    let score = row.score;
    if (h?.live) score += 30;
    if (h?.mx) score += 20;
    const confidence = h?.live ? (h.mx ? 97 : 90) : Math.min(row.hit.confidence, 70);
    out.push({
      hit: { ...row.hit, domain: canon, confidence },
      score,
    });
  }

  const usable = out.length ? out : ranked;
  return usable
    .sort((a, b) => b.score - a.score || b.hit.confidence - a.hit.confidence)
    .map((x) => x.hit)
    .slice(0, limit);
}

const JUNK_HOST = new Set([
  "bit.ly",
  "t.co",
  "ow.ly",
  "goo.gl",
  "tinyurl.com",
  "lnkd.in",
  "linktr.ee",
  "fb.me",
  "buff.ly",
  "rebrand.ly",
  "cutt.ly",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "linkedin.com",
  "licdn.com",
  "google.com",
  "apple.com",
  "microsoft.com",
  "amazon.com",
  "wikipedia.org",
  "schema.org",
  "bing.com",
  "wordpress.com",
  "wix.com",
  "squarespace.com",
  "github.com",
  "medium.com",
  "linktr.ee",
]);

function distinctiveTokens(name: string): string[] {
  return coreNameTokens(name);
}

function nameCloseness(apiName: string | undefined, company: string): number {
  if (!apiName) return 0;
  const a = compact(apiName);
  const b = compact(company);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.startsWith(b) || b.startsWith(a)) return 85;
  if (a.includes(b) || b.includes(a)) return 70;
  const ta = new Set(distinctiveTokens(apiName));
  const tb = new Set(distinctiveTokens(company));
  const inter = [...ta].filter((t) => tb.has(t));
  if (inter.length >= 2) return 80;
  if (inter.length === 1 && (inter[0]?.length ?? 0) >= 5) return 45;
  return 0;
}

function domainScore(domain: string, apiName: string | undefined, company: string): number {
  const host = domain.toLowerCase().replace(/^www\./, "");
  if (JUNK_HOST.has(host) || host.split(".").length < 2) return -1;
  if (host.length > 48) return -1;
  const brand = (host.split(".")[0] ?? "").replace(/-/g, "");
  if (!brand || brand.length < 2) return -1;
  const tokens = distinctiveTokens(company);
  const longest = [...tokens].sort((a, b) => b.length - a.length)[0];
  const fits = companyNameFitsDomain(company, host);
  const close = nameCloseness(apiName, company);
  if (!fits && close < 90) return -1;
  if (!fits && close >= 90 && longest && longest.length >= 5 && !brand.includes(longest) && brand.length >= 8) {
    return -1;
  }

  let s = close;
  if (close >= 70) {
    if (brand === compact(company)) s += 24;
    s += tldBonus(host);
    if (brand.length <= 4 && /^[a-z0-9]+$/.test(brand) && registrableTld(host) === "com") s += 22;
    if (tokens[0] && brand === tokens[0]) s += 8;
    return s;
  }

  if (tokens[0] && (brand === tokens[0] || brand.startsWith(tokens[0]) || tokens[0].startsWith(brand))) s += 35;
  if (tokens.length >= 2 && brand === tokens.slice(0, 2).join("")) s += 40;
  if (tokens.some((t) => t.length >= 4 && brand.includes(t))) s += 15;
  if (brand.length >= 4 && compact(company).includes(brand)) s += 20;
  if (s < 35) return -1;
  s += Math.min(4, tldBonus(host));
  return s;
}

async function wikidataWebsite(name: string): Promise<CompanySuggestion[]> {
  try {
    const sparql = `SELECT ?website ?itemLabel WHERE {
      ?item rdfs:label ${JSON.stringify(name)}@en.
      ?item wdt:P856 ?website.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } LIMIT 3`;
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: {
        Accept: "application/sparql-results+json",
        "User-Agent": "Mailgraph/1.0",
      },
    });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      results?: { bindings?: Array<{ website?: { value?: string }; itemLabel?: { value?: string } }> };
    };
    return (j.results?.bindings ?? []).flatMap((b) => {
      const raw = b.website?.value ?? "";
      const host = raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]?.toLowerCase();
      if (!host || !host.includes(".")) return [];
      return [
        {
          name: b.itemLabel?.value || name,
          domain: host,
          confidence: 92,
          source: "clearbit" as const,
        },
      ];
    });
  } catch {
    return [];
  }
}

let secTickers: Map<string, string> | null = null;
async function secTicker(name: string): Promise<string | undefined> {
  try {
    if (!secTickers) {
      const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mailgraph/1.0 contact@warewe.com", Accept: "application/json" },
      });
      if (!res.ok) return undefined;
      const j = (await res.json()) as Record<string, { ticker?: string; title?: string }>;
      secTickers = new Map();
      for (const row of Object.values(j)) {
        if (row.ticker && row.title) secTickers.set(compact(row.title), row.ticker.toLowerCase());
      }
    }
    return secTickers.get(compact(name));
  } catch {
    return undefined;
  }
}

const domainCache = new Map<string, string | null>();
const DOMAIN_CACHE_VER = 5;

export function domainFitsCompany(domain: string, company: string): boolean {
  return companyNameFitsDomain(company, domain);
}

export type RelatedCompanyDomain = {
  name: string;
  domain: string;
  hasMx: boolean;
  relation: "brand" | "previous";
};

const relatedCache = new Map<string, RelatedCompanyDomain[]>();
const GENERIC_BRAND_TOKEN =
  /^(hair|skin|care|serum|shampoo|product|science|backed|personal|clean|official|privacy|terms|shipping|india|best|seller|launch|collection|shop|store|about|contact|support|login|cart|checkout|home|new|our|the|and|for|with|from|powered|skincare|haircare|suncare)$/i;

async function peekSite(domain: string): Promise<string> {
  try {
    const res = await fetch(`https://${domain}/`, {
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0",
        Accept: "text/html",
      },
    });
    const reader = res.body?.getReader();
    if (!reader) return (await res.text()).slice(0, 250_000);
    const dec = new TextDecoder();
    let out = "";
    while (out.length < 250_000) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    try {
      await reader.cancel();
    } catch {
      /* */
    }
    return out;
  } catch {
    return "";
  }
}

function brandPhrases(html: string, description: string, selfName: string): Array<{ name: string; previous: boolean }> {
  const blob = `${html}\n${description}`;
  const stripped = blob
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ");
  const hay = `${blob}\n${stripped}`;
  const counts = new Map<string, { n: number; display: string }>();
  const bump = (display: string, weight = 1) => {
    const k = display.toLowerCase().replace(/\s+/g, " ").trim();
    if (k.length < 4 || k.length > 48) return;
    if (/[{}<>/=]/.test(k)) return;
    const cur = counts.get(k);
    if (cur) cur.n += weight;
    else counts.set(k, { n: weight, display: display.replace(/\s+/g, " ").trim() });
  };
  const fromList =
    /(?:from|brands?(?:\s+include)?|including|portfolio)\s+([A-Z][A-Za-z0-9&,' -]{8,180}?)(?:\.|"|'|<|\n)/g;
  for (const m of hay.matchAll(fromList)) {
    for (const part of m[1]!.split(/\s*(?:,|&|&| and )\s*/)) {
      const name = part.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (name.split(/\s+/).length >= 1 && name.split(/\s+/).length <= 4) bump(name, 12);
    }
  }
  const multi =
    /\b([A-Z][a-z]{2,}(?:\s+(?:[Aa]t|[Bb]y|[Aa]nd|&)\s+[A-Z][a-z]{2,})?(?:\s+[A-Z][a-z]{2,}){1,2})\b/g;
  for (const m of hay.matchAll(multi)) bump(m[1]!);
  const camel = /\b([A-Z][a-z]{2,}[A-Z][a-z]{2,})\b/g;
  for (const m of hay.matchAll(camel)) bump(m[1]!);
  for (const m of blob.matchAll(/content=["']([^"']{8,200})["']/gi)) {
    for (const p of m[1]!.matchAll(multi)) bump(p[1]!, 3);
    for (const p of m[1]!.split(/\s*(?:,|&|&| and )\s*/)) {
      const name = p.replace(/from\s+/i, "").trim();
      if (/^[A-Z]/.test(name) && name.split(/\s+/).length <= 4) bump(name, 4);
    }
  }
  for (const m of blob.toLowerCase().matchAll(/\/(?:products|collections|brands?|pages)\/([a-z0-9]+(?:-[a-z0-9]+){1,3})/g)) {
    const words = m[1]!
      .split("-")
      .filter((w) => w.length >= 3 && !GENERIC_BRAND_TOKEN.test(w) && !/^\d+$/.test(w));
    if (words.length >= 2) bump(titleCaseBrand(words.slice(0, 3).join(" ")));
  }
  const former: string[] = [];
  const formerRe =
    /formerly(?:\s+known\s+as)?\s+([A-Z][A-Za-z0-9&.' -]{2,42})|previous(?:ly)?(?:\s+domain)?\s+([a-z0-9.-]+\.[a-z]{2,})/gi;
  for (const m of hay.matchAll(formerRe)) {
    const name = (m[1] ?? "").replace(/[.,;].*$/, "").trim();
    if (name) {
      bump(name, 8);
      former.push(name.toLowerCase());
    }
  }
  const UI =
    /^(our|your|the|this|all|new|best|free|shop|buy|add|track|follow|contact|about|privacy|terms|cookie|fraud|calls?|website|site|page|home|help|faq|blog|news|press|team|join|login|seller|launch|reviews?|controls?|reduces?|fades?|treats?|nourishes?|exfoliates?|odour|causing|germs|white|cast|underarm|rice|water|coconut|milk|protein|hyaluronic|acid|vivo|tested|bag|advanced|ultra|smoothing|shampoo|with|salicylic|dead|skin|dark|spots|dandruff|reduction|hair|fall|excess|oil|frizz|pigmentation|sold|out|load|more|view|search|results?|shelf|heading|type|include|recommend(?:ed)?|popular|choices?|suggestions?|found|clear|first|product|gentle|exfoliating|face|growth|lip|balm|body|wash|roll|tea|tree|open|sans|serif|regexp|opensans|daily|use|every|night|routine|formula|natural|organic)$/i;
  const self = compact(selfName);
  const scored: Array<{ name: string; previous: boolean; n: number }> = [];
  for (const { n, display } of counts.values()) {
    if (n < 6) continue;
    const tokens = display.split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens.every((t) => UI.test(t) || GENERIC_BRAND_TOKEN.test(t) || t.length <= 2)) continue;
    if (!tokens.some((t) => t.length >= 4 && !UI.test(t) && !GENERIC_BRAND_TOKEN.test(t))) continue;
    if (/^(our|your|the|this|best|new|reviews?|search|view|sold|load|more|clear|first|include|popular|recommended)\s/i.test(display))
      continue;
    const c = compact(display);
    if (!c || c === self || c.includes(self) || self.includes(c)) continue;
    if (c.length < 6) continue;
    scored.push({
      name: display,
      previous: former.some((f) => compact(f) === c || display.toLowerCase() === f),
      n,
    });
  }
  scored.sort((a, b) => b.n - a.n);
  return scored.slice(0, 8).map(({ name, previous }) => ({ name, previous }));
}

export async function relatedCompanyDomains(opts: {
  name: string;
  domain: string;
  html?: string;
  description?: string;
}): Promise<RelatedCompanyDomain[]> {
  const domain = opts.domain.toLowerCase().replace(/^www\./, "");
  const key = `v4:${domain}:${opts.name.toLowerCase()}`;
  const hit = relatedCache.get(key);
  if (hit) return hit;

  const htmlRaw = opts.html ?? "";
  const htmlBroken =
    htmlRaw.length < 800 ||
    /something went wrong|just a moment|access denied|error code/i.test(htmlRaw.slice(0, 800));
  const html = !htmlBroken ? htmlRaw : (await peekSite(domain)) || htmlRaw;
  const description = opts.description ?? "";
  const phrases = brandPhrases(html, description, opts.name);
  const { lookupMx } = await import("./dns");
  const out: RelatedCompanyDomain[] = [];
  const seen = new Set<string>([domain]);

  await Promise.all(
    phrases.slice(0, 8).map(async (p) => {
      const slugName = compact(p.name);
      const hosts = [...new Set([`${slugName}.com`, `${slugName}.in`, `${slugName}.co`])];
      for (const host of hosts) {
        if (seen.has(host)) continue;
        if (JUNK_HOST.has(host)) continue;
        if (/^(youtube|facebook|instagram|twitter|linkedin|google|microsoft|apple|amazon|tiktok|whatsapp|github|wikipedia)$/i.test(slugName))
          continue;
        if (
          !p.previous &&
          nameCloseness(p.name, opts.name) < 50 &&
          !companyNameFitsDomain(opts.name, host)
        )
          continue;
        const dns = await dohLive(host);
        if (!dns) continue;
        let hasMx = false;
        try {
          hasMx = (await lookupMx(host)).hasMx;
        } catch {
          hasMx = false;
        }
        seen.add(host);
        out.push({
          name: p.name,
          domain: host,
          hasMx,
          relation: p.previous ? "previous" : "brand",
        });
        return;
      }
    }),
  );

  const ranked = out
    .filter((r) => r.hasMx)
    .sort((a, b) => Number(b.hasMx) - Number(a.hasMx) || a.name.localeCompare(b.name));
  relatedCache.set(key, ranked);
  if (relatedCache.size > 80) {
    const first = relatedCache.keys().next().value;
    if (first) relatedCache.delete(first);
  }
  return ranked;
}

export async function resolveCompanyDomain(name: string): Promise<string | undefined> {
  const q = name.replace(/\s+/g, " ").trim();
  if (q.length < 3) return undefined;
  const key = `${DOMAIN_CACHE_VER}:${q.toLowerCase()}`;
  if (domainCache.has(key)) return domainCache.get(key) || undefined;

  const slugHost = compact(q);
  const concatHosts = PROVE_TLDS.map((tld) => `${slugHost}${tld}`);

  if (slugHost.length >= 5) {
    for (const host of concatHosts.slice(0, 2)) {
      const probe = await httpProbe(host);
      if (probe.parked || !probe.confirmed) continue;
      const chosen =
        probe.finalHost && relatedBrand(probe.finalHost, q) ? probe.finalHost : host;
      const title = (probe.title ?? "").toLowerCase();
      const tokens = distinctiveTokens(q);
      const titleClose = probe.title ? nameCloseness(probe.title, q) : 0;
      const titleHasToken = tokens.some((t) => title.includes(t));
      if (titleClose >= 50 || titleHasToken || tokens.every((t) => chosen.includes(t))) {
        domainCache.set(key, chosen);
        return chosen;
      }
    }
  }

  const short = distinctiveTokens(q).slice(0, 2).join(" ");
  const queries = [...new Set([q, short].filter((s) => s.length >= 3))];
  const packs = await Promise.all([
    ...queries.flatMap((query) => [clearbitSuggest(query), brandfetchSearch(query)]),
    wikidataWebsite(q),
    searchLinkedInCompanies(q).then((rows) =>
      rows
        .filter((r) => nameCloseness(r.name, q) >= 80)
        .map((r) => ({
          name: r.name,
          domain: compact(r.name) + ".com",
          confidence: 90,
          source: "linkedin" as const,
        })),
    ),
    Promise.all(
      concatHosts.map(async (host) =>
        (await dohLive(host))
          ? [{ name: q, domain: host, confidence: 88, source: "web" as const }]
          : [],
      ),
    ).then((rows) => rows.flat()),
  ]);
  const ticker = await secTicker(q);
  let best: { domain: string; score: number } | null = null;
  for (const hit of packs.flat()) {
    let score = domainScore(hit.domain, hit.name, q);
    const brand = hit.domain.toLowerCase().replace(/^www\./, "").split(".")[0] ?? "";
    if (ticker && brand === ticker) score += 28;
    if (score < 0) continue;
    const d = hit.domain.toLowerCase().replace(/^www\./, "");
    if (!best || score > best.score) best = { domain: d, score };
  }
  const domain = best && best.score >= 35 ? best.domain : null;
  domainCache.set(key, domain);
  return domain ?? undefined;
}
