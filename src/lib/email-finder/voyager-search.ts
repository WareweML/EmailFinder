/**
 * Discover: live people/companies from whatever filters the user typed.
 * LinkedIn data comes from ApiAlt when APIALT_KEY is set. Personal Sales Nav
 * cookies are not sent in that mode.
 */

import { liGet, liSessionStatus, liCircuitOpen, loadLiSession, apialtConfigured } from "./linkedin-http";
import { isDirectorySpam, isPlausibleName } from "./decodo-serp";

export type DiscoverPerson = {
  name: string;
  title?: string;
  location?: string;
  url: string;
  slug: string;
  source?: string;
  company?: string;
  domain?: string;
  linkedinUrl?: string;
  department?: string;
  seniority?: "decision" | "ic";
};

export type DiscoverCompany = {
  name: string;
  industry?: string;
  location?: string;
  url: string;
  companyId?: string;
  headcount?: number;
  headcountGrowthPct?: number;
  growthSource?: string;
  revenueLabel?: string;
  revenueSource?: string;
  jobsOpen?: number;
};

export type DiscoverResult<T> = {
  total: number;
  hits: T[];
  detail: string;
  ms: number;
  session?: { salesNav: "ready" | "paused" | "missing"; reason?: string };
};

export type CompanyFilters = {
  keywords?: string;
  companyName?: string;
  companyId?: string;
  domain?: string;
  industryId?: string;
  sizeId?: string;
  hqGeoId?: string;
  companyType?: string;
  revenueBand?: string;
  growthBand?: string;
  hiringOnly?: boolean;
  skipSignals?: boolean;
  start?: number;
  count?: number;
  pages?: number;
};

export type PeopleFilters = CompanyFilters & {
  firstName?: string;
  lastName?: string;
  title?: string;
  pastTitle?: string;
  skills?: string;
  school?: string;
  language?: string;
  yearsExp?: string;
  tenure?: string;
  pastCompanyId?: string;
  pastCompanyName?: string;
  companyKeywords?: string;
  geoId?: string;
};

function loadSession(): { liAt: string; jsession: string } | null {
  if (liCircuitOpen()) return null;
  return loadLiSession();
}

function splitEmployer(title?: string): { title?: string; company?: string } {
  if (!title) return {};
  const m = title.match(/^(.*?)\s+(?:at|@|·)\s+(.+)$/i);
  if (m) {
    const company = m[2]!.replace(/\s*[-–|].*$/, "").trim();
    if (company && !/linkedin/i.test(company)) {
      return { title: m[1]!.trim() || undefined, company };
    }
  }
  return { title };
}

function asLinkedIn(url?: string): string | undefined {
  if (url && /linkedin\.com\/in\//i.test(url)) return url.split("?")[0];
  return undefined;
}

function keywordNeedles(raw: string): string[] {
  const k = raw.toLowerCase().replace(/"/g, "").trim();
  if (k.length < 2) return [];
  const extra: Record<string, string[]> = {
    marketing: [
      "marketing",
      "marketer",
      "cmo",
      "brand",
      "demand gen",
      "growth marketing",
      "product marketing",
      "digital marketing",
      "content marketing",
    ],
    sales: ["sales", "account executive", "business development", "ae ", "revenue"],
    engineer: ["engineer", "engineering", "developer", "software"],
    design: ["design", "designer", "ux", "ui"],
  };
  const out = new Set<string>([k]);
  for (const [key, syns] of Object.entries(extra)) {
    if (k.includes(key) || key.includes(k)) syns.forEach((s) => out.add(s));
  }
  return [...out];
}

function industryNeedles(label: string): string[] {
  const l = label.toLowerCase();
  if (/real estate/.test(l)) {
    return [
      "real estate",
      "realty",
      "realtor",
      "property",
      "housing",
      "reit",
      "mortgage",
      "broker",
      "leasing",
      "homes",
    ];
  }
  return l
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3);
}

const US_LOC =
  /\b(united states|\busa\b|\bu\.s\.a?\.?\b|,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b)/i;
const NOT_US_LOC =
  /\b(india|mumbai|delhi|bengaluru|bangalore|hyderabad|pune|chennai|kolkata|gurgaon|gurugram|noida|ahmedabad|united kingdom|\buk\b|england|london|australia|sydney|melbourne|brisbane|canada|toronto|vancouver|germany|france|singapore|dubai|uae|china|japan|brazil|mexico)\b/i;

function blobOf(p: DiscoverPerson): string {
  return [p.title, p.department, p.company, p.location, p.domain, p.name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function includesCI(hay: string | undefined, needle: string): boolean {
  return (hay ?? "").toLowerCase().includes(needle.toLowerCase().trim());
}

function locationMatchesCountry(loc: string, country: string): boolean {
  if (!loc) return false;
  if (/united states|^us$/i.test(country)) return US_LOC.test(loc);
  const aliases: Record<string, RegExp> = {
    "United Kingdom":
      /\b(united kingdom|\buk\b|england|scotland|wales|london|manchester)\b/i,
    India:
      /\b(india|mumbai|delhi|bengaluru|bangalore|hyderabad|pune|chennai|kolkata|gurgaon|gurugram)\b/i,
    Australia: /\b(australia|sydney|melbourne|brisbane|perth|adelaide)\b/i,
    Canada: /\b(canada|toronto|vancouver|montreal|ottawa)\b/i,
    Germany: /\b(germany|berlin|munich|hamburg|frankfurt)\b/i,
    France: /\b(france|paris|lyon|marseille)\b/i,
    Singapore: /\bsingapore\b/i,
    "United Arab Emirates": /\b(uae|dubai|abu dhabi|united arab emirates)\b/i,
  };
  if (aliases[country]?.test(loc)) return true;
  return loc.toLowerCase().includes(country.toLowerCase());
}

function matchesDiscoverFilters(
  p: DiscoverPerson,
  f: PeopleFilters,
  labels: { personGeo?: string; hqGeo?: string; industry?: string },
): boolean {
  const text = blobOf(p);
  const name = (p.name ?? "").toLowerCase();
  const parts = name.split(/\s+/).filter(Boolean);

  if (f.firstName) {
    const fn = f.firstName.toLowerCase().trim();
    if (parts[0] !== fn && !name.startsWith(fn)) return false;
  }
  if (f.lastName) {
    const ln = f.lastName.toLowerCase().trim();
    if (parts[parts.length - 1] !== ln && !name.endsWith(ln)) return false;
  }
  if (f.title && !includesCI(p.title, f.title)) return false;
  if (f.keywords) {
    const needles = keywordNeedles(f.keywords);
    const field =
      `${p.name ?? ""} ${p.title ?? ""} ${p.company ?? ""} ${p.department ?? ""}`.toLowerCase();
    const tokens = f.keywords
      .toLowerCase()
      .replace(/"/g, "")
      .split(/\s+/)
      .filter((t) => t.length > 1);
    const name = (p.name ?? "").toLowerCase();
    const nameHits = tokens.filter((t) => name.split(/\s+/).includes(t));
    const ok =
      nameHits.length >= 2 ||
      needles.some((n) => n.length > 1 && field.includes(n));
    if (!ok) return false;
  }
  if (f.companyName && !includesCI(p.company, f.companyName)) return false;
  if (f.domain) {
    const d = f.domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]!;
    if ((p.domain ?? "").toLowerCase() !== d && !includesCI(p.company, d.split(".")[0]!)) {
      return false;
    }
  }
  if (f.companyKeywords && !includesCI(p.company, f.companyKeywords)) return false;
  if (labels.industry) {
    const needles = industryNeedles(labels.industry);
    const field = `${p.company ?? ""} ${p.title ?? ""} ${p.domain ?? ""}`.toLowerCase();
    if (!needles.some((n) => field.includes(n))) return false;
  }
  if (labels.personGeo) {
    const loc = (p.location ?? "").trim();
    if (loc && !locationMatchesCountry(loc, labels.personGeo)) return false;
    if (!loc && /united states|^us$/i.test(labels.personGeo) && NOT_US_LOC.test(text)) {
      return false;
    }
  }
  if (labels.hqGeo) {
    const loc = (p.location ?? "").trim();
    if (/united states|^us$/i.test(labels.hqGeo)) {
      if (loc) {
        if (!locationMatchesCountry(loc, "United States")) return false;
      } else if (NOT_US_LOC.test(text) && !US_LOC.test(text)) {
        return false;
      } else if (/\.in$|\.co\.uk$|\.com\.au$|\.co\.in$/i.test(p.domain ?? "")) {
        return false;
      }
    } else if (loc && !locationMatchesCountry(loc, labels.hqGeo) && !text.includes(labels.hqGeo.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function peopleQueryText(f: PeopleFilters): string {
  return [
    f.keywords,
    f.title,
    f.pastTitle,
    f.firstName && f.lastName
      ? `${f.firstName} ${f.lastName}`
      : f.firstName || f.lastName,
    f.skills,
    f.school,
    f.companyKeywords,
  ]
    .map((s) => (s ?? "").replace(/"/g, "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function facetList(key: string, ids: Array<string | undefined>) {
  const clean = ids.filter((x): x is string =>
    Boolean(x && /^\d+$|^[A-I]$|^[a-z]{2}$/.test(x)),
  );
  if (!clean.length) return "";
  return `${key}:List(${clean.join(",")})`;
}

async function clusters(
  keywords: string,
  facets: string,
  opts: { count: number; start: number; people: boolean },
): Promise<{ total: number; included: Array<Record<string, unknown>>; status: number }> {
  const sess = loadSession();
  if (!sess) return { total: 0, included: [], status: 0 };
  const kw = keywords.replace(/[()]/g, " ").trim();
  const kwPart = kw ? `keywords:${encodeURIComponent(kw)},` : "";
  const query = `(${kwPart}flagshipSearchIntent:SEARCH_SRP,queryParameters:(${facets}),includeFiltersInResponse:false)`;
  const path = opts.people
    ? "https://www.linkedin.com/voyager/api/search/dash/clusters"
    : "https://www.linkedin.com/voyager/api/search/dash/clusters";
  const url =
    path +
    `?decorationId=com.linkedin.voyager.dash.deco.search.SearchClusterCollection-174` +
    `&origin=GLOBAL_SEARCH_HEADER&q=all&query=${encodeURIComponent(query)}` +
    `&start=${opts.start}&count=${opts.count}`;
  const res = await liGet(url, "https://www.linkedin.com/search/results/people/");
  if (res.status !== 200) return { total: 0, included: [], status: res.status };
  try {
    const j = JSON.parse(res.body) as {
      data?: { paging?: { total?: number } };
      included?: Array<Record<string, unknown>>;
    };
    return {
      total: j.data?.paging?.total ?? 0,
      included: j.included ?? [],
      status: 200,
    };
  } catch {
    return { total: 0, included: [], status: res.status };
  }
}

function parsePeople(included: Array<Record<string, unknown>>): DiscoverPerson[] {
  const out: DiscoverPerson[] = [];
  const seen = new Set<string>();
  for (const x of included) {
    const first = String(x.firstName ?? "");
    const last = String(x.lastName ?? "");
    const name = `${first} ${last}`.trim();
    if (name.split(/\s+/).length < 2 || /^linkedin member$/i.test(name)) continue;
    const href = String(x.navigationUrl ?? x.profileUrl ?? x.url ?? "");
    const slugM = href.match(/linkedin\.com\/in\/([a-zA-Z0-9_%\-]+)/i);
    const slug =
      (slugM ? decodeURIComponent(slugM[1]!) : "") ||
      name.toLowerCase().replace(/[^a-z]+/g, "-");
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      name,
      title: typeof x.headline === "string" ? x.headline : undefined,
      location:
        typeof x.geoLocationName === "string" ? x.geoLocationName : undefined,
      url: slugM ? href.split("?")[0]! : `https://www.linkedin.com/in/${slug}/`,
      slug,
      source: "linkedin",
    });
  }
  return out;
}

function parseCompanies(included: Array<Record<string, unknown>>): DiscoverCompany[] {
  const out: DiscoverCompany[] = [];
  const seen = new Set<string>();
  for (const x of included) {
    const name = String(x.name ?? x.companyName ?? "");
    if (!name) continue;
    const id = String(x.entityUrn ?? x.objectUrn ?? "").match(/(\d{3,})/)?.[1];
    const key = id || name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      industry: typeof x.industry === "string" ? x.industry : undefined,
      location: typeof x.location === "string" ? x.location : undefined,
      url: id
        ? `https://www.linkedin.com/company/${id}`
        : `https://www.linkedin.com/company/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      companyId: id,
    });
  }
  return out;
}

async function pool<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length || 1) }, async () => {
      while (i < items.length) {
        const item = items[i++]!;
        out.push(await fn(item));
      }
    }),
  );
  return out;
}

async function resolveCompanyId(nameOrDomain?: string): Promise<string | undefined> {
  const q = nameOrDomain?.trim();
  if (!q) return undefined;
  if (/^\d+$/.test(q)) return q;
  const brand = q.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? q;
  const raw = await clusters(
    brand.replace(/\.[a-z]{2,}$/i, " ") + " " + brand,
    "resultType:List(COMPANIES)",
    { count: 5, start: 0, people: false },
  );
  return parseCompanies(raw.included).find((c) => c.companyId)?.companyId;
}

export async function discoverCompanies(
  f: CompanyFilters,
): Promise<DiscoverResult<DiscoverCompany>> {
  const t0 = Date.now();
  if (apialtConfigured()) {
    const needsSn = Boolean(f.revenueBand || f.growthBand || f.sizeId || f.hiringOnly);
    const { apialtAccountSearch, apialtCompanySearch } = await import("./apialt");
    const q = [f.keywords, f.companyName, f.domain].filter(Boolean).join(" ");
    const pack = needsSn
      ? await apialtAccountSearch(f, Math.min(f.count ?? 25, 25))
      : { hits: q ? await apialtCompanySearch(q, f.count ?? 10) : [], total: 0, detail: "apialt company-search" };
    return {
      total: Math.max(pack.total, pack.hits.length),
      hits: pack.hits,
      detail: pack.detail,
      ms: Date.now() - t0,
      session: liSessionStatus(),
    };
  }
  const kw = [f.keywords, f.companyName, f.domain].filter(Boolean).join(" ");
  const facets = [
    "resultType:List(COMPANIES)",
    facetList("industryCompany", [f.industryId]),
    facetList("companySize", [f.sizeId]),
    f.hqGeoId ? `geoUrn:List(${f.hqGeoId})` : "",
  ]
    .filter(Boolean)
    .join(",");
  const pages = Math.min(Math.max(f.pages ?? 3, 1), 8);
  const count = f.count ?? 10;
  const jobs = Array.from({ length: pages }, (_, i) => i);
  const rows = await pool(jobs, 2, (i) =>
    clusters(kw, facets, { count, start: (f.start ?? 0) + i * count, people: false }),
  );
  const seen = new Set<string>();
  const hits: DiscoverCompany[] = [];
  let total = 0;
  for (const r of rows) {
    if (r.total > total) total = r.total;
    for (const h of parseCompanies(r.included)) {
      const key = h.companyId || h.url;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(h);
    }
  }
  return {
    total: Math.max(total, hits.length),
    hits,
    detail: `companies ${hits.length}/${total}`,
    ms: Date.now() - t0,
  };
}

export async function discoverPeople(
  f: PeopleFilters,
): Promise<DiscoverResult<DiscoverPerson>> {
  const t0 = Date.now();
  const q = peopleQueryText(f);
  const { GEO_COUNTRIES, INDUSTRIES } = await import("./linkedin-facets");
  const geo =
    GEO_COUNTRIES.find((g) => g.id === f.hqGeoId)?.label ?? "";
  const personGeo =
    GEO_COUNTRIES.find((g) => g.id === f.geoId)?.label ?? "";
  const industryLabel =
    INDUSTRIES.find((i) => i.id === f.industryId)?.label ?? "";

  const pinCompany = Boolean(f.companyId || f.companyName || f.domain) && !f.industryId;
  let matchedCompanies: DiscoverCompany[] = [];
  let companyIds: string[] = [];
  if (pinCompany && (f.companyId || f.companyName || f.domain)) {
    const id =
      f.companyId?.trim() ||
      (apialtConfigured() ? undefined : await resolveCompanyId(f.companyName || f.domain));
    if (id) {
      companyIds = [id];
      matchedCompanies = [
        {
          name: f.companyName || f.domain || id,
          url: `https://www.linkedin.com/company/${id}`,
          companyId: id,
        },
      ];
    }
  }

  const byName = new Map<string, DiscoverPerson>();
  const seenSlug = new Set<string>();
  const add = (h: DiscoverPerson) => {
    if (!isPlausibleName(h.name) || isDirectorySpam(`${h.name} ${h.title ?? ""} ${h.company ?? ""}`, h.url)) return;
    const li = h.linkedinUrl || h.url || "";
    if (!/linkedin\.com\/in\//i.test(li)) return;
    if (/contactout|rocketreach|zoominfo|signalhire|apollo/i.test(`${h.company ?? ""} ${h.title ?? ""}`)) return;
    if (seenSlug.has(h.slug)) return;
    seenSlug.add(h.slug);
    const key = h.name
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .slice(0, 3)
      .join(" ");
    if (!key) return;
    const prev = byName.get(key);
    if (!prev) {
      byName.set(key, h);
      return;
    }
    const rank: Record<string, number> = { apialt: 5, linkedin: 4, google: 3, bing: 3, theorg: 2 };
    if ((rank[h.source ?? ""] ?? 1) > (rank[prev.source ?? ""] ?? 1)) {
      byName.set(key, {
        ...h,
        title: h.title || prev.title,
        location: h.location || prev.location,
        company: h.company || prev.company,
        domain: h.domain || prev.domain,
        linkedinUrl: h.linkedinUrl || prev.linkedinUrl,
      });
    } else {
      prev.title = prev.title || h.title;
      prev.location = prev.location || h.location;
      prev.company = prev.company || h.company;
      prev.domain = prev.domain || h.domain;
      prev.linkedinUrl = prev.linkedinUrl || h.linkedinUrl;
    }
  };

  let total = 0;
  let navDetail = "";
  let orgN = 0;
  let googleN = 0;
  let extraN = 0;

  const needsSalesNav = Boolean(f.revenueBand || f.growthBand || f.sizeId || f.hiringOnly);
  const session = liSessionStatus();
  const viaApialt = apialtConfigured();
  const snOk = session.salesNav === "ready";
  const pausedReason =
    session.reason ||
    "Sales Nav is paused. Cookies are not being sent. Log in from the pinned SOCKS IP and paste a fresh li_at / li_a / JSESSIONID.";

  if (viaApialt) {
    const { apialtLeadSearch } = await import("./apialt");
    let navDetail = "";
    let total = 0;
    if (needsSalesNav || pinCompany || f.companyId) {
      const sn = await apialtLeadSearch(f, companyIds, 25);
      navDetail = sn.detail;
      total = sn.total;
      for (const h of sn.hits) {
        const split = splitEmployer(h.title);
        add({
          name: h.name,
          title: split.title || h.title,
          location: h.location,
          url: h.url,
          slug: h.slug,
          company: h.company || split.company,
          linkedinUrl: asLinkedIn(h.url),
          source: "apialt",
        });
      }
    } else {
      const qText = [q, f.title, f.firstName, f.lastName, f.companyName].filter(Boolean).join(" ");
      if (!qText) {
        return {
          total: 0,
          hits: [],
          detail: "Add a title, name, company, or keyword. LinkedIn search now runs through ApiAlt — no personal cookies.",
          ms: Date.now() - t0,
          session,
        };
      }
      const { apialtRun, peopleFromApialt } = await import("./apialt");
      const run = await apialtRun("linkedin.profile-search", { q: qText, limit: 15 }, {
        timeoutMs: 25_000,
        ttlMs: 5 * 60_000,
        retry: false,
      });
      const hits = run.ok ? peopleFromApialt(run.data) : [];
      navDetail = run.ok
        ? `apialt profile-search ${hits.length} · ${run.credits}cr`
        : `apialt profile-search failed: ${run.error ?? "no data"}`;
      total = hits.length;
      for (const h of hits) add({ ...h, source: "apialt" });
    }
    const named = [...byName.values()];
    const { departmentOf, isDecisionTitle } = await import("./linkedin-company");
    for (const h of named) {
      h.department = departmentOf(h.title);
      h.seniority = isDecisionTitle(h.title) ? "decision" : "ic";
    }
    const { fillCompanyDomains } = await import("./linkedin-public");
    const filled = await fillCompanyDomains(named, 12_000);
    const kept = filled.filter((p) =>
      matchesDiscoverFilters(p, f, {
        personGeo,
        hqGeo: geo,
        industry: industryLabel,
      }),
    );
    return {
      total: Math.max(total, kept.length),
      hits: kept,
      detail: `apialt ${kept.length}` + (q ? ` · q="${q}"` : "") + (navDetail ? ` · ${navDetail}` : ""),
      ms: Date.now() - t0,
      session,
    };
  }

  if (!snOk && needsSalesNav) {
    return {
      total: 0,
      hits: [],
      detail: pausedReason,
      ms: Date.now() - t0,
      session,
    };
  }

  if (!snOk && !pinCompany && !q && !f.title) {
    return {
      total: 0,
      hits: [],
      detail: `${pausedReason} Add a job title or company to search public LinkedIn cards, or restore Sales Nav for revenue / size filters.`,
      ms: Date.now() - t0,
      session,
    };
  }

  const [sn, orgPack, gPack, extraPack] = await Promise.all([
    (async () => {
      try {
        if (!snOk) return null;
        const { farmReady } = await import("./sn-farm");
        const { salesNavLeadSearch } = await import("./sales-nav");
        const cap = farmReady() ? 2500 : 50;
        return await salesNavLeadSearch(f, companyIds, cap);
      } catch {
        return null;
      }
    })(),
    (async () => {
      if (!snOk) return [];
      try {
        const { theorgDiscover } = await import("./theorg-people");
        return await theorgDiscover({
          keywords: q,
          companyName: pinCompany ? f.companyName : undefined,
          domain: pinCompany ? f.domain : undefined,
          industryLabel,
          geoLabel: geo || personGeo,
          title: f.title,
        });
      } catch {
        return [];
      }
    })(),
    (async () => {
      try {
        const { liveLinkedInByFilters, xrayPeopleAtCompanies } = await import(
          "./decodo-serp"
        );
        if (pinCompany && (f.companyName || matchedCompanies.length)) {
          const names = matchedCompanies.length
            ? matchedCompanies
            : [{ name: f.companyName! }];
          return await xrayPeopleAtCompanies(names, geo);
        }
        if (!snOk) return [];
        if (!q && !f.title) return [];
        return await liveLinkedInByFilters({
          keywords: q,
          title: f.title,
          geo: personGeo || geo,
          industry: industryLabel,
        });
      } catch {
        return [];
      }
    })(),
    (async () => {
      if (!snOk) return [];
      try {
        const { extraPeople } = await import("./extra-people");
        return await extraPeople({
          keywords: q,
          title: f.title,
          geo: personGeo || geo,
          industry: industryLabel,
        });
      } catch {
        return [];
      }
    })(),
  ]);

  if (sn?.seat) {
    navDetail = sn.detail;
    total = sn.total;
    for (const h of sn.hits) {
      const split = splitEmployer(h.title);
      add({
        ...h,
        title: split.title || h.title,
        company: h.company || split.company,
        linkedinUrl: asLinkedIn(h.url),
        source: "linkedin",
      });
    }
  }

  for (const h of orgPack) {
    add({
      name: h.name,
      title: h.title,
      location: h.location,
      url: h.linkedinUrl || h.url,
      slug: h.slug,
      source: "theorg",
      company: h.company,
      domain: h.domain,
      linkedinUrl: h.linkedinUrl,
    });
    orgN++;
  }
  for (const h of gPack) {
    const split = splitEmployer(h.title);
    add({
      name: h.name,
      title: split.title || h.title,
      location: h.location,
      url: h.url,
      slug: h.slug,
      source: "linkedin",
      company: h.company || split.company,
      linkedinUrl: h.linkedinUrl || asLinkedIn(h.url),
    });
    googleN++;
  }
  for (const h of extraPack) {
    const split = splitEmployer(h.title);
    add({
      name: h.name,
      title: split.title || h.title,
      location: h.location,
      url: h.url,
      slug: h.slug,
      source: h.source,
      company: h.company || split.company,
      linkedinUrl: asLinkedIn(h.url) || h.linkedinUrl,
    });
    extraN++;
  }

  const hits = [...byName.values()];
  const { departmentOf, isDecisionTitle } = await import("./linkedin-company");
  for (const h of hits) {
    h.department = departmentOf(h.title);
    h.seniority = isDecisionTitle(h.title) ? "decision" : "ic";
  }
  const { fillCompanyDomains } = await import("./linkedin-public");
  const filled = await fillCompanyDomains(hits, 12_000);
  const kept = filled.filter((p) =>
    matchesDiscoverFilters(p, f, {
      personGeo,
      hqGeo: geo,
      industry: industryLabel,
    }),
  );
  let detail =
    `live ${kept.length}` +
    (q ? ` · q="${q}"` : "") +
    (geo ? ` · ${geo}` : "") +
    (industryLabel ? ` · ${industryLabel}` : "") +
    (navDetail ? ` · ${navDetail}` : "") +
    ` · theorg ${orgN} · linkedin-serp ${googleN} · extra ${extraN}`;
  if (session.salesNav !== "ready") {
    detail = `${session.reason ?? "Sales Nav is not live."} ${detail}`;
  } else if (needsSalesNav && !sn?.hits.length) {
    detail = "Revenue / size / growth filters need Sales Nav. " + detail;
  }
  return {
    total: Math.max(total, kept.length),
    hits: kept,
    detail,
    ms: Date.now() - t0,
    session,
  };
}

export async function discoverCount(
  kind: "companies" | "people",
  filters: CompanyFilters & PeopleFilters,
): Promise<{ total: number; ms: number; detail: string }> {
  if (kind === "companies") {
    const r = await discoverCompanies({ ...filters, pages: 1, count: 1, skipSignals: true });
    return { total: r.total, ms: r.ms, detail: r.detail };
  }
  const t0 = Date.now();
  const r = await discoverPeople({ ...filters, pages: 1 });
  return { total: r.total, ms: Date.now() - t0, detail: r.detail };
}
