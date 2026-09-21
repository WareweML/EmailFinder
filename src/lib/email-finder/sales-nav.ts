/**
 * LinkedIn Sales Navigator lead search.
 * Prefers ApiAlt when APIALT_KEY is set (no personal cookies).
 * Cookie path is fail-closed: never sent if ApiAlt is configured.
 */

import { loadLiSession, restLiQuery } from "./linkedin-http";

export type SalesNavPerson = {
  name: string;
  title?: string;
  location?: string;
  url: string;
  slug: string;
  company?: string;
};

export type SalesNavFilters = {
  keywords?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  pastTitle?: string;
  companyKeywords?: string;
  companyName?: string;
  companyId?: string;
  pastCompanyId?: string;
  pastCompanyName?: string;
  school?: string;
  language?: string;
  skills?: string;
  hqGeoId?: string;
  geoId?: string;
  sizeId?: string;
  industryId?: string;
  revenueBand?: string;
  growthBand?: string;
  hiringOnly?: boolean;
};

function txt(v: unknown): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v && "text" in v) {
    return (v as { text?: string }).text || undefined;
  }
  return undefined;
}

function headers(sess: { liAt: string; jsession: string; liA?: string }) {
  const lia = sess.liA ? ` li_a=${sess.liA};` : "";
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/vnd.linkedin.normalized+json+2.1",
    "csrf-token": sess.jsession,
    "x-restli-protocol-version": "2.0.0",
    "x-li-lang": "en_US",
    "x-li-page-instance": "urn:li:page:d_sales2_search_people_boot",
    Referer: "https://www.linkedin.com/sales/search/people",
    Cookie: `li_at=${sess.liAt};${lia} JSESSIONID="${sess.jsession}"; liap=true`,
  };
}

function filterClause(type: string, id: string, text?: string) {
  const t = text ? `,text:${JSON.stringify(text)}` : "";
  return `(type:${type},values:List((id:${id}${t},selectionType:INCLUDED)))`;
}

/** Sales Nav industry IDs (not the same as Voyager SRP). */
const SN_INDUSTRY: Record<string, { id: string; text: string }> = {
  "52": { id: "1999", text: "Education" },
  "68": { id: "1999", text: "Education" },
  "1999": { id: "1999", text: "Education" },
  "44": { id: "44", text: "Real Estate" },
  "47": { id: "47", text: "Accounting" },
  "96": { id: "96", text: "IT Services" },
};

export function salesNavQuery(f: SalesNavFilters, companyIds: string[]): string {
  const filters: string[] = [];
  for (const id of companyIds.slice(0, 10)) {
    filters.push(
      filterClause("CURRENT_COMPANY", `urn:li:organization:${id}`),
    );
  }
  if (f.hqGeoId) {
    filters.push(filterClause("REGION", f.hqGeoId));
  }
  if (f.geoId && f.geoId !== f.hqGeoId) {
    filters.push(filterClause("REGION", f.geoId));
  }
  if (f.sizeId) {
    filters.push(filterClause("COMPANY_HEADCOUNT", f.sizeId));
  }
  if (f.industryId) {
    const ind = SN_INDUSTRY[f.industryId] ?? {
      id: f.industryId,
      text: f.industryId,
    };
    filters.push(filterClause("INDUSTRY", ind.id, ind.text));
  }
  if (f.title) {
    filters.push(
      `(type:CURRENT_TITLE,values:List((text:${JSON.stringify(f.title)},selectionType:INCLUDED)))`,
    );
  }
  const kw = [f.keywords, f.firstName, f.lastName, f.companyKeywords]
    .filter(Boolean)
    .join(" ")
    .replace(/[()]/g, " ")
    .trim();
  const parts = ["recentSearchParam:(id:0,doLogHistory:!f)"];
  if (kw) parts.push(`keywords:${JSON.stringify(kw)}`);
  parts.push(`filters:List(${filters.join(",")})`);
  return `(${parts.join(",")})`;
}

function parseLeads(included: Array<Record<string, unknown>>): SalesNavPerson[] {
  const hits: SalesNavPerson[] = [];
  const seen = new Set<string>();
  for (const x of included) {
    const t = String(x.$type ?? "");
    const first = String(x.firstName ?? x.givenName ?? "");
    const last = String(x.lastName ?? x.familyName ?? "");
    const composed = `${first} ${last}`.trim();
    const name =
      composed.split(" ").length >= 2
        ? composed
        : txt(x.fullName) || txt(x.title) || txt(x.name);
    if (!name || /^linkedin member$/i.test(name) || name.split(/\s+/).length < 2) {
      continue;
    }
    const href = String(
      x.navigationUrl ?? x.profileUrl ?? x.url ?? x.entityUrn ?? "",
    );
    const slugM = href.match(/linkedin\.com\/in\/([a-zA-Z0-9_%\-]+)/i);
    const urnM = String(x.entityUrn ?? x.trackingUrn ?? "").match(
      /fsd_profile:([A-Za-z0-9_\-]+)/,
    );
    const slug =
      (slugM ? decodeURIComponent(slugM[1]!) : undefined) ||
      (urnM ? urnM[1] : name.toLowerCase().replace(/[^a-z]+/g, "-"));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const positions = (x.currentPositions ?? x.currentPosition) as
      | { title?: unknown; companyName?: unknown }[]
      | { title?: unknown; companyName?: unknown }
      | undefined;
    const pos = Array.isArray(positions) ? positions[0] : positions;
    const company =
      txt(pos?.companyName) ||
      (typeof x.companyName === "string" ? x.companyName : undefined);
    const title =
      txt(pos?.title) ||
      txt(x.headline) ||
      txt(x.primarySubtitle) ||
      (typeof x.currentTitle === "string" ? x.currentTitle : undefined);
    const location =
      txt(x.geoRegion) ||
      txt(x.location) ||
      txt(x.secondarySubtitle);
    hits.push({
      name,
      title,
      location,
      company,
      url: slugM
        ? href.split("?")[0]!
        : `https://www.linkedin.com/in/${slug}/`,
      slug,
    });
  }
  return hits;
}

export type SalesNavCompany = {
  name: string;
  industry?: string;
  location?: string;
  url: string;
  companyId?: string;
};

function parseCompanies(
  included: Array<Record<string, unknown>>,
): SalesNavCompany[] {
  const out: SalesNavCompany[] = [];
  const seen = new Set<string>();
  for (const x of included) {
    if (!String(x.$type ?? "").includes("sales.company.Company")) continue;
    const name = String(x.name ?? x.companyName ?? "");
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const id = String(x.entityUrn ?? x.objectUrn ?? "").match(/(\d{3,})/)?.[1];
    out.push({
      name,
      industry: typeof x.industry === "string" ? x.industry : undefined,
      location: txt(x.location) || txt(x.geoRegion),
      url: id
        ? `https://www.linkedin.com/sales/company/${id}`
        : `https://www.linkedin.com/company/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      companyId: id,
    });
  }
  return out;
}

async function page(
  _sess: { liAt: string; jsession: string; liA?: string },
  query: string,
  start: number,
  count: number,
): Promise<{ status: number; total: number; included: Array<Record<string, unknown>> }> {
  const { liGet } = await import("./linkedin-http");
  const url =
    "https://www.linkedin.com/sales-api/salesApiLeadSearch" +
    `?q=searchQuery&query=${restLiQuery(query)}` +
    `&start=${start}&count=${count}&decorationId=com.linkedin.sales.deco.desktop.searchv2.LeadSearchResult-14`;
  const res = await liGet(url, "https://www.linkedin.com/sales/search/people");
  if (res.status !== 200) {
    return { status: res.status, total: 0, included: [] };
  }
  try {
    const j = JSON.parse(res.body) as {
      data?: {
        paging?: { total?: number };
        metadata?: { totalCount?: number; totalDisplayCount?: string };
      };
      included?: Array<Record<string, unknown>>;
    };
    const total = j.data?.paging?.total ?? j.data?.metadata?.totalCount ?? 0;
    return { status: 200, total, included: j.included ?? [] };
  } catch {
    return { status: res.status, total: 0, included: [] };
  }
}

export type SalesNavResult = {
  seat: boolean;
  total: number;
  hits: SalesNavPerson[];
  companies: SalesNavCompany[];
  detail: string;
  ms: number;
};

/** Page Sales Nav. ApiAlt first; personal cookies only if no API key. */
export async function salesNavLeadSearch(
  f: SalesNavFilters,
  companyIds: string[] = [],
  max = 2500,
): Promise<SalesNavResult> {
  const { apialtEnabled, apialtLeadSearch } = await import("./apialt");
  if (apialtEnabled()) {
    return apialtLeadSearch(f, companyIds, Math.min(max, 50));
  }
  const t0 = Date.now();
  const sess = loadLiSession();
  if (!sess) {
    return { seat: false, total: 0, hits: [], companies: [], detail: "no cookie", ms: 0 };
  }
  const query = salesNavQuery(f, companyIds);
  const first = await page(sess, query, 0, 25);
  if (first.status === 403) {
    return {
      seat: false,
      total: 0,
      hits: [],
      companies: [],
      detail: "SALES_SEAT_REQUIRED — paste li_at from the Sales Nav tab",
      ms: Date.now() - t0,
    };
  }
  if (first.status !== 200) {
    return {
      seat: false,
      total: 0,
      hits: [],
      companies: [],
      detail: `sales-nav ${first.status}`,
      ms: Date.now() - t0,
    };
  }
  const seen = new Set<string>();
  const hits: SalesNavPerson[] = [];
  const add = (rows: SalesNavPerson[]) => {
    for (const h of rows) {
      if (seen.has(h.slug)) continue;
      seen.add(h.slug);
      hits.push(h);
    }
  };
  add(parseLeads(first.included));
  const companies = parseCompanies(first.included);
  const total = Math.min(first.total || max, max);
  const starts: number[] = [];
  for (let s = 25; s < total && s < max; s += 25) starts.push(s);
  let i = 0;
  const width = 3;
  await Promise.all(
    Array.from({ length: Math.min(width, starts.length) }, async () => {
      while (i < starts.length && hits.length < max) {
        const start = starts[i++]!;
        const p = await page(sess, query, start, 25);
        if (p.status !== 200) break;
        add(parseLeads(p.included));
      }
    }),
  );
  return {
    seat: true,
    total: first.total,
    hits: hits.slice(0, max),
    companies,
    detail: `sales nav ${hits.length}/${first.total}`,
    ms: Date.now() - t0,
  };
}
