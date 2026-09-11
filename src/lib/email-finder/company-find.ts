/**
 * Live company enrichment — Hunter /v2/companies/find shape plus
 * jobs, similar, MX, evidence-backed tech, JSON-LD, Wikidata.
 * No Hunter/Apollo/Clay reseller calls.
 */

import { createHash } from "node:crypto";
import { resilientFetch } from "./http";
import { lookupMx } from "./dns";
import { detectTechStack, type TechHit } from "./tech-stack";
import { extractPhones } from "./phone-extract";
import { enrichCompanyProfile } from "./company-profile";
import {
  affiliatesFromSocial,
  archiveHeadcount,
  inferredRevenueRange,
  naicsFor,
  sicFor,
  wikiHierarchy,
  type PdlAffiliate,
  type NaicsRow,
  type SicRow,
} from "./pdl-premium";
import { employeeCountByCountryLive } from "./employee-geo";

export type CompanyFindData = {
  id: string;
  name: string;
  displayName: string;
  legalName: string | null;
  domain: string;
  website: string;
  site: { phoneNumbers: string[]; emailAddresses: string[] };
  category: {
    sector: string | null;
    industryGroup: string | null;
    industry: string | null;
    subIndustry: string | null;
    gicsCode: string | null;
    sicCode: string | null;
    sic4Codes: string[];
    naicsCode: string | null;
    naics6Codes: string[];
    naics6Codes2022: string[];
  };
  industry: string | null;
  industryV2: string | null;
  tags: string[];
  headline: string | null;
  description: string | null;
  foundedYear: number | null;
  location: string | null;
  timeZone: string | null;
  utcOffset: number | null;
  continent: string | null;
  geo: {
    streetNumber: string | null;
    streetName: string | null;
    subPremise: string | null;
    streetAddress: string | null;
    city: string | null;
    postalCode: string | null;
    state: string | null;
    stateCode: string | null;
    country: string | null;
    countryCode: string | null;
    lat: number | null;
    lng: number | null;
    metro: string | null;
    geo: string | null;
  };
  logo: string | null;
  facebook: { handle: string | null; url: string | null };
  linkedin: {
    handle: string | null;
    url: string | null;
    id: string | null;
    slug: string | null;
  };
  twitter: { handle: string | null; url: string | null };
  crunchbase: { handle: string | null; url: string | null };
  youtube: { handle: string | null; url: string | null };
  instagram: { handle: string | null; url: string | null };
  github: { handle: string | null; url: string | null };
  profiles: string[];
  alternativeNames: string[];
  alternativeDomains: string[];
  emailProvider: string | null;
  type: string | null;
  companyType: string | null;
  ticker: string | null;
  identifiers: { usEIN: string | null; cin: string | null };
  phone: string | null;
  metrics: {
    employees: string | null;
    employeesExact: number | null;
    employeeCountByCountry: Record<string, number> | null;
    followers: number | null;
    marketCap: string | null;
    raised: string | null;
    estimatedAnnualRevenue: string | null;
    fundingStage: string | null;
    latestFunding: string | null;
  };
  likelihood: number;
  indexedAt: string;
  technologies: Array<{
    name: string;
    category: string;
    evidence?: string;
    confidence?: number;
  }>;
  fundingRounds: Array<{
    date?: string;
    amount?: string;
    stage?: string;
  }>;
  parent: { domain: string | null; name: string | null };
  jobs: Array<{ title: string; location: string; department: string }>;
  similarCompanies: Array<{
    name: string;
    domain?: string;
    reason?: string;
    description?: string;
    industry?: string;
    size?: string;
    type?: string;
    location?: string;
    country?: string;
    linkedinUrl?: string;
  }>;
  offices: Array<{
    streetAddress: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
    countryCode: string | null;
    isPrimary: boolean;
  }>;
  social: Array<{ network: string; url: string; handle?: string }>;
  mx: {
    provider: string | null;
    hosts: string[];
    hasSpf: boolean;
    hasDmarc: boolean;
    hasMx: boolean;
  };
  sources: string[];
  affiliatedProfiles: PdlAffiliate[];
  subsidiaries: PdlAffiliate[];
  naics: NaicsRow[];
  sic: SicRow[];
  employeeCountByMonth: Array<{ month: string; count: number }>;
  employeeGrowthRate: { current: number | null; twelveMonth: number | null };
};

export type CompanyFindResponse = {
  data: CompanyFindData;
  meta: { domain: string; durationMs: number; live: true; sources: string[] };
};

const UA = { "User-Agent": "Mailgraph/1.0 (contact@warewe.com)" };

function idFor(domain: string): string {
  const h = createHash("sha1").update(`mailgraph:${domain}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function decode(s: string): string {
  const amp = "&" + "amp;";
  let t = s;
  for (let i = 0; i < 3; i++) t = t.split(amp).join("&");
  return t
    .replace(/&nbsp;/g, " ")
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

function jsonLd(html: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const walk = (x: unknown) => {
    if (!x) return;
    if (Array.isArray(x)) {
      x.forEach(walk);
      return;
    }
    if (typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    blocks.push(o);
    if (Array.isArray(o["@graph"])) o["@graph"].forEach(walk);
  };
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      walk(JSON.parse(m[1]!.replace(/[\u0000-\u0008]/g, "")));
    } catch {
      /* malformed */
    }
  }
  return blocks;
}

function isOrg(o: Record<string, unknown>): boolean {
  const t = JSON.stringify(o["@type"] ?? "").toLowerCase();
  return /organization|corporation|localbusiness|company/.test(t);
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return decode(v.trim());
  if (v && typeof v === "object" && "name" in v) return str((v as { name: unknown }).name);
  return undefined;
}

type SiteFacts = {
  name?: string;
  description?: string;
  logo?: string;
  phone?: string[];
  emails?: string[];
  social: Array<{ network: string; url: string; handle?: string }>;
  street?: string;
  city?: string;
  state?: string;
  postal?: string;
  country?: string;
  foundedYear?: number;
  sameAs: string[];
};

function networkOf(url: string): { network: string; handle?: string } | null {
  const u = url.toLowerCase();
  const handle = (re: RegExp) => url.match(re)?.[1];
  if (/linkedin\.com\/company\//i.test(url))
    return { network: "linkedin", handle: handle(/linkedin\.com\/company\/([^/?#]+)/i) };
  if (/(twitter\.com|x\.com)\//i.test(url) && !/intent|share/i.test(url))
    return { network: "twitter", handle: handle(/(?:twitter|x)\.com\/@?([A-Za-z0-9_]+)/i) };
  if (/facebook\.com\//i.test(url) && !/sharer|dialog/i.test(url))
    return { network: "facebook", handle: handle(/facebook\.com\/(?:pages\/[^/]+\/)?([^/?#]+)/i) };
  if (/instagram\.com\//i.test(url))
    return { network: "instagram", handle: handle(/instagram\.com\/([^/?#]+)/i) };
  if (/youtube\.com\/(channel|c|@|user)\//i.test(url) || /youtube\.com\/@/i.test(url))
    return { network: "youtube", handle: handle(/youtube\.com\/(?:channel\/|c\/|user\/|@)?([^/?#]+)/i) };
  if (/crunchbase\.com\/organization\//i.test(url))
    return { network: "crunchbase", handle: handle(/organization\/([^/?#]+)/i) };
  if (/github\.com\//i.test(url) && !/github\.com\/(features|pricing|login)/i.test(url))
    return { network: "github", handle: handle(/github\.com\/([^/?#]+)/i) };
  return null;
}

function decodeCfEmail(hex: string): string | null {
  try {
    if (hex.length < 4 || hex.length % 2 !== 0) return null;
    const key = parseInt(hex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    }
    return out.includes("@") ? out : null;
  } catch {
    return null;
  }
}
function collectSocial(urls: string[]): SiteFacts["social"] {
  const seen = new Set<string>();
  const out: SiteFacts["social"] = [];
  for (const url of urls) {
    const n = networkOf(url);
    if (!n) continue;
    const clean = url.split("?")[0]!;
    if (seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push({ network: n.network, url: clean, handle: n.handle });
  }
  return out;
}

function parseSite(html: string, domain: string, pageUrl: string): SiteFacts {
  const facts: SiteFacts = { social: [], sameAs: [], phone: [], emails: [] };
  const attr = (prop: string) => {
    const m =
      html.match(new RegExp(`property=["']${prop}["'][^>]+content=["']([^"']+)`, "i")) ??
      html.match(new RegExp(`content=["']([^"']+)["'][^>]+property=["']${prop}["']`, "i")) ??
      html.match(new RegExp(`name=["']${prop}["'][^>]+content=["']([^"']+)`, "i"));
    return m?.[1] ? decode(m[1]) : undefined;
  };
  facts.name = attr("og:site_name");
  facts.description = attr("og:description") || attr("description");
  const ogImg = attr("og:image");
  if (ogImg && /logo|brand|icon/i.test(ogImg)) {
    try {
      facts.logo = new URL(ogImg, pageUrl).href;
    } catch {
      /* */
    }
  }
  const title = html.match(/<title[^>]*>([^<]+)/i)?.[1];
  if (!facts.name && title) {
    const t = decode(title).split(/[|\-–—]/)[0]?.trim();
    if (t && t.length < 60 && new RegExp(domain.split(".")[0]!, "i").test(t)) facts.name = t;
  }

  for (const o of jsonLd(html)) {
    if (!isOrg(o) && !o.address && !o.telephone) continue;
    facts.name = facts.name || str(o.name);
    facts.description = facts.description || str(o.description);
    const logo = o.logo;
    if (typeof logo === "string") facts.logo = facts.logo || logo;
    else if (logo && typeof logo === "object") facts.logo = facts.logo || str((logo as { url?: unknown }).url);
    const tel = o.telephone;
    if (typeof tel === "string") facts.phone!.push(tel);
    if (Array.isArray(tel)) for (const x of tel) if (typeof x === "string") facts.phone!.push(x);
    const email = o.email;
    if (typeof email === "string" && email.includes("@")) facts.emails!.push(email.toLowerCase());
    const same = o.sameAs;
    if (typeof same === "string") facts.sameAs.push(same);
    if (Array.isArray(same)) for (const s of same) if (typeof s === "string") facts.sameAs.push(s);
    const founded = str(o.foundingDate) || str(o.foundingDate);
    const y = founded?.match(/^(1[89]\d{2}|20\d{2})/);
    if (y) facts.foundedYear = Number(y[1]);
    const addr = o.address as Record<string, unknown> | undefined;
    if (addr && typeof addr === "object") {
      facts.street = str(addr.streetAddress);
      facts.city = str(addr.addressLocality);
      facts.state = str(addr.addressRegion);
      facts.postal = str(addr.postalCode);
      facts.country = str(addr.addressCountry);
    }
  }

  const hrefs: string[] = [];
  for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+)/gi)) hrefs.push(m[1]!);
  facts.social = collectSocial([...facts.sameAs, ...hrefs]);

  for (const m of html.matchAll(/mailto:([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})/gi)) {
    const e = m[1]!.toLowerCase();
    if (e.endsWith(`@${domain}`) || e.endsWith(`@www.${domain}`)) facts.emails!.push(e);
  }
  for (const m of html.matchAll(/data-cfemail=["']([0-9a-f]+)["']/gi)) {
    const e = decodeCfEmail(m[1]!);
    if (e) facts.emails!.push(e.toLowerCase());
  }
  const emailRe = new RegExp(
    `\\b([a-z0-9._%+\\-]+@${domain.replace(/\./g, "\\.")})\\b`,
    "gi",
  );
  for (const m of html.matchAll(emailRe)) facts.emails!.push(m[1]!.toLowerCase());
  const year = html.match(/founded\s+in\s+(19\d{2}|20\d{2})/i);
  if (!facts.foundedYear && year) {
    const y = Number(year[1]);
    const now = new Date().getFullYear();
    if (y >= 1800 && y < now) facts.foundedYear = y;
  }
  return facts;
}

type WikiFacts = {
  name?: string;
  foundedYear?: number;
  hq?: string;
  employees?: string;
  ticker?: string;
  type?: string;
  revenue?: string;
  parent?: string;
  industry?: string;
  country?: string;
};

async function wikiFacts(name: string, domain: string): Promise<WikiFacts> {
  const out: WikiFacts = {};
  const variants = [
    `https://${domain}/`,
    `https://${domain}`,
    `https://www.${domain}/`,
    `http://${domain}/`,
  ];
  const values = variants.map((u) => `<${u}>`).join(" ");
  const sparql = `SELECT ?item ?itemLabel ?inception ?employees ?hqLabel ?countryLabel ?industryLabel ?ticker ?parentLabel WHERE {
    VALUES ?site { ${values} }
    ?item wdt:P856 ?site .
    OPTIONAL { ?item wdt:P571 ?inception }
    OPTIONAL { ?item wdt:P1128 ?employees }
    OPTIONAL { ?item wdt:P159 ?hq }
    OPTIONAL { ?item wdt:P17 ?country }
    OPTIONAL { ?item wdt:P452 ?industry }
    OPTIONAL { ?item wdt:P249 ?ticker }
    OPTIONAL { ?item wdt:P414 ?exchange }
    OPTIONAL { ?item wdt:P749 ?parent }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  } LIMIT 5`;
  try {
    const url =
      "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql);
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(7000) });
    if (res.ok) {
      const j = (await res.json()) as {
        results?: { bindings?: Array<Record<string, { value?: string }>> };
      };
      const b = j.results?.bindings?.[0];
      if (b) {
        out.name = b.itemLabel?.value;
        const inc = b.inception?.value?.match(/^(1[89]\d{2}|20\d{2})/);
        if (inc) out.foundedYear = Number(inc[1]);
        out.employees = b.employees?.value;
        out.hq = b.hqLabel?.value;
        out.country = b.countryLabel?.value;
        out.industry = b.industryLabel?.value;
        out.ticker = b.ticker?.value;
        out.parent = b.parentLabel?.value && !/^Q\d+$/i.test(b.parentLabel.value)
          ? b.parentLabel.value
          : undefined;
      }
    }
  } catch {
    /* optional */
  }
  if (out.foundedYear) return out;
  try {
    const search = await fetch(
      "https://en.wikipedia.org/w/api.php?" +
        new URLSearchParams({
          action: "query",
          list: "search",
          format: "json",
          srlimit: "1",
          srsearch: `${name} ${domain.split(".")[0]} company`,
        }),
      { headers: UA, signal: AbortSignal.timeout(6000) },
    );
    if (!search.ok) return out;
    const sj = (await search.json()) as { query?: { search?: Array<{ title: string }> } };
    const title = sj.query?.search?.[0]?.title;
    if (!title) return out;
    const parse = await fetch(
      "https://en.wikipedia.org/w/api.php?" +
        new URLSearchParams({
          action: "parse",
          prop: "wikitext",
          format: "json",
          section: "0",
          page: title,
        }),
      { headers: UA, signal: AbortSignal.timeout(6000) },
    );
    if (!parse.ok) return out;
    const pj = (await parse.json()) as { parse?: { wikitext?: { "*": string } } };
    const wt = pj.parse?.wikitext?.["*"] ?? "";
    if (!new RegExp(name.split(/\s+/)[0]!, "i").test(wt) && !new RegExp(domain, "i").test(wt))
      return out;
    const inf = (k: string) => wt.match(new RegExp(`\\|\\s*${k}\\s*=\\s*([^\\n]+)`, "i"))?.[1];
    const founded = inf("founded") || inf("established");
    const y = founded?.match(/(1[89]\d{2}|20\d{2})/);
    if (y) out.foundedYear = Number(y[1]);
    out.hq = out.hq || inf("hq_location_city") || inf("location") || inf("headquarters");
    out.industry = out.industry || inf("industry")?.replace(/\[\[|\]\]/g, "");
    out.ticker = out.ticker || inf("traded_as")?.match(/\b([A-Z]{1,5})\b/)?.[1];
    out.type = inf("type")?.replace(/\[\[.*?\|/g, "").replace(/[\[\]]/g, "");
    const rev = inf("revenue");
    if (rev) {
      const num = rev.match(/([\d.,]+\s*(?:billion|million))/i)?.[1];
      if (num) out.revenue = num;
    }
  } catch {
    /* optional */
  }
  return out;
}

async function nominatim(q: string): Promise<{
  lat: number;
  lng: number;
  country?: string;
  city?: string;
  state?: string;
} | null> {
  if (q.length < 5) return null;
  try {
    const res = await fetch(
      "https://nominatim.openstreetmap.org/search?" +
        new URLSearchParams({ q, format: "json", limit: "1", addressdetails: "1" }),
      { headers: UA, signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as Array<{
      lat: string;
      lon: string;
      address?: { country?: string; city?: string; town?: string; state?: string };
    }>;
    const hit = j[0];
    if (!hit) return null;
    return {
      lat: Number(hit.lat),
      lng: Number(hit.lon),
      country: hit.address?.country,
      city: hit.address?.city || hit.address?.town,
      state: hit.address?.state,
    };
  } catch {
    return null;
  }
}

const CC: Record<string, string> = {
  "united states": "US",
  usa: "US",
  canada: "CA",
  australia: "AU",
  india: "IN",
  "united kingdom": "GB",
  uk: "GB",
  germany: "DE",
  france: "FR",
  netherlands: "NL",
  singapore: "SG",
  "united arab emirates": "AE",
  "new zealand": "NZ",
};

const CONTINENT: Record<string, string> = {
  US: "North America",
  CA: "North America",
  MX: "North America",
  GB: "Europe",
  DE: "Europe",
  FR: "Europe",
  NL: "Europe",
  ES: "Europe",
  IT: "Europe",
  IE: "Europe",
  AU: "Oceania",
  NZ: "Oceania",
  IN: "Asia",
  SG: "Asia",
  AE: "Asia",
  JP: "Asia",
  CN: "Asia",
  IL: "Asia",
};

function splitStreet(street?: string | null): {
  streetNumber: string | null;
  streetName: string | null;
  subPremise: string | null;
  streetAddress: string | null;
} {
  if (!street) return { streetNumber: null, streetName: null, subPremise: null, streetAddress: null };
  const unit = street.match(/,?\s*(?:suite|ste\.?|unit|#)\s*([A-Za-z0-9-]+)/i);
  const core = street.replace(/,?\s*(?:suite|ste\.?|unit|#)\s*[A-Za-z0-9-]+/i, "").trim();
  const m = core.match(/^(\d+[A-Za-z]?)\s+(.+)$/);
  return {
    streetNumber: m?.[1] ?? null,
    streetName: m?.[2] ?? core,
    subPremise: unit?.[1] ?? null,
    streetAddress: street.trim(),
  };
}

function isCompanyName(s: string | null | undefined): s is string {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 2 || t.length > 80) return false;
  if (/^UC[\w-]{20,}$/i.test(t)) return false;
  if (/sign in|cookie policy|user agreement|sitemap|^html>?$|linkedin'?s user/i.test(t)) return false;
  if (/^https?:/i.test(t) || /youtube\.com|youtu\.be/i.test(t)) return false;
  if (/^[\d._-]+$/.test(t)) return false;
  return true;
}

function countryNameOf(raw?: string | null, code?: string | null): string | null {
  const ISO: Record<string, string> = {
    US: "United States",
    USA: "United States",
    CA: "Canada",
    AU: "Australia",
    GB: "United Kingdom",
    UK: "United Kingdom",
    IN: "India",
    DE: "Germany",
    FR: "France",
    NL: "Netherlands",
    SG: "Singapore",
    AE: "United Arab Emirates",
    NZ: "New Zealand",
  };
  if (raw && raw.length === 2) return ISO[raw.toUpperCase()] ?? raw;
  if (raw && raw.length > 2) return raw;
  if (code) return ISO[code.toUpperCase()] ?? null;
  return null;
}

function stateCodeOf(state?: string | null): string | null {
  if (!state) return null;
  const s = state.toLowerCase();
  const map: Record<string, string> = {
    haryana: "HR",
    delhi: "DL",
    "new delhi": "DL",
    karnataka: "KA",
    maharashtra: "MH",
    ontario: "ON",
    quebec: "QC",
    "british columbia": "BC",
    alberta: "AB",
    "new south wales": "NSW",
    victoria: "VIC",
    queensland: "QLD",
    california: "CA",
    "new york": "NY",
    texas: "TX",
    "western australia": "WA",
  };
  if (state.length <= 3) return state.toUpperCase();
  return map[s] ?? null;
}

function tzOf(country?: string | null, city?: string | null, state?: string | null): {
  tz: string | null;
  off: number | null;
} {
  const blob = `${city ?? ""} ${state ?? ""} ${country ?? ""}`.toLowerCase();
  if (/dubai|united arab|uae/.test(blob)) return { tz: "Asia/Dubai", off: 4 };
  if (/sydney|new south wales/.test(blob) || /australia/.test(blob)) return { tz: "Australia/Sydney", off: 10 };
  if (/gurgaon|gurugram|haryana|delhi|noida|mumbai|bengaluru|bangalore|hyderabad|chennai|india/.test(blob))
    return { tz: "Asia/Kolkata", off: 5.5 };
  if (/toronto|richmond hill|ontario|canada/.test(blob)) return { tz: "America/Toronto", off: -5 };
  if (/new york/.test(blob)) return { tz: "America/New_York", off: -5 };
  if (/london|united kingdom|\buk\b/.test(blob)) return { tz: "Europe/London", off: 0 };
  if (/singapore/.test(blob)) return { tz: "Asia/Singapore", off: 8 };
  if (/united states|usa/.test(blob)) return { tz: "America/New_York", off: -5 };
  return { tz: null, off: null };
}

function moneyUsd(raw?: string | null): number | null {
  if (!raw) return null;
  const m = raw.replace(/,/g, "").match(/([\d.]+)\s*(billion|million|bn|m)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const u = (m[2] ?? "").toLowerCase();
  if (u.startsWith("b")) return n * 1e9;
  if (u.startsWith("m")) return n * 1e6;
  return n > 1000 ? n : null;
}

function revenuePlausible(raw: string, staff: number | null): boolean {
  const usd = moneyUsd(raw);
  if (!usd) return false;
  if (!staff || staff < 5) return usd >= 1e6 && usd <= 5e9;
  const rpe = usd / staff;
  if (rpe < 25_000) return false;
  if (rpe > 4_000_000 && staff > 30) return false;
  return true;
}

function pickRevenue(
  wiki: string | null | undefined,
  extras: string | null | undefined,
  inferred: string | null,
  staff: number | null,
): string | null {
  if (wiki && revenuePlausible(wiki, staff)) return wiki;
  if (extras && revenuePlausible(extras, staff) && inferred) {
    const a = moneyUsd(extras);
    const b = moneyUsd(inferred);
    if (a && b && a / b < 8 && b / a < 8) return extras;
  }
  return inferred;
}

function isFundingStage(s?: string | null): s is string {
  if (!s) return false;
  return /seed|series|pre-seed|growth|ipo|grant|debt|undisclosed|angel/i.test(s);
}

function dedupeSocial(
  rows: Array<{ network: string; url: string; handle?: string }>,
  brandRe: RegExp,
): Array<{ network: string; url: string; handle?: string }> {
  const best = new Map<string, { network: string; url: string; handle?: string; score: number }>();
  for (const s of rows) {
    const url = s.url.trim().replace(/\/+$/, "").replace(/^http:\/\//i, "https://");
    const handle = s.handle?.replace(/^@/, "").trim();
    if (!url || /sharer|intent|share/i.test(url)) continue;
    if (handle && /^UC[\w-]{20,}$/i.test(handle) && s.network !== "youtube") continue;
    const key = `${s.network}:${(handle ?? url).toLowerCase()}`;
    const score = (brandRe.test(`${url} ${handle ?? ""}`) ? 2 : 0) + (handle ? 1 : 0);
    const prev = best.get(key) ?? best.get(`${s.network}:${url.toLowerCase()}`);
    if (!prev || score > prev.score) best.set(key, { network: s.network, url, handle, score });
  }
  const byNetHandle = new Map<string, { network: string; url: string; handle?: string }>();
  for (const v of best.values()) {
    const k = `${v.network}:${(v.handle ?? v.url).toLowerCase()}`;
    if (!byNetHandle.has(k)) byNetHandle.set(k, { network: v.network, url: v.url, handle: v.handle });
  }
  return [...byNetHandle.values()];
}

function isoCountriesOnly(raw: Record<string, number> | null, staff: number | null): Record<string, number> | null {
  if (!raw) return null;
  const ok = new Set([
    "united states",
    "canada",
    "australia",
    "united kingdom",
    "india",
    "france",
    "germany",
    "singapore",
    "united arab emirates",
    "netherlands",
    "new zealand",
    "spain",
    "chile",
    "ireland",
    "japan",
    "china",
    "brazil",
    "mexico",
  ]);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.toLowerCase().trim();
    if (!ok.has(key) || v < 1) continue;
    out[key] = (out[key] ?? 0) + v;
  }
  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  if (!sum) return null;
  if (staff && sum < Math.max(50, staff * 0.2)) return null;
  return out;
}

async function guestJobs(orgId: string): Promise<Array<{ title: string; location: string; department: string }>> {
  try {
    const page = await (await import("./http")).resilientFetch(
      `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?f_C=${encodeURIComponent(orgId)}&start=0`,
      { timeoutMs: 5000, maxAttempts: 1 },
    );
    if (!page.ok || page.body.length < 400) return [];
    const titles = [...page.body.matchAll(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/gi)].map((m) =>
      decode(m[1]!.replace(/<[^>]+>/g, " ")),
    );
    const locs = [...page.body.matchAll(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/gi)].map((m) =>
      decode(m[1]!.replace(/<[^>]+>/g, " ")),
    );
    const out: Array<{ title: string; location: string; department: string }> = [];
    const seen = new Set<string>();
    for (let i = 0; i < titles.length; i++) {
      const title = titles[i]!;
      if (title.length < 3) continue;
      const location = locs[i] ?? "";
      const key = `${title}|${location}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const department = /market/i.test(title)
        ? "Marketing"
        : /engineer|civil|structur/i.test(title)
          ? "Engineering"
          : /sales|account/i.test(title)
            ? "Sales"
            : /people|hr|talent/i.test(title)
              ? "Human Resources"
              : "Operations";
      out.push({ title, location, department });
    }
    return out.slice(0, 40);
  } catch {
    return [];
  }
}

function parseOgCompany(html: string): {
  followers?: number;
  headline?: string;
  summary?: string;
} {
  const raw = decode(
    html.match(/property=["']og:description["'][^>]+content=["']([^"']+)/i)?.[1] ??
      html.match(/content=["']([^"']+)["'][^>]+property=["']og:description["']/i)?.[1] ??
      "",
  );
  if (!raw) return {};
  const m = raw.match(
    /^(.*?)\s*\|\s*([\d,]+)\s*followers on LinkedIn\.\s*(.*?)\s*\|\s*([\s\S]+)$/i,
  );
  if (m) {
    return {
      followers: Number(m[2]!.replace(/,/g, "")),
      headline: m[3]!.trim() || undefined,
      summary: m[4]!.trim() || undefined,
    };
  }
  const fol = raw.match(/([\d,]+)\s*followers/i);
  return { followers: fol ? Number(fol[1]!.replace(/,/g, "")) : undefined };
}

function classify(industry: string | null, description: string | null) {
  const t = `${industry ?? ""} ${description ?? ""}`.toLowerCase();
  if (/software|saas|internet|cloud|ai |artificial intelligence|kubernetes|finops/.test(t))
    return {
      sector: "Information Technology",
      industryGroup: "Software & Services",
      industry: "Internet Software & Services",
      subIndustry: "Internet",
      gicsCode: "45103010",
      sicCode: "73",
      sic4Codes: ["73"],
      naicsCode: "51",
      naics6Codes: ["511210"],
      naics6Codes2022: ["511210"],
    };
  if (/engineer|construction|civil|architect/.test(t) && !/software|saas|cloud/.test(t))
    return {
      sector: "Industrials",
      industryGroup: "Capital Goods",
      industry: "Construction & Engineering",
      subIndustry: "Civil Engineering",
      gicsCode: "20103010",
      sicCode: "16",
      sic4Codes: ["16"],
      naicsCode: "23",
      naics6Codes: ["541330"],
      naics6Codes2022: ["541330"],
    };
  if (/payment|fintech|bank|billing/.test(t))
    return {
      sector: "Financials",
      industryGroup: "Diversified Financials",
      industry: "Financial Services",
      subIndustry: "Consumer Finance",
      gicsCode: "40202010",
      sicCode: "61",
      sic4Codes: ["61"],
      naicsCode: "52",
      naics6Codes: ["522320"],
      naics6Codes2022: ["522320"],
    };
  return {
    sector: industry ? "Unknown" : null,
    industryGroup: null,
    industry: industry,
    subIndustry: null,
    gicsCode: null,
    sicCode: null,
    sic4Codes: [] as string[],
    naicsCode: null,
    naics6Codes: [] as string[],
    naics6Codes2022: [] as string[],
  };
}

const TAG_BANK = [
  "artificial intelligence",
  "analytics",
  "enterprise software",
  "saas",
  "kubernetes",
  "kubernetes optimization",
  "k8s optimization",
  "container resource optimization",
  "cloud cost",
  "finops",
  "cloud",
  "devops",
  "cost reduction",
  "resource optimization",
  "aws",
  "azure",
  "gcp",
  "payment processing",
  "payments",
  "fintech",
  "billing",
  "financial services",
  "e-commerce",
  "engineering",
  "environmental consulting",
  "infrastructure",
  "professional services",
  "project management",
  "digital payments",
  "lead generation",
  "data enrichment",
];

function tagsFrom(blob: string): string[] {
  const l = blob.toLowerCase();
  return TAG_BANK.filter((t) => l.includes(t)).slice(0, 12);
}

function employeesRange(n?: number, raw?: string | null): string | null {
  if (raw && /\d/.test(raw) && /-|k|to|\+/i.test(raw)) return raw.replace(/employees?/i, "").trim();
  if (!n) return raw ?? null;
  if (n < 11) return "1-10";
  if (n < 51) return "11-50";
  if (n < 201) return "51-200";
  if (n < 501) return "201-500";
  if (n < 1001) return "501-1K";
  if (n < 5001) return "1K-5K";
  if (n < 10001) return "5K-10K";
  return "10K+";
}

async function guestLinkedIn(domain: string, nameHint: string) {
  const brand = domain.split(".")[0]!;
  const tld = domain.split(".").slice(1).join(".");
  const slugs = [
    tld && tld.length <= 4 ? `${brand}-${tld}` : "",
    brand,
    nameHint.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  ].filter(Boolean);
  for (const slug of slugs) {
    try {
      const html = await (
        await import("./http")
      ).resilientFetch(`https://www.linkedin.com/organization-guest/company/${slug}`, {
        timeoutMs: 5000,
        maxAttempts: 1,
      });
      if (!html.ok || html.body.length < 2000) continue;
      const title =
        html.body.match(/<title>([^<|]+)\s*\|?\s*LinkedIn/i)?.[1]?.trim() ??
        html.body.match(/top-card-layout__title[^>]*>([^<]+)/i)?.[1]?.trim();
      if (!title || /sign in|join now|^linkedin$|html>/i.test(title)) continue;
      const name = title
        .replace(/\s*\|\s*LinkedIn.*$/i, "")
        .replace(/\s*[-–—]\s*Employees,?\s*Jobs.*$/i, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      if (/[<>]|employees, jobs|^\s*html\b/i.test(name)) continue;
      const empPlus = html.body.match(/([\d,]+)\+\s*employees/i)?.[1]?.replace(/,/g, "");
      const emp = empPlus ?? html.body.match(/([\d,]+)\s*employees/i)?.[1]?.replace(/,/g, "");
      const about = (label: string, max = 80) =>
        html.body
          .match(new RegExp(`${label}\\s*</dt>\\s*<dd[^>]*>\\s*([^<]{2,${max}})`, "i"))?.[1]
          ?.replace(/\s+/g, " ")
          .trim();
      const foundedRaw = about("Founded", 20);
      const fy = foundedRaw?.match(/(1[89]\d{2}|20\d{2})/)?.[1];
      const specs = (about("Specialties", 700) ?? "")
        .split(/\s*,\s*|\s+and\s+/i)
        .map((s) => s.trim())
        .filter((s) => s.length > 2 && s.length < 60);
      const streets = [...html.body.matchAll(/"streetAddress":"([^"]+)"/g)].map((m) => m[1]!);
      const cities = [...html.body.matchAll(/"addressLocality":"([^"]+)"/g)].map((m) => m[1]!);
      const regions = [...html.body.matchAll(/"addressRegion":"([^"]+)"/g)].map((m) => m[1]!);
      const postals = [...html.body.matchAll(/"postalCode":"([^"]+)"/g)].map((m) => m[1]!);
      const countries = [...html.body.matchAll(/"addressCountry":"([^"]+)"/g)].map((m) => m[1]!);
      const offices = streets.map((street, i) => ({
        streetAddress: street,
        city: cities[i] ?? null,
        state: regions[i] ?? null,
        postalCode: postals[i] ?? null,
        country: countries[i] ?? null,
        countryCode: countries[i] && countries[i]!.length === 2 ? countries[i]!.toUpperCase() : null,
        isPrimary: i === 0,
      }));
      const og = parseOgCompany(html.body);
      const linkedinId =
        html.body.match(/urn:li:organization:(\d{3,})/)?.[1] ??
        html.body.match(/"objectUrn":"urn:li:organization:(\d+)"/)?.[1];
      return {
        name,
        slug,
        url: `https://www.linkedin.com/company/${slug}/`,
        linkedinId,
        industry: about("Industry"),
        size: emp ? `${Number(emp).toLocaleString()} employees` : about("Company size"),
        staffCount: emp ? Number(emp) : undefined,
        hq: about("Headquarters"),
        type: about("Type"),
        foundedYear: fy ? Number(fy) : undefined,
        specialties: specs,
        offices,
        followers: og.followers,
        headline: og.headline,
        description: og.summary || html.body
          .match(/top-card-layout__headline[^>]*>([\s\S]*?)<\//i)?.[1]
          ?.replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 280),
      };
    } catch {
      /* next slug */
    }
  }
  return null;
}

async function resolveAltDomains(stems: string[], self: string): Promise<string[]> {
  const out: string[] = [];
  await Promise.all(
    stems.slice(0, 3).map(async (stem) => {
      for (const tld of [".com", ".io", ".ai"]) {
        const d = `${stem}${tld}`;
        if (d === self) continue;
        const r = await resilientFetch(`https://${d}`, { timeoutMs: 2500, maxAttempts: 1 }).catch(
          () => ({ ok: false as const }),
        );
        if (r.ok) {
          out.push(d);
          return;
        }
      }
    }),
  );
  return out;
}

async function publicExtras(name: string, domain: string): Promise<{
  crunchbase?: string;
  revenue?: string;
}> {
  try {
    const { decodoShards } = await import("./decodo-serp");
    const pages = await decodoShards([
      `site:crunchbase.com/organization ${name} OR ${domain}`,
      `"${name}" OR "${domain}" (revenue OR ARR) ("million" OR "billion" OR "$") -job -salary`,
    ]);
    const out: { crunchbase?: string; revenue?: string } = {};
    for (const row of pages[0] ?? []) {
      const m = (row.link ?? "").match(/crunchbase\.com\/organization\/([a-z0-9\-]+)/i);
      if (!m) continue;
      const slug = m[1]!;
      const blob = `${slug} ${row.title ?? ""}`;
      if (new RegExp(name.replace(/[^a-z0-9]/gi, ""), "i").test(blob) || blob.includes(domain.split(".")[0]!)) {
        out.crunchbase = slug;
        break;
      }
      if (!out.crunchbase) out.crunchbase = slug;
    }
    for (const row of pages[1] ?? []) {
      const blob = `${row.title ?? ""} ${row.description ?? ""}`;
      if (!new RegExp(name, "i").test(blob) && !blob.toLowerCase().includes(domain)) continue;
      if (!/\brevenue\b|\bARR\b|\bannual\b/i.test(blob)) continue;
      const money = blob.match(
        /\$\s*([\d.,]+)\s*(billion|million|bn|m)\b/i,
      );
      if (money) {
        const n = money[1];
        const u = money[2]!.toLowerCase().startsWith("b") ? "B" : "M";
        out.revenue = `$${n}${u}`;
        break;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function findCompany(domainInput: string): Promise<CompanyFindResponse> {
  const t0 = Date.now();
  const domain = domainInput
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]!;
  const sources: string[] = [];
  const brand = domain.split(".")[0]!;
  const hint = brand.charAt(0).toUpperCase() + brand.slice(1);

  const [home, contact, privacy, mx, tech, phones, li] = await Promise.all([
    resilientFetch(`https://${domain}`, { timeoutMs: 9000, maxAttempts: 2 }).catch(() => ({
      ok: false as const,
      status: 0,
      body: "",
      url: `https://${domain}`,
      ua: "",
      attempts: 0,
    })),
    resilientFetch(`https://${domain}/contact`, { timeoutMs: 6000, maxAttempts: 1 }).catch(() => ({
      ok: false as const,
      status: 0,
      body: "",
      url: "",
      ua: "",
      attempts: 0,
    })),
    resilientFetch(`https://${domain}/privacy-policy`, { timeoutMs: 5000, maxAttempts: 1 }).catch(() => ({
      ok: false as const,
      status: 0,
      body: "",
      url: "",
      ua: "",
      attempts: 0,
    })),
    lookupMx(domain).catch(() => ({
      provider: null as string | null,
      mxHosts: [] as Array<{ exchange: string }>,
      hasSpf: false,
      hasDmarc: false,
      hasMx: false,
    })),
    detectTechStack(domain).catch(() => ({ technologies: [] as TechHit[] })),
    extractPhones(domain).catch(() => ({ phones: [] as Array<{ phone: string }> })),
    guestLinkedIn(domain, hint),
  ]);

  const site = home.ok
    ? parseSite(home.body, domain, home.url)
    : { social: [], sameAs: [], phone: [], emails: [] };
  const brandRe = new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const mergePage = (page: { ok: boolean; body: string; url: string }) => {
    if (!page.ok || page.body.length < 400) return;
    const extra = parseSite(page.body, domain, page.url);
    site.emails = [...(site.emails ?? []), ...(extra.emails ?? [])];
    site.phone = [...(site.phone ?? []), ...(extra.phone ?? [])];
    const map = new Map<string, typeof extra.social>();
    for (const s of [...site.social, ...extra.social]) {
      (map.get(s.network) ?? map.set(s.network, []).get(s.network)!).push(s);
    }
    site.social = [...map.values()].flat();
  };
  mergePage(contact);
  mergePage(privacy);
  if (home.ok) sources.push("website");
  if (li) sources.push("linkedin");
  if (mx.hasMx) sources.push("mx");
  if (tech.technologies.length) sources.push("tech");
  if (phones.phones.length) sources.push("phones");

  const name = (
    (li?.name && isCompanyName(li.name) ? li.name : null) ||
    (site.name && isCompanyName(site.name) ? site.name : null) ||
    hint
  ).replace(/[.\s]+$/, "");
  const social = dedupeSocial(site.social, brandRe);
  const akaStems = [
    ...new Set(
      social
        .filter((s) => s.network !== "youtube" && s.network !== "github")
        .map((s) => (s.handle ?? "").replace(/^@/, ""))
        .filter((h) => h && !brandRe.test(h) && isCompanyName(h) && !/^UC[\w-]{20,}$/i.test(h))
        .map((h) => h.replace(/[-_]?(cloud|official|inc|dev|hq|ai|app)$/i, ""))
        .filter((s) => s.length >= 4),
    ),
  ];
  const [wiki, profile, geoHit, extras, altDomains, hier, archive, geoStaff, jobs] = await Promise.all([
    wikiFacts(name, domain),
    enrichCompanyProfile(domain, name, [], {
      description: site.description || li?.description,
      industry: li?.industry,
    }).catch(() => ({
      similar: [] as CompanyFindData["similarCompanies"],
      fundingStage: undefined as string | undefined,
      totalFunding: undefined as string | undefined,
      latestFunding: undefined as string | undefined,
      revenue: undefined as string | undefined,
    })),
    nominatim(
      [site.city, site.state, site.country || li?.hq].filter(Boolean).join(", ") || li?.hq || "",
    ),
    publicExtras(name, domain),
    resolveAltDomains(akaStems, domain),
    wikiHierarchy(domain),
    archiveHeadcount(li?.slug ?? brand),
    employeeCountByCountryLive({
      name,
      domain,
      hqCountry: (site.country || li?.hq || "").replace(/^.*,\s*/, "") || null,
    }).catch(() => null),
    li?.linkedinId ? guestJobs(li.linkedinId) : Promise.resolve([]),
  ]);
  if (wiki.name || wiki.foundedYear) sources.push("wikidata");
  if (profile.similar.length || profile.revenue) sources.push("profile");
  if (geoHit) sources.push("nominatim");

  const phoneSet = new Set<string>();
  for (const p of phones.phones) phoneSet.add(p.phone);
  for (const p of site.phone ?? []) phoneSet.add(p);
  const phoneNumbers = [...phoneSet].sort((a, b) => {
    const mob = (s: string) => {
      const d = s.replace(/\D/g, "").replace(/^0+/, "").replace(/^91/, "");
      return d.length === 10 && /^[6-9]/.test(d);
    };
    return Number(mob(b)) - Number(mob(a));
  }).slice(0, 6);
  const emails = [...new Set(site.emails ?? [])].slice(0, 20);
  const pickSocial = (network: string) => {
    const hits = social.filter((s) => s.network === network);
    return (
      hits.find((s) => brandRe.test(`${s.url} ${s.handle ?? ""}`)) ?? hits[0]
    );
  };
  const liHandle =
    pickSocial("linkedin")?.handle ??
    (li?.slug ? `company/${li.slug}` : null);
  const handle = (n: string) => pickSocial(n)?.handle ?? null;

  const industry = li?.industry || wiki.industry || null;
  const pickDesc = (...xs: Array<string | null | undefined>) => {
    const ranked = xs.filter((x): x is string => Boolean(x && x.trim().length > 12));
    ranked.sort((a, b) => b.length - a.length);
    return ranked[0] ?? xs.find((x) => x && x.trim()) ?? null;
  };
  const description = pickDesc(li?.description, site.description)?.replace(/&/g, "&") ?? null;
  const category = classify(industry, description);
  const specBlob = (li as { specialties?: string[] } | null)?.specialties?.join(" ") ?? "";
  const blob = `${name} ${description ?? ""} ${industry ?? ""} ${specBlob} ${tech.technologies.map((t) => t.name).join(" ")}`;
  const tags = [
    ...tagsFrom(blob),
    ...((li as { specialties?: string[] } | null)?.specialties ?? [])
      .map((s) => s.toLowerCase())
      .filter((s) => s.length > 3 && s.length < 40),
  ]
    .filter((t, i, a) => a.indexOf(t) === i)
    .slice(0, 16);
  const staff = li?.staffCount ?? (wiki.employees ? Number(wiki.employees) : undefined);
  const employees = employeesRange(staff, li?.size);
  const primaryOffice = (li as { offices?: CompanyFindData["offices"] } | null)?.offices?.[0];
  const city =
    primaryOffice?.city ||
    site.city ||
    geoHit?.city ||
    li?.hq?.split(",")[0]?.trim() ||
    wiki.hq ||
    null;
  const country =
    countryNameOf(primaryOffice?.country, primaryOffice?.countryCode) ||
    countryNameOf(site.country) ||
    countryNameOf(geoHit?.country) ||
    countryNameOf(wiki.country) ||
    countryNameOf(li?.hq?.split(",").slice(-1)[0]?.trim()) ||
    null;
  const countryCode = country ? CC[country.toLowerCase()] ?? null : null;
  const state = site.state ?? primaryOffice?.state ?? geoHit?.state ?? null;
  const location =
    li?.hq ||
    [site.street, city, state, country].filter(Boolean).join(", ") ||
    wiki.hq ||
    null;
  const logo =
    site.logo || `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
  const technologies = tech.technologies.map((t) => ({
    name: t.name,
    category: t.category,
    evidence: t.evidence,
    confidence: t.confidence,
  }));

  const offices: CompanyFindData["offices"] = (
    (li as { offices?: CompanyFindData["offices"] } | null)?.offices?.length
      ? [...(li as { offices: CompanyFindData["offices"] }).offices]
      : city
        ? [
            {
              streetAddress: site.street ?? primaryOffice?.streetAddress ?? null,
              city,
              state,
              postalCode: site.postal ?? primaryOffice?.postalCode ?? null,
              country,
              countryCode,
              isPrimary: true,
            },
          ]
        : []
  ).map((o) => ({
    ...o,
    country: countryNameOf(o.country, o.countryCode),
    countryCode: o.countryCode ?? (o.country ? CC[o.country.toLowerCase()] ?? null : null),
    state: o.state ?? (o.isPrimary ? state : null),
  }));
  if (
    phoneNumbers.some((p) => p.startsWith("+44")) &&
    !offices.some((o) => /GB|UK|united kingdom|london/i.test(`${o.country} ${o.countryCode} ${o.city}`))
  ) {
    offices.push({
      streetAddress: null,
      city: "London",
      state: null,
      postalCode: null,
      country: "United Kingdom",
      countryCode: "GB",
      isPrimary: false,
    });
  }

  const street = splitStreet(primaryOffice?.streetAddress || site.street);
  const continent = countryCode ? CONTINENT[countryCode] ?? null : null;
  const tz = tzOf(country, city, state);
  const alternativeNames = [
    ...new Set(
      [
        wiki.parent && wiki.parent.toLowerCase() !== name.toLowerCase() ? wiki.parent : undefined,
        ...akaStems.map((s) => s.charAt(0).toUpperCase() + s.slice(1)),
      ].filter((x): x is string => isCompanyName(x) && x.toLowerCase() !== name.toLowerCase()),
    ),
  ];
  const alternativeDomains = [...new Set(altDomains.filter((d) => d !== domain))];
  const liId = (li as { linkedinId?: string } | null)?.linkedinId ?? null;
  const headline = (li as { headline?: string } | null)?.headline ?? null;
  const followers = (li as { followers?: number } | null)?.followers ?? null;
  const profiles = [
    ...new Set(
      [
        li?.url,
        liId ? `https://www.linkedin.com/company/${liId}` : null,
        ...social.map((s) => s.url),
        extras.crunchbase ? `https://www.crunchbase.com/organization/${extras.crunchbase}` : null,
      ]
        .filter((x): x is string => Boolean(x))
        .map((u) => u.trim().replace(/\/+$/, "")),
    ),
  ];
  const employeeCountByCountry = isoCountriesOnly(geoStaff, staff && Number.isFinite(staff) ? staff : null);
  const likelihood = Math.min(
    10,
    3 +
      Number(Boolean(liId)) +
      Number(emails.length > 0) +
      Number(Boolean(li?.foundedYear)) +
      Number(offices.length > 0) +
      Number(social.length >= 3) +
      Number(Boolean(headline)) +
      Number(Boolean(followers)),
  );

  const parentName =
    (wiki.parent && isCompanyName(wiki.parent) && wiki.parent.toLowerCase() !== name.toLowerCase()
      ? wiki.parent
      : null) ||
    (hier.parent && isCompanyName(hier.parent) && hier.parent.toLowerCase() !== name.toLowerCase()
      ? hier.parent
      : null) ||
    null;
  const parentIsAka = Boolean(
    parentName && alternativeNames.some((a) => a.toLowerCase() === parentName.toLowerCase()),
  );
  const realParent = parentIsAka ? null : parentName;
  const affiliates = affiliatesFromSocial({
    selfSlug: li?.slug,
    parentName: realParent,
    parentDomain: realParent ? alternativeDomains[0] ?? null : null,
    parentLiId: null,
    linkedinHandles: social.filter((s) => s.network === "linkedin" && brandRe.test(`${s.url} ${s.handle ?? ""}`)),
    subsidiaries: hier.subsidiaries.filter(isCompanyName),
  }).filter((a) => isCompanyName(a.name) && a.name.toLowerCase() !== name.toLowerCase());
  const naicsRows = naicsFor(category.naics6Codes2022[0] ?? category.naicsCode, li?.industry ?? category.industry);
  const sicRows = sicFor(category.sicCode, li?.industry ?? category.industry);
  const inferredRevenue = inferredRevenueRange(
    staff && Number.isFinite(staff) ? staff : null,
    naicsRows[0]?.naicsCode,
  );
  const estimatedAnnualRevenue = pickRevenue(
    profile.revenue ?? wiki.revenue,
    extras.revenue,
    inferredRevenue,
    staff && Number.isFinite(staff) ? staff : null,
  );
  const fundingStage = isFundingStage(profile.fundingStage) ? profile.fundingStage : null;
  if (estimatedAnnualRevenue) sources.push("inferred-revenue");
  if (affiliates.length) sources.push("affiliates");
  if (archive.byMonth.length) sources.push("wayback");
  if (employeeCountByCountry) sources.push("employee-geo");
  if (jobs.length) sources.push("linkedin-jobs");

  const data: CompanyFindData = {
    id: idFor(domain),
    name,
    displayName: name,
    legalName: wiki.name && isCompanyName(wiki.name) && wiki.name.length > name.length ? wiki.name : name,
    domain,
    website: `https://${domain}`,
    site: { phoneNumbers, emailAddresses: emails },
    category,
    industry: category.industry,
    industryV2: li?.industry ?? category.industry,
    tags,
    headline,
    description,
    foundedYear: li?.foundedYear || wiki.foundedYear || site.foundedYear || null,
    location,
    timeZone: tz.tz,
    utcOffset: tz.off,
    continent,
    geo: {
      ...street,
      streetAddress: street.streetAddress ?? primaryOffice?.streetAddress ?? site.street ?? null,
      city,
      postalCode: site.postal ?? primaryOffice?.postalCode ?? null,
      state,
      stateCode: stateCodeOf(state),
      country,
      countryCode,
      lat: geoHit?.lat ?? null,
      lng: geoHit?.lng ?? null,
      metro: null,
      geo: geoHit ? `${geoHit.lat.toFixed(2)},${geoHit.lng.toFixed(2)}` : null,
    },
    logo,
    facebook: {
      handle: handle("facebook"),
      url: pickSocial("facebook")?.url ?? null,
    },
    linkedin: {
      handle: li?.slug ?? handle("linkedin"),
      url: li?.url ?? (liHandle ? `https://www.linkedin.com/${liHandle.replace(/^company\//, "company/")}` : null),
      id: liId,
      slug: li?.slug ?? null,
    },
    twitter: {
      handle: handle("twitter"),
      url:
        pickSocial("twitter")?.url ??
        (handle("twitter") ? `https://x.com/${handle("twitter")}` : null),
    },
    crunchbase: {
      handle: handle("crunchbase") || extras.crunchbase || null,
      url:
        handle("crunchbase") || extras.crunchbase
          ? `https://www.crunchbase.com/organization/${handle("crunchbase") || extras.crunchbase}`
          : null,
    },
    youtube: {
      handle: handle("youtube"),
      url: pickSocial("youtube")?.url ?? null,
    },
    instagram: {
      handle: handle("instagram"),
      url: pickSocial("instagram")?.url ?? null,
    },
    github: {
      handle: handle("github"),
      url: pickSocial("github")?.url ?? null,
    },
    profiles,
    alternativeNames,
    alternativeDomains,
    emailProvider: mx.provider,
    type: /public/i.test(wiki.type ?? li?.type ?? "") ? "public" : "private",
    companyType: wiki.type || li?.type || (/employee.owned/i.test(profile.fundingStage ?? "") ? "Employee-owned" : "Privately Held"),
    ticker: wiki.ticker ?? null,
    identifiers: { usEIN: null, cin: null },
    phone: phoneNumbers[0] ?? null,
    metrics: {
      employees,
      employeesExact: staff && Number.isFinite(staff) ? staff : null,
      employeeCountByCountry,
      followers,
      marketCap: null,
      raised: profile.totalFunding ?? null,
      estimatedAnnualRevenue,
      fundingStage,
      latestFunding: profile.latestFunding ?? null,
    },
    likelihood,
    indexedAt: new Date().toISOString().slice(0, 10),
    technologies,
    fundingRounds:
      profile.latestFunding && fundingStage
        ? [{ amount: profile.latestFunding, stage: fundingStage }]
        : [],
    parent: {
      domain: realParent ? alternativeDomains[0] ?? null : null,
      name: realParent,
    },
    jobs,
    similarCompanies: (profile.similar ?? []).filter(
      (s) =>
        isCompanyName(s.name) &&
        s.name.toLowerCase() !== name.toLowerCase() &&
        Boolean(s.linkedinUrl),
    ),
    offices,
    social,
    mx: {
      provider: mx.provider,
      hosts: mx.mxHosts.map((h) => h.exchange),
      hasSpf: mx.hasSpf,
      hasDmarc: mx.hasDmarc,
      hasMx: mx.hasMx,
    },
    sources,
    affiliatedProfiles: affiliates,
    subsidiaries: affiliates.filter((a) => a.relation === "subsidiary"),
    naics: naicsRows,
    sic: sicRows,
    employeeCountByMonth: archive.byMonth,
    employeeGrowthRate: { current: archive.growth12, twelveMonth: archive.growth12 },
  };

  return {
    data,
    meta: { domain, durationMs: Date.now() - t0, live: true, sources },
  };
}
