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

import { listSeededDomains } from "./knowledge-base";
import { listIndexedDomains } from "./index-store";
import { searchLinkedInCompanies } from "./linkedin-company";

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

const LOCAL_ALIASES: Array<{ aliases: string[]; name: string; domain: string }> =
  [
    { aliases: ["warewe", "ware we"], name: "Warewe", domain: "warewe.com" },
    { aliases: ["stripe"], name: "Stripe", domain: "stripe.com" },
    { aliases: ["ghd"], name: "GHD", domain: "ghd.com" },
    { aliases: ["aidacare", "aida care"], name: "Aidacare", domain: "aidacare.com.au" },
  ];

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
];
const PROVE_TLDS = [".com", ".in", ".ai", ".io", ".co", ".com.au"];
const LEGAL_NOISE =
  /^(pvt|ltd|llc|inc|llp|plc|gmbh|sa|sas|bv|pty|co|corp|corporation|company|private|limited|the|and|of|careers?|login|stock|share|price|reviews?|owner|revenue|products?|founder|download|official|website|india|bangalore|mysore|manesar)$/i;
const SALE_RE =
  /for sale|buy this domain|this domain is parked|hugedomains|sedo\.com|afternic|domain is for sale|parked free/i;

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

interface Probe {
  domain: string;
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
    if (!res.ok) return false;
    const j = (await res.json()) as { Status?: number; Answer?: unknown[] };
    return j.Status === 0 && Array.isArray(j.Answer) && j.Answer.length > 0;
  } catch {
    return false;
  }
}

async function httpProbe(domain: string): Promise<Probe> {
  const fail: Probe = {
    domain,
    ok: false,
    parked: false,
    confirmed: false,
    title: null,
  };
  const dns = await dohLive(domain);
  if (!dns) return fail;
  try {
    const res = await fetch(`https://${domain}/`, {
      signal: AbortSignal.timeout(2500),
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
      return { ...fail, parked: true };
    }
    if (res.status === 444) return fail;
    let title: string | null = null;
    if (res.status < 400) {
      const html = (await res.text()).slice(0, 40_000);
      if (SALE_RE.test(html)) return { ...fail, parked: true };
      const raw = html.match(/<title[^>]*>([^<]+)/i)?.[1] ?? "";
      title =
        raw
          .replace(/&/g, "&")
          .replace(/&[a-z]+;/g, " ")
          .split(/[|\-–—]/)[0]
          ?.replace(/\s+/g, " ")
          .trim()
          .slice(0, 48) || null;
      if (title && SALE_RE.test(title)) return { ...fail, parked: true };
    }
    return { domain, ok: true, parked: false, confirmed: true, title };
  } catch {
    return { domain, ok: true, parked: false, confirmed: false, title: null };
  }
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
  // Short tokens are usually people in query logs. Force a company pass.
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
  if (domain.endsWith(".com") && !domain.endsWith(".com.au")) s += 4;
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

  for (const a of LOCAL_ALIASES) {
    if (a.aliases.some((x) => compact(q).startsWith(x) || x.startsWith(compact(q)))) {
      add({ name: a.name, domain: a.domain, confidence: 96, source: "seed" });
    }
  }

  return [...bag.values()]
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
  return slug(name)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !LEGAL_NOISE.test(t) && t !== "trust");
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
  const close = nameCloseness(apiName, company);

  let s = close;
  if (close >= 70) {
    if (brand === compact(company)) s += 24;
    if (host.endsWith(".com") && !host.endsWith(".com.au")) s += 12;
    if (host.endsWith(".net") || host.endsWith(".org")) s -= 6;
    if (brand.length <= 4 && /^[a-z0-9]+$/.test(brand) && host.endsWith(".com")) s += 22;
    if (tokens[0] && brand === tokens[0]) s += 8;
    return s;
  }

  if (tokens[0] && (brand === tokens[0] || brand.startsWith(tokens[0]) || tokens[0].startsWith(brand))) s += 35;
  if (tokens.length >= 2 && brand === tokens.slice(0, 2).join("")) s += 40;
  if (tokens.some((t) => t.length >= 4 && brand.includes(t))) s += 15;
  if (brand.length >= 4 && compact(company).includes(brand)) s += 20;
  if (s < 35) return -1;
  if (host.endsWith(".com") && !host.endsWith(".com.au")) s += 4;
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

export async function resolveCompanyDomain(name: string): Promise<string | undefined> {
  const q = name.replace(/\s+/g, " ").trim();
  if (q.length < 3) return undefined;
  const key = q.toLowerCase();
  if (domainCache.has(key)) return domainCache.get(key) || undefined;

  const short = distinctiveTokens(q).slice(0, 2).join(" ");
  const queries = [...new Set([q, short].filter((s) => s.length >= 3))];
  const packs = await Promise.all([
    ...queries.flatMap((query) => [clearbitSuggest(query), brandfetchSearch(query)]),
    wikidataWebsite(q),
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
