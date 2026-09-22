/**
 * ApiAlt LinkedIn client (https://apialt.com/docs).
 *
 * One POST https://app.apialt.com/api/v1/run with X-API-Key.
 * Method id in `api`, fields in `params`. Failed calls are not charged.
 *
 * When APIALT_KEY is set, personal Sales Nav cookies are never sent.
 * Do not invent people, companies, or emails from a miss.
 */

import { readFileSync } from "node:fs";
import { GEO_COUNTRIES } from "./linkedin-facets";
import type { PublicProfile } from "./linkedin-public";
import type { SalesNavFilters, SalesNavPerson, SalesNavResult } from "./sales-nav";
import type { DiscoverCompany, DiscoverPerson } from "./voyager-search";

const RUN_URL = "https://app.apialt.com/api/v1/run";

function env(key: string): string {
  if (process.env[key]) return process.env[key]!;
  try {
    const m = readFileSync("/workspace/.env", "utf8").match(
      new RegExp(`^${key}=(.*)$`, "m"),
    );
    return m?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

export function apialtKey(): string {
  return env("APIALT_KEY").trim();
}

export function apialtEnabled(): boolean {
  return apialtKey().startsWith("alt_");
}

export type ApialtRun<T = unknown> = {
  ok: boolean;
  status: number;
  ms: number;
  credits: number;
  api: string;
  error?: string;
  data: T | null;
};

const cache = new Map<string, { at: number; value: ApialtRun }>();

function cacheGet(key: string, ttlMs: number): ApialtRun | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

export async function apialtRun<T = unknown>(
  api: string,
  params: Record<string, unknown>,
  opts?: { timeoutMs?: number; ttlMs?: number; retry?: boolean },
): Promise<ApialtRun<T>> {
  const key = apialtKey();
  if (!key) {
    return { ok: false, status: 0, ms: 0, credits: 0, api, error: "APIALT_KEY missing", data: null };
  }
  const cacheKey = `${api}:${JSON.stringify(params)}`;
  const ttl = opts?.ttlMs ?? 8 * 60_000;
  const cached = cacheGet(cacheKey, ttl);
  if (cached) return cached as ApialtRun<T>;

  const timeoutMs = opts?.timeoutMs ?? 45_000;
  const attempt = async (): Promise<ApialtRun<T>> => {
    const t0 = Date.now();
    try {
      const res = await fetch(RUN_URL, {
        method: "POST",
        headers: {
          "X-API-Key": key,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ api, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        return {
          ok: false,
          status: res.status,
          ms: Date.now() - t0,
          credits: 0,
          api,
          error: text.slice(0, 240) || `http ${res.status}`,
          data: null,
        };
      }
      const data = (body.data ?? null) as T | null;
      const ok = body.ok === true && res.ok;
      return {
        ok,
        status: typeof body.status === "number" ? body.status : res.status,
        ms: typeof body.ms === "number" ? body.ms : Date.now() - t0,
        credits: Number(body.credits_charged ?? 0) || 0,
        api: String(body.api ?? api),
        error: ok ? undefined : String(body.error ?? body.detail ?? `http ${res.status}`).slice(0, 400),
        data: ok ? data : data,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        status: 0,
        ms: Date.now() - t0,
        credits: 0,
        api,
        error: msg.slice(0, 240),
        data: null,
      };
    }
  };

  let out = await attempt();
  const retryable =
    (opts?.retry ?? true) &&
    !out.ok &&
    (out.status >= 500 || out.status === 0) &&
    !/invalid api key/i.test(out.error ?? "");
  if (retryable) {
    await new Promise((r) => setTimeout(r, 1600));
    out = await attempt();
  }
  if (out.ok) cache.set(cacheKey, { at: Date.now(), value: out });
  return out;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function txt(v: unknown, depth = 0): string {
  if (v == null || depth > 4) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "object") return "";
  if (Array.isArray(v)) return txt(v[0], depth + 1);
  const o = v as Record<string, unknown>;
  if (typeof o.text === "string") return o.text.trim();
  if (typeof o.value === "string") return o.value.trim();
  if (typeof o.name === "string") return o.name.trim();
  if (isObj(o.name)) return txt(o.name, depth + 1);
  if (typeof o.localizedName === "string") return o.localizedName.trim();
  if (isObj(o.localized)) return txt(o.localized.en_US ?? o.localized.en_us ?? Object.values(o.localized)[0], depth + 1);
  return "";
}

function firstStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    const s = txt(v);
    if (s) return s;
  }
  return undefined;
}

function items(data: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter(isObj);
  if (!isObj(data)) return [];
  for (const k of keys) {
    const v = data[k];
    if (Array.isArray(v) && v.length) return v.filter(isObj);
  }
  if (isObj(data.data)) return items(data.data, keys);
  if (isObj(data.result)) return items(data.result, keys);
  if (isObj(data.payload)) return items(data.payload, keys);
  return [data];
}

function pagingTotal(data: unknown, fallback: number): number {
  if (!isObj(data)) return fallback;
  const p = isObj(data.paging) ? data.paging : data;
  const n =
    Number(p.total ?? p.totalResults ?? p.count ?? data.total ?? data.results_count ?? data.total_count) ||
    0;
  return n > 0 ? n : fallback;
}

function slugFromUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  const m = raw.match(/linkedin\.com\/(?:[a-z]{2}\/)?in\/([^/?#]+)/i);
  if (!m?.[1]) return undefined;
  try {
    return decodeURIComponent(m[1]).replace(/\/+$/, "");
  } catch {
    return m[1].replace(/\/+$/, "");
  }
}

function companySlugFromUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  const m = raw.match(/linkedin\.com\/(?:[a-z]{2}\/)?company\/([^/?#]+)/i);
  if (!m?.[1]) return undefined;
  try {
    return decodeURIComponent(m[1]).replace(/\/+$/, "");
  } catch {
    return m[1].replace(/\/+$/, "");
  }
}

function looksLikePersonName(raw?: string): boolean {
  if (!raw) return false;
  const n = raw.replace(/\s*\|\s*LinkedIn.*$/i, "").replace(/\s+/g, " ").trim();
  if (!n || /^linkedin member$/i.test(n)) return false;
  const bits = n.split(/\s+/);
  if (bits.length < 2 || bits.length > 5) return false;
  if (
    /\b(engineer|manager|director|consultant|officer|founder|intern|specialist|analyst|lead|president|partner|head)\b/i.test(
      n,
    )
  )
    return false;
  return bits.every((b) => /^[\p{L}][\p{L}.'’-]*$/u.test(b));
}

function personUrl(row: Record<string, unknown>, slug?: string): string | undefined {
  const raw = firstStr(
    row.linkedinUrl,
    row.linkedin_url,
    row.profileUrl,
    row.profile_url,
    row.navigationUrl,
    row.url,
    row.link,
    row.publicUrl,
  );
  const s = slugFromUrl(raw) || slug || firstStr(row.publicIdentifier, row.public_identifier, row.vanityName, row.profile_id, row.username);
  if (!s || /activity-|pulse-|urn:li/i.test(s) || /^\d+$/.test(s)) {
    return raw && /linkedin\.com\/in\//i.test(raw) ? raw.split("?")[0] : undefined;
  }
  return `https://www.linkedin.com/in/${s}/`;
}

function personName(row: Record<string, unknown>): string | undefined {
  const first = firstStr(row.firstName, row.first_name, isObj(row.name) ? row.name.first : undefined);
  const last = firstStr(row.lastName, row.last_name, isObj(row.name) ? row.name.last : undefined);
  const composed = `${first ?? ""} ${last ?? ""}`.replace(/\s+/g, " ").trim();
  const full = firstStr(
    row.fullName,
    row.full_name,
    isObj(row.name) ? row.name.full : undefined,
    typeof row.name === "string" ? row.name : undefined,
    row.full_name_display,
    composed,
  );
  const titled = looksLikePersonName(firstStr(row.title)) ? firstStr(row.title) : undefined;
  const n = (full || titled || "")
    .replace(/\s*\|\s*LinkedIn.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (n.split(/\s+/).length < 2) return undefined;
  if (/^linkedin member$/i.test(n)) return undefined;
  if (!looksLikePersonName(n) && !full) return undefined;
  return n;
}

function headlineBits(row: Record<string, unknown>): { title?: string; company?: string } {
  const name = personName(row);
  const raw = firstStr(
    row.snippet,
    row.headline,
    row.currentTitle,
    row.current_title,
    row.occupation,
    row.position,
    isObj(row.currentPosition) ? row.currentPosition.title : undefined,
    firstStr(row.title) && firstStr(row.title) !== name ? row.title : undefined,
  );
  const companyHint = firstStr(
    row.currentCompany,
    row.current_company,
    row.companyName,
    row.company_name,
    isObj(row.company) ? row.company.name : undefined,
    isObj(row.currentCompany) ? row.currentCompany.name : undefined,
    isObj(row.currentPosition) ? row.currentPosition.companyName ?? row.currentPosition.company : undefined,
  );
  if (!raw) return { company: companyHint };
  const MEDIA_AT =
    /\b(featured|published|interviewed|quoted|mentioned|appeared|covered)\s+at\b/i;
  const parts = raw
    .split(/\s*[|•/]\s*/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((p) => !MEDIA_AT.test(p) && !/\b(turning data|avid |voracious |open to connect|helping |passionate |love to )\b/i.test(p));
  const primary =
    parts.find((p) =>
      /\b(manager|director|engineer|officer|lead|architect|consultant|analyst|founder|head|specialist|admin)\b/i.test(
        p,
      ),
    ) ||
    parts[0] ||
    raw.replace(/\s+/g, " ").trim();
  const dash = primary.match(
    /^((?:Senior\s+|Jr\.?\s+|Lead\s+|Principal\s+|Staff\s+)?(?:Analyst|Engineer|Manager|Director|Consultant|Writer|Designer|Specialist|Associate|Scientist|Architect|Developer|Officer|Founder|Intern))\s+[-–]\s+(.+)$/i,
  );
  if (dash && dash[2]!.split(/\s+/).length <= 6) {
    return { title: dash[1]!.trim(), company: companyHint || dash[2]!.replace(/\s*[-–|].*$/, "").trim() };
  }
  const at = primary.match(/^(.*?)\s+(?:at|@|·)\s+(.+)$/i);
  if (at && !MEDIA_AT.test(primary)) {
    const co = at[2]!.replace(/\s*[-–|].*$/, "").trim();
    if (co && !/^(linkedin|data science|ai based solutions)$/i.test(co)) {
      return { title: at[1]!.trim() || undefined, company: companyHint || co || undefined };
    }
  }
  return { title: primary.slice(0, 120) || undefined, company: companyHint };
}

function locationOf(row: Record<string, unknown>): string | undefined {
  const loc = firstStr(
    row.locationName,
    row.geoLocationName,
    row.geoRegion,
    isObj(row.location) ? row.location.name ?? row.location.country : undefined,
    typeof row.location === "string" ? row.location : undefined,
    row.geo,
  );
  if (!loc || loc.length > 64) return undefined;
  if (/university|college|school|vidyalaya|linkedin/i.test(loc)) return undefined;
  return loc;
}

function experienceOf(row: Record<string, unknown>): PublicProfile["experience"] {
  const raw = row.experience ?? row.experiences ?? row.positions ?? row.positionHistory;
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<PublicProfile["experience"]> = [];
  for (const x of raw) {
    if (!isObj(x)) continue;
    const company = firstStr(
      x.companyName,
      x.company_name,
      isObj(x.company) ? x.company.name : undefined,
      x.employer,
    );
    const title = firstStr(x.title, x.localizedTitle, x.position);
    const ended = x.ended === true || x.isCurrent === false || x.current === false;
    const end = isObj(x.dateRange) ? x.dateRange.end ?? x.dateRange.endDate : x.endDate ?? x.end;
    const current =
      x.isCurrent === true ||
      x.current === true ||
      (!ended && (end == null || end === ""));
    if (!company && !title) continue;
    out.push({ title: title || undefined, company: company || undefined, current });
    if (out.length >= 8) break;
  }
  return out.length ? out : undefined;
}

export function profileFromApialt(data: unknown, slug: string): PublicProfile | null {
  if (!data) return null;
  const row = isObj(data)
    ? isObj(data.profile)
      ? data.profile
      : isObj(data.data)
        ? (data.data as Record<string, unknown>)
        : data
    : null;
  if (!row) return null;
  const fullName = personName(row);
  if (!fullName) return null;
  const bits = headlineBits(row);
  const exp = experienceOf(row);
  const current = exp?.find((e) => e.current && (e.title || e.company)) ?? exp?.[0];
  const company = bits.company || current?.company;
  const headlineLooksJob =
    bits.title &&
    /\b(manager|director|engineer|officer|lead|architect|consultant|analyst|founder|head|specialist|admin|assurance)\b/i.test(
      bits.title,
    ) &&
    !/\b(helping|passionate|love to|enthusiast)\b/i.test(bits.title);
  const title = (headlineLooksJob ? bits.title : undefined) || current?.title || bits.title;
  const loc = locationOf(row);
  const url = personUrl(row, slug) ?? `https://www.linkedin.com/in/${slug}/`;
  const site = firstStr(
    row.website,
    row.websiteUrl,
    isObj(row.currentCompany) ? row.currentCompany.website : undefined,
    current && isObj(row.company) ? row.company.websiteUrl : undefined,
  );
  const domain =
    site && /\./.test(site) && !/linkedin\.com/i.test(site)
      ? site.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]
      : undefined;
  return {
    fullName,
    title,
    company,
    domain,
    location: loc,
    linkedinUrl: url,
    slug,
    experience: exp,
    source: "apialt",
  };
}

export async function apialtProfile(slugOrUrl: string): Promise<PublicProfile | null> {
  const slug =
    slugFromUrl(slugOrUrl) ||
    slugOrUrl
      .replace(/^https?:\/\/(www\.)?linkedin\.com\/(?:[a-z]{2}\/)?in\//i, "")
      .replace(/\/+$/, "")
      .split(/[?#]/)[0] ||
    "";
  if (!slug) return null;
  const run = await apialtRun("linkedin.profile", { profile_id: slug }, { timeoutMs: 22_000, ttlMs: 20 * 60_000 });
  if (run.ok && run.data) {
    const parsed = profileFromApialt(run.data, slug);
    if (parsed?.fullName) return parsed;
  }
  if (!run.ok && (run.status === 502 || /voyager|scrape/i.test(run.error ?? ""))) {
    return null;
  }
  const main = await apialtRun(
    "linkedin.profile-main",
    { profile_id: slug },
    { timeoutMs: 20_000, ttlMs: 20 * 60_000, retry: false },
  );
  if (main.ok && main.data) return profileFromApialt(main.data, slug);
  return null;
}

export function peopleFromApialt(data: unknown): DiscoverPerson[] {
  const rows = items(data, ["results", "people", "profiles", "leads", "hits", "items", "data"]);
  const out: DiscoverPerson[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const nested = isObj(row.profile) ? row.profile : isObj(row.entity) ? row.entity : row;
    const name = personName(nested);
    if (!name) continue;
    const url = personUrl(nested);
    const slug = slugFromUrl(url) || firstStr(nested.publicIdentifier, nested.vanityName);
    if (!slug || seen.has(slug.toLowerCase())) continue;
    seen.add(slug.toLowerCase());
    const bits = headlineBits(nested);
    const loc = locationOf(nested);
    const href = url ?? `https://www.linkedin.com/in/${slug}/`;
    out.push({
      name,
      title: bits.title,
      company: bits.company,
      location: loc,
      url: href,
      slug,
      linkedinUrl: href,
      source: "apialt",
    });
  }
  return out;
}

export function companiesFromApialt(data: unknown): DiscoverCompany[] {
  const rows = items(data, ["results", "companies", "accounts", "hits", "items", "data"]);
  const out: DiscoverCompany[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = firstStr(
      row.name,
      row.companyName,
      row.company_name,
      isObj(row.company) ? row.company.name : undefined,
      row.title,
    );
    if (!name) continue;
    const url = firstStr(
      row.linkedinUrl,
      row.linkedin_url,
      row.url,
      row.companyUrl,
      row.navigationUrl,
    );
    const slug =
      companySlugFromUrl(url) ||
      firstStr(row.universalName, row.universal_name, row.company_name, row.publicIdentifier);
    const id = firstStr(row.companyId, row.company_id, row.id, row.objectUrn, row.entityUrn)?.match(/(\d{3,})/)?.[1];
    const key = (id || slug || name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const staff = Number(row.staffCount ?? row.headcount ?? row.employeeCount ?? row.staff_count);
    out.push({
      name,
      industry: firstStr(row.industry, row.industryName),
      location: firstStr(
        row.location,
        row.headquarter,
        isObj(row.headquarters) ? row.headquarters.city ?? row.headquarters.country : undefined,
      ),
      url: url && /linkedin\.com\/company\//i.test(url)
        ? url.split("?")[0]!
        : id
          ? `https://www.linkedin.com/company/${id}`
          : slug
            ? `https://www.linkedin.com/company/${slug}`
            : `https://www.linkedin.com/company/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      companyId: id,
      headcount: Number.isFinite(staff) && staff > 0 ? staff : undefined,
    });
  }
  return out;
}

const SIZE_TO_SN: Record<string, string> = {
  A: "self-employed",
  B: "1-10",
  C: "11-50",
  D: "51-200",
  E: "201-500",
  F: "501-1000",
  G: "1001-5000",
  H: "5001-10000",
  I: "10001+",
  "1-10": "1-10",
  "11-50": "11-50",
  "51-200": "51-200",
  "201-500": "201-500",
  "501-1000": "501-1000",
  "1001-5000": "1001-5000",
  "5001-10000": "5001-10000",
  "10001+": "10001+",
};

const REVENUE_TO_SN: Record<string, string> = {
  lt10m: "0-10;USD",
  "10m50m": "10-50;USD",
  "50m250m": "50-250;USD",
  "250m1b": "250-1000;USD",
  "1bplus": "1000-100000;USD",
};

const GROWTH_TO_SN: Record<string, string> = {
  "0to10": "0-10",
  "10to25": "10-25",
  "25plus": "25-200",
};

function csv(parts: Array<string | undefined | null>): string | undefined {
  const s = parts
    .map((x) => (x ?? "").trim())
    .filter(Boolean)
    .join(",");
  return s || undefined;
}

function geoLabel(id?: string): string | undefined {
  if (!id) return undefined;
  return GEO_COUNTRIES.find((g) => g.id === id)?.label;
}

type LiFilters = SalesNavFilters & { domain?: string; companyType?: string };

export function snLeadParams(
  f: LiFilters,
  companyIds: string[],
  limit: number,
): Record<string, unknown> {
  const search = [f.keywords, f.companyKeywords, f.skills].filter(Boolean).join(" ").trim();
  const companies = csv([
    ...companyIds.map((id) =>
      /^\d+$/.test(id) ? `https://www.linkedin.com/company/${id}` : id,
    ),
    f.companyId && !companyIds.includes(f.companyId)
      ? /^\d+$/.test(f.companyId)
        ? `https://www.linkedin.com/company/${f.companyId}`
        : f.companyId
      : undefined,
    f.companyName,
  ]);
  const past = csv([f.pastCompanyId, f.pastCompanyName]);
  const params: Record<string, unknown> = {
    limit: Math.min(Math.max(limit, 1), 100),
  };
  if (search) params.search = search;
  if (f.title) params.currentJobTitles = f.title;
  if (f.pastTitle) params.pastJobTitles = f.pastTitle;
  if (companies) params.currentCompanies = companies;
  if (past) params.pastCompanies = past;
  if (f.firstName) params.firstNames = f.firstName;
  if (f.lastName) params.lastNames = f.lastName;
  if (f.school) params.schools = f.school;
  if (f.language) params.profileLanguages = f.language;
  const geos = csv([f.geoId, f.hqGeoId]);
  if (geos) params.geoIds = geos;
  const loc = csv([geoLabel(f.geoId), geoLabel(f.hqGeoId)]);
  if (loc && !geos) params.locations = loc;
  if (f.industryId) params.industryIds = f.industryId;
  const head = f.sizeId ? SIZE_TO_SN[f.sizeId] : undefined;
  if (head) params.companyHeadcount = head;
  if (f.hiringOnly) params.jobOpportunities = "HIRING_ON_LINKEDIN";
  return params;
}

export function snAccountParams(f: LiFilters, limit: number): Record<string, unknown> {
  const search = [f.keywords, f.companyName, f.companyKeywords, f.domain]
    .filter(Boolean)
    .join(" ")
    .trim();
  const params: Record<string, unknown> = {
    limit: Math.min(Math.max(limit, 1), 50),
  };
  if (search) params.search = search;
  if (f.industryId) params.industryIds = f.industryId;
  if (f.hqGeoId) params.headquarterGeoIds = f.hqGeoId;
  const loc = geoLabel(f.hqGeoId);
  if (loc && !f.hqGeoId) params.headquarterLocations = loc;
  const head = f.sizeId ? SIZE_TO_SN[f.sizeId] : undefined;
  if (head) params.companyHeadcount = head;
  const rev = f.revenueBand ? REVENUE_TO_SN[f.revenueBand] : undefined;
  if (rev) params.annualRevenue = rev;
  const growth = f.growthBand ? GROWTH_TO_SN[f.growthBand] : undefined;
  if (growth) params.companyHeadcountGrowth = growth;
  if (f.hiringOnly) params.jobOpportunities = "HIRING_ON_LINKEDIN";
  return params;
}

export async function apialtLeadSearch(
  f: LiFilters,
  companyIds: string[],
  max = 25,
): Promise<SalesNavResult> {
  const t0 = Date.now();
  const limit = Math.min(Math.max(max, 1), 50);
  const run = await apialtRun("linkedin.sales-nav-lead-search", snLeadParams(f, companyIds, limit), {
    timeoutMs: 55_000,
    ttlMs: 3 * 60_000,
    retry: false,
  });
  if (!run.ok) {
    const q = [f.firstName, f.lastName, f.title, f.keywords, f.companyName].filter(Boolean).join(" ");
    const snOnly = Boolean(f.revenueBand || f.growthBand || f.sizeId || f.hiringOnly);
    if (!q || snOnly) {
      return {
        seat: false,
        total: 0,
        hits: [],
        companies: [],
        detail: `apialt SN ${run.error ?? "failed"}`,
        ms: Date.now() - t0,
      };
    }
    const cheap = await apialtProfileSearch(q, Math.min(limit, 10));
    const hits: SalesNavPerson[] = cheap.map((p) => ({
      name: p.name,
      title: p.title,
      location: p.location,
      url: p.url,
      slug: p.slug,
      company: p.company,
    }));
    return {
      seat: hits.length > 0,
      total: hits.length,
      hits,
      companies: [],
      detail: `apialt SN ${run.error ?? "failed"} · fallback profile-search ${hits.length}`,
      ms: Date.now() - t0,
    };
  }
  const people = peopleFromApialt(run.data);
  const companies = companiesFromApialt(run.data);
  const hits: SalesNavPerson[] = people.map((p) => ({
    name: p.name,
    title: p.title,
    location: p.location,
    url: p.url,
    slug: p.slug,
    company: p.company,
  }));
  return {
    seat: true,
    total: pagingTotal(run.data, hits.length),
    hits,
    companies: companies.map((c) => ({
      name: c.name,
      url: c.url,
      companyId: c.companyId,
    })),
    detail: `apialt SN ${hits.length}/${pagingTotal(run.data, hits.length)} · ${run.credits}cr`,
    ms: Date.now() - t0,
  };
}

export async function apialtProfileSearch(q: string, limit = 10): Promise<DiscoverPerson[]> {
  const query = q.replace(/"/g, "").trim();
  if (query.length < 2) return [];
  const run = await apialtRun(
    "linkedin.profile-search",
    { q: query, limit: Math.min(Math.max(limit, 1), 25) },
    { timeoutMs: 40_000, ttlMs: 5 * 60_000, retry: false },
  );
  if (!run.ok) return [];
  return peopleFromApialt(run.data);
}

/** LinkedIn people search. Keep quotes — `"Company"` beats a loose keyword match. */
export async function apialtSearchPeople(q: string, limit = 15): Promise<DiscoverPerson[]> {
  const query = q.trim();
  if (query.replace(/"/g, "").length < 2) return [];
  const run = await apialtRun(
    "linkedin.search",
    { q: query, category: "people", limit: Math.min(Math.max(limit, 1), 25) },
    { timeoutMs: 40_000, ttlMs: 5 * 60_000, retry: false },
  );
  if (!run.ok) return [];
  return peopleFromApialt(run.data);
}

export async function apialtCompanySearch(q: string, limit = 10): Promise<DiscoverCompany[]> {
  const query = q.replace(/"/g, "").trim();
  if (query.length < 2) return [];
  const run = await apialtRun(
    "linkedin.company-search",
    { q: query, limit: Math.min(Math.max(limit, 1), 25) },
    { timeoutMs: 40_000, ttlMs: 8 * 60_000, retry: false },
  );
  if (!run.ok) return [];
  return companiesFromApialt(run.data);
}

export async function apialtAccountSearch(f: LiFilters, limit = 25): Promise<{
  hits: DiscoverCompany[];
  total: number;
  detail: string;
}> {
  const run = await apialtRun("linkedin.sales-nav-account-search", snAccountParams(f, limit), {
    timeoutMs: 55_000,
    ttlMs: 3 * 60_000,
    retry: false,
  });
  if (!run.ok) {
    const q = [f.keywords, f.companyName, f.domain].filter(Boolean).join(" ");
    const hits = q ? await apialtCompanySearch(q, Math.min(limit, 10)) : [];
    return {
      hits,
      total: hits.length,
      detail: `apialt SN accounts ${run.error ?? "failed"} · fallback company-search ${hits.length}`,
    };
  }
  const hits = companiesFromApialt(run.data);
  return {
    hits,
    total: pagingTotal(run.data, hits.length),
    detail: `apialt SN accounts ${hits.length}/${pagingTotal(run.data, hits.length)} · ${run.credits}cr`,
  };
}

export async function apialtCompany(slugOrName: string): Promise<DiscoverCompany | null> {
  const id = slugOrName
    .replace(/^https?:\/\/(www\.)?linkedin\.com\/(?:[a-z]{2}\/)?company\//i, "")
    .replace(/\/+$/, "")
    .split(/[?#]/)[0]!;
  if (!id) return null;
  const run = await apialtRun("linkedin.company", { company_name: id }, { timeoutMs: 45_000, ttlMs: 30 * 60_000 });
  if (!run.ok || !run.data) return null;
  return companiesFromApialt(run.data)[0] ?? null;
}

export async function apialtLookupPerson(query: string, company?: string): Promise<DiscoverPerson[]> {
  const q = [query, company].filter(Boolean).join(" ").trim();
  return apialtProfileSearch(q, 8);
}
