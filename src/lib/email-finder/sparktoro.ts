/**
 * SparkToro public API v3.
 * POST /v3/describe/create then every section on the screenshot:
 * demographics, networks, youtube, podcasts, websites, press,
 * apps/{type}, social, reddit, prompts, bios, tam, keywords.
 *
 * 10 req/min. Repeat pulls of the same report_id+section are free.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://api.sparktoro.com";
const CACHE = join(process.cwd(), "data", "sparktoro-cache.json");

export type SparkToroRow = {
  name: string;
  url?: string;
  affinity: number;
  pct: number;
  evidence: string;
  extra?: Record<string, unknown>;
};

export type SparkToroReport = {
  reportId: string;
  prompt: string;
  location: string;
  creditsRemaining: number | null;
  demographics: Record<string, SparkToroRow[]>;
  networks: SparkToroRow[];
  youtube: SparkToroRow[];
  podcasts: SparkToroRow[];
  websites: SparkToroRow[];
  press: SparkToroRow[];
  apps: SparkToroRow[];
  social: SparkToroRow[];
  reddit: SparkToroRow[];
  prompts: SparkToroRow[];
  bios: SparkToroRow[];
  keywords: SparkToroRow[];
  tam: {
    estimated_population: number | null;
    year_over_year_growth_pct: number | null;
    estimated_market_value: number | null;
    currency: string | null;
    rationale: string | null;
  } | null;
  sources: string[];
  errors: string[];
};

function apiKey(): string {
  const fromEnv = (process.env.SPARKTORO_API_KEY || process.env.SPARKTORO_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const m = readFileSync("/workspace/.env", "utf8").match(/^SPARKTORO_API_KEY=(.*)$/m);
    return m?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type CacheFile = Record<string, { reportId: string; at: number }>;

function loadCache(): CacheFile {
  try {
    if (!existsSync(CACHE)) return {};
    return JSON.parse(readFileSync(CACHE, "utf8")) as CacheFile;
  } catch {
    return {};
  }
}

function saveCache(c: CacheFile) {
  try {
    mkdirSync(join(process.cwd(), "data"), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(c));
  } catch {
    /* */
  }
}

const windowHits: number[] = [];

async function throttle() {
  const now = Date.now();
  while (windowHits.length && now - windowHits[0]! > 60_000) windowHits.shift();
  if (windowHits.length >= 9) {
    const wait = 60_000 - (now - windowHits[0]!) + 400;
    await sleep(Math.max(250, wait));
  }
  windowHits.push(Date.now());
}

async function stFetch(path: string, init?: RequestInit, attempts = 6): Promise<{ status: number; json: Record<string, unknown> }> {
  const key = apiKey();
  if (!key) throw new Error("SPARKTORO_API_KEY missing");
  let last: { status: number; json: Record<string, unknown> } = { status: 0, json: {} };
  for (let i = 0; i < attempts; i++) {
    await throttle();
    try {
      const res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Mailgraph/1.0",
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(45_000),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      last = { status: res.status, json };
      if (res.status === 202) {
        await sleep(2500 + i * 1500);
        continue;
      }
      if (res.status === 429) {
        const wait = Number(json.retry_after ?? 35) * 1000;
        await sleep(wait);
        continue;
      }
      return last;
    } catch {
      await sleep(1200 * (i + 1));
    }
  }
  return last;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function rowFrom(item: Record<string, unknown>, source: string): SparkToroRow | null {
  const name =
    str(item.title) ||
    str(item.name) ||
    str(item.display_name) ||
    str(item.keyword) ||
    str(item.topic) ||
    str(item.domain) ||
    str(item.username);
  if (!name) return null;
  const url =
    str(item.url) ||
    str(item.link) ||
    str(item.channel_url) ||
    str(item.website) ||
    (item.domain ? `https://${str(item.domain)}` : "") ||
    undefined;
  const affinity = Math.round(num(item.affinity) * 10) / 10;
  const pct = item.value != null ? Math.round(num(item.value) * 10) / 10 : affinity;
  const evidence = [str(item.author), str(item.category), str(item.meta_description), str(item.description), item.volume != null ? `vol ${item.volume}` : "", item.cpc != null ? `cpc $${item.cpc}` : "", source]
    .filter(Boolean)
    .slice(0, 3)
    .join(" · ");
  return { name, url: url || undefined, affinity, pct, evidence, extra: item };
}

function listRows(data: unknown, source: string, limit = 40): SparkToroRow[] {
  const arr = Array.isArray(data) ? data : [];
  const out: SparkToroRow[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = rowFrom(raw as Record<string, unknown>, source);
    if (r) out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

function socialUrl(item: Record<string, unknown>): string | undefined {
  const rel = item.relationships as Record<string, Array<{ type?: string; username?: string; clean_domain?: string }>> | undefined;
  const tw = rel?.twitter?.[0]?.username;
  if (tw) return `https://x.com/${tw.replace(/^@/, "")}`;
  const li = rel?.linkedin?.[0]?.username;
  if (li) return li.startsWith("http") ? li : `https://www.linkedin.com/in/${li}`;
  const dom = rel?.domain?.[0]?.clean_domain || rel?.domain?.[0]?.username;
  if (dom) return dom.startsWith("http") ? dom : `https://${dom}`;
  return str(item.website) || undefined;
}

export function buildAudiencePrompt(opts: {
  brief?: string;
  product?: string;
  buyers: Array<{
    title?: string | null;
    role?: string | null;
    industry?: string | null;
    company?: string | null;
    location?: string | null;
  }>;
}): { prompt: string; location: "us" | "ca" | "uk" } {
  const titles = [...new Set(opts.buyers.map((b) => (b.title || b.role || "").replace(/ \(role inbox\)/i, "").trim()).filter((t) => t.length > 2))].slice(0, 6);
  const industries = [...new Set(opts.buyers.map((b) => (b.industry || "").split(/[,/]/)[0]!.trim()).filter((t) => t.length > 2))].slice(0, 5);
  const companies = [...new Set(opts.buyers.map((b) => (b.company || "").trim()).filter((t) => t.length > 2))].slice(0, 6);
  const locBlob = opts.buyers.map((b) => (b.location || "").toLowerCase()).join(" ");
  const location: "us" | "ca" | "uk" = /\bcanada|ontario|toronto|vancouver\b/.test(locBlob)
    ? "ca"
    : /\b(uk|united kingdom|england|london)\b/.test(locBlob)
      ? "uk"
      : "us";
  const who = titles.length ? titles.join(", ") : "marketing, growth, and revenue leaders";
  const ind = industries.length ? industries.join(", ") : "B2B SaaS";
  const logos = companies.length ? ` at companies such as ${companies.join(", ")}` : "";
  const buy = (opts.brief || opts.product || "email verification, email finder, and lead-generation software").replace(/\s+/g, " ").trim();
  const prompt = `${who} working in ${ind}${logos} who buy ${buy}. People, not topics.`;
  return { prompt, location };
}

function payloadPath(id: string) {
  return join(process.cwd(), "data", "sparktoro-reports", `${id}.json`);
}

function loadPayload(id: string): { sections: Record<string, unknown>; creditsRemaining?: number } | null {
  try {
    const p = payloadPath(id);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as { sections: Record<string, unknown>; creditsRemaining?: number };
  } catch {
    return null;
  }
}

function savePayload(id: string, sections: Record<string, unknown>, creditsRemaining: number | null) {
  try {
    mkdirSync(join(process.cwd(), "data", "sparktoro-reports"), { recursive: true });
    writeFileSync(payloadPath(id), JSON.stringify({ reportId: id, sections, creditsRemaining }));
  } catch {
    /* */
  }
}

function hydrate(
  reportId: string,
  prompt: string,
  location: string,
  sections: Record<string, unknown>,
  credits: number | null,
): SparkToroReport {
  const empty: SparkToroReport = {
    reportId,
    prompt,
    location,
    creditsRemaining: credits,
    demographics: {},
    networks: [],
    youtube: [],
    podcasts: [],
    websites: [],
    press: [],
    apps: [],
    social: [],
    reddit: [],
    prompts: [],
    bios: [],
    keywords: [],
    tam: null,
    sources: ["sparktoro-cache"],
    errors: [],
  };
  const demo = sections.demographics;
  if (demo && typeof demo === "object" && !Array.isArray(demo)) {
    const out: Record<string, SparkToroRow[]> = {};
    for (const [facet, rows] of Object.entries(demo as Record<string, unknown>)) {
      out[facet] = listRows(rows, `sparktoro-${facet}`, 20);
    }
    empty.demographics = out;
  }
  const tam = sections.tam;
  if (tam && typeof tam === "object" && !Array.isArray(tam)) {
    const t = tam as Record<string, unknown>;
    empty.tam = {
      estimated_population: num(t.estimated_population) || null,
      year_over_year_growth_pct: t.year_over_year_growth_pct == null ? null : num(t.year_over_year_growth_pct),
      estimated_market_value: num(t.estimated_market_value) || null,
      currency: str(t.currency) || "USD",
      rationale: str(t.rationale) || null,
    };
  }
  empty.networks = listRows(sections.networks, "sparktoro-networks");
  empty.youtube = listRows(sections.youtube, "sparktoro-youtube");
  empty.podcasts = listRows(sections.podcasts, "sparktoro-podcasts");
  empty.websites = listRows(sections.websites, "sparktoro-websites");
  empty.press = listRows(sections.press, "sparktoro-press");
  empty.prompts = listRows(sections.prompts, "sparktoro-prompts");
  empty.bios = listRows(sections.bios, "sparktoro-bios");
  empty.keywords = listRows(sections.keywords, "sparktoro-keywords");
  empty.reddit = listRows(sections.reddit, "sparktoro-reddit").map((r) => ({
    ...r,
    name: r.name.startsWith("r/") ? r.name : `r/${r.name}`,
    url: r.url || `https://www.reddit.com/r/${r.name.replace(/^r\//, "")}`,
  }));
  const socialItems = Array.isArray(sections.social) ? sections.social : [];
  empty.social = socialItems
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;
      const it = raw as Record<string, unknown>;
      const r = rowFrom(it, "sparktoro-social");
      if (!r) return null;
      r.url = socialUrl(it) || r.url;
      r.evidence = [str(it.description), it.followers ? `${it.followers} followers` : "", "sparktoro"].filter(Boolean).join(" · ");
      return r;
    })
    .filter((x): x is SparkToroRow => Boolean(x));
  const appsAi = listRows(sections.appsAi, "sparktoro-apps").map((r) => ({ ...r, evidence: `AI · ${r.evidence}` }));
  const appsProd = listRows(sections.appsProd, "sparktoro-apps").map((r) => ({ ...r, evidence: `Productivity · ${r.evidence}` }));
  empty.apps = [...appsAi, ...appsProd].sort((a, b) => b.affinity - a.affinity).slice(0, 40);
  return empty;
}

async function listReports(): Promise<Array<{ report_id: string; prompt?: string; name?: string }>> {
  const { status, json } = await stFetch("/v3/reports?limit=20", undefined, 2);
  if (status !== 200) return [];
  const rows = (json as { reports?: Array<{ report_id: string; prompt?: string; name?: string }> }).reports;
  return rows ?? [];
}

function overlap(prompt: string, domains: string[]): number {
  const p = prompt.toLowerCase();
  return domains.filter((d) => {
    const brand = d.split(".")[0] ?? d;
    return brand.length > 3 && p.includes(brand.toLowerCase());
  }).length;
}

export async function sparkToroFullReport(
  prompt: string,
  location: "us" | "ca" | "uk" = "us",
  opts?: { audienceKey?: string; domains?: string[]; allowCreate?: boolean },
): Promise<SparkToroReport> {
  const empty: SparkToroReport = {
    reportId: "",
    prompt,
    location,
    creditsRemaining: null,
    demographics: {},
    networks: [],
    youtube: [],
    podcasts: [],
    websites: [],
    press: [],
    apps: [],
    social: [],
    reddit: [],
    prompts: [],
    bios: [],
    keywords: [],
    tam: null,
    sources: [],
    errors: [],
  };
  const domains = (opts?.domains ?? []).map((d) => d.toLowerCase().replace(/^www\./, "")).filter(Boolean);
  const cacheKey =
    opts?.audienceKey ||
    createHash("sha1")
      .update(`emails|${[...domains].sort().join(",")}`)
      .digest("hex")
      .slice(0, 16);

  const cache = loadCache();
  let reportId = cache[cacheKey]?.reportId || cache[`domains:${[...domains].sort().join(",")}`]?.reportId;

  if (!reportId) {
    const known: Array<{ id: string; brands: string }> = [
      { id: "0afc9e4d337d", brands: "curaeducation lookfor kubex lendpilot qualityhealth e-learning" },
      { id: "745eb1a004b0", brands: "edtech health saas email verification" },
    ];
    const hit = known.find((k) => overlap(k.brands, domains) >= 2 && existsSync(payloadPath(k.id)));
    if (hit) reportId = hit.id;
  }

  if (!reportId && apiKey()) {
    const existing = await listReports();
    const hit = existing.find((r) => overlap(r.prompt || r.name || "", domains) >= 2) || existing[0];
    if (hit) reportId = hit.report_id;
  }

  if (!reportId && opts?.allowCreate !== false && apiKey()) {
    const created = await stFetch(
      "/v3/describe/create",
      { method: "POST", body: JSON.stringify({ prompt, location }) },
      1,
    );
    reportId = str((created.json as { report_id?: string }).report_id);
    if (!reportId) {
      empty.errors.push(`create skipped/failed ${created.status}`);
    }
  }

  if (!reportId) {
    empty.errors.push("no SparkToro report (refusing to spend more create credits)");
    return empty;
  }

  cache[cacheKey] = { reportId, at: Date.now() };
  if (domains.length) cache[`domains:${[...domains].sort().join(",")}`] = { reportId, at: Date.now() };
  saveCache(cache);

  const disk = loadPayload(reportId);
  if (disk?.sections && (disk.sections.websites || disk.sections.demographics)) {
    const hyd = hydrate(reportId, prompt, location, disk.sections, disk.creditsRemaining ?? null);
    hyd.sources = ["sparktoro-disk", ...hyd.sources];
    return hyd;
  }

  /* live fill only missing sections — repeats are free; never create again */
  empty.reportId = reportId;
  const sectionSpecs: Array<{ key: string; path: string }> = [
    { key: "demographics", path: `/v3/demographics?report_id=${reportId}&limit=40` },
    { key: "networks", path: `/v3/networks?report_id=${reportId}&limit=30&history=false` },
    { key: "youtube", path: `/v3/youtube?report_id=${reportId}&limit=30` },
    { key: "podcasts", path: `/v3/podcasts?report_id=${reportId}&limit=30` },
    { key: "websites", path: `/v3/websites?report_id=${reportId}&limit=40&history=false` },
    { key: "press", path: `/v3/press?report_id=${reportId}&limit=30&history=false` },
    { key: "social", path: `/v3/social?report_id=${reportId}&limit=40` },
    { key: "appsAi", path: `/v3/apps/ai?report_id=${reportId}&limit=25&history=false` },
    { key: "appsProd", path: `/v3/apps/productivity?report_id=${reportId}&limit=25&history=false` },
    { key: "reddit", path: `/v3/reddit?report_id=${reportId}&limit=30` },
    { key: "prompts", path: `/v3/prompts?report_id=${reportId}&limit=30` },
    { key: "bios", path: `/v3/bios?report_id=${reportId}&limit=40` },
    { key: "tam", path: `/v3/tam?report_id=${reportId}` },
    { key: "keywords", path: `/v3/keywords?report_id=${reportId}&limit=40` },
  ];
  const sections: Record<string, unknown> = { ...(disk?.sections ?? {}) };
  let credits: number | null = disk?.creditsRemaining ?? null;
  for (const sec of sectionSpecs) {
    if (sections[sec.key] != null) continue;
    const { status, json } = await stFetch(sec.path, undefined, 3);
    const meta = json.meta as { credits_remaining?: number } | undefined;
    if (typeof meta?.credits_remaining === "number") credits = meta.credits_remaining;
    if (status >= 400) {
      empty.errors.push(`${sec.key} ${status}`);
      continue;
    }
    sections[sec.key] = json.data;
  }
  savePayload(reportId, sections, credits);
  return hydrate(reportId, prompt, location, sections, credits);
}


export function stToAffinity(rows: SparkToroRow[], source: string, kind: string) {
  return rows.map((r) => ({
    name: r.name,
    url: r.url,
    kind,
    pct: r.pct,
    affinity: Math.min(100, Math.round(r.affinity)),
    evidence: r.evidence,
    source,
  }));
}
