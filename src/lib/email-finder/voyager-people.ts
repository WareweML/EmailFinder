/**
 * Logged-in Voyager: company skeleton (staffCount) then people fill.
 */

import { readFileSync, writeFileSync } from "node:fs";

const SESSION_FILE = "/workspace/data/li-session.json";

function loadSession(): { liAt: string; jsession: string } | null {
  if (process.env.LI_USE_SESSION !== "1") return null;
  const liAt = process.env.LI_AT;
  const jsession = process.env.LI_JSESSIONID;
  if (liAt && jsession) return { liAt, jsession };
  try {
    const j = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as {
      liAt?: string;
      jsession?: string;
    };
    if (j.liAt && j.jsession) return { liAt: j.liAt, jsession: j.jsession };
  } catch {
    /* none */
  }
  return null;
}

export function saveLiSession(liAt: string, jsession: string) {
  writeFileSync(
    SESSION_FILE,
    JSON.stringify({ liAt, jsession, at: Date.now() }),
  );
}

function headers(sess: { liAt: string; jsession: string }, referer: string) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/vnd.linkedin.normalized+json+2.1",
    "csrf-token": sess.jsession,
    "x-restli-protocol-version": "2.0.0",
    Referer: referer,
    Cookie: `li_at=${sess.liAt}; JSESSIONID=${sess.jsession}`,
  };
}

function txt(v: unknown): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v && "text" in v) {
    return (v as { text?: string }).text || undefined;
  }
  return undefined;
}

function slugFromUrl(url: string): string | null {
  const m = url.match(/linkedin\.com\/in\/([a-zA-Z0-9_%\-]+)/i);
  if (!m) return null;
  return decodeURIComponent(m[1]!);
}

export type VoyagerHit = {
  name: string;
  title?: string;
  location?: string;
  slug: string;
  url: string;
  total?: number;
};

export type VoyagerCompany = {
  name: string;
  staffCount: number;
  staffCountRangeStart?: number;
  industry?: string;
  hq?: string;
  website?: string;
  universalName?: string;
  employeeSearchUrl?: string;
};

export async function voyagerCompany(
  companyId: string,
): Promise<VoyagerCompany | null> {
  const sess = loadSession();
  if (!sess) return null;
  const { liGet } = await import("./linkedin-http");
  const res = await liGet(
    `https://www.linkedin.com/voyager/api/organization/companies/${encodeURIComponent(companyId)}`,
    "https://www.linkedin.com/company/",
  );
  if (res.status !== 200) return null;
  const j = JSON.parse(res.body) as {
    data?: Record<string, unknown>;
    included?: Array<Record<string, unknown>>;
  };
  const d = j.data ?? {};
  const hq = d.headquarter as { city?: string; country?: string } | undefined;
  const range = d.staffCountRange as { start?: number } | undefined;
  const industry = (j.included ?? []).find((x) =>
    String(x.$type ?? "").includes("Industry"),
  )?.localizedName as string | undefined;
  const staff = Number(d.staffCount);
  if (!staff && !d.name) return null;
  return {
    name: String(d.name ?? ""),
    staffCount: staff || 0,
    staffCountRangeStart: range?.start,
    industry,
    hq: [hq?.city, hq?.country].filter(Boolean).join(", ") || undefined,
    website: typeof d.companyPageUrl === "string" ? d.companyPageUrl : undefined,
    universalName:
      typeof d.universalName === "string" ? d.universalName : undefined,
    employeeSearchUrl:
      typeof d.companyEmployeesSearchPageUrl === "string"
        ? d.companyEmployeesSearchPageUrl
        : undefined,
  };
}

export async function voyagerPeopleSearch(
  keywords: string,
  opts?: { count?: number; start?: number; companyId?: string },
): Promise<{ hits: VoyagerHit[]; total: number; detail: string }> {
  const sess = loadSession();
  if (!sess) return { hits: [], total: 0, detail: "no li_at" };
  const count = Math.min(opts?.count ?? 10, 25);
  const start = opts?.start ?? 0;
  const kw = keywords.replace(/[()]/g, " ").trim();
  const facets = opts?.companyId
    ? `resultType:List(PEOPLE),currentCompany:List(${opts.companyId})`
    : `resultType:List(PEOPLE)`;
  const url =
    "https://www.linkedin.com/voyager/api/search/dash/clusters" +
    "?decorationId=com.linkedin.voyager.dash.deco.search.SearchClusterCollection-174" +
    "&origin=FACETED_SEARCH&q=all" +
    `&query=(keywords:${encodeURIComponent(kw)},flagshipSearchIntent:SEARCH_SRP,queryParameters:(${facets}),includeFiltersInResponse:false)` +
    `&count=${count}&start=${start}`;
  const { liGet } = await import("./linkedin-http");
  const res = await liGet(url, "https://www.linkedin.com/search/results/people/");
  if (res.status !== 200) {
    return { hits: [], total: 0, detail: `voyager ${res.status}` };
  }
  const j = JSON.parse(res.body) as {
    data?: { metadata?: { totalResultCount?: number } };
    included?: Array<Record<string, unknown>>;
  };
  const total = j.data?.metadata?.totalResultCount ?? 0;
  const hits: VoyagerHit[] = [];
  const seen = new Set<string>();
  for (const x of j.included ?? []) {
    if (!String(x.$type ?? "").includes("EntityResult")) continue;
    const name = txt(x.title);
    const href = String(x.navigationUrl ?? "");
    if (!name || /^linkedin member$/i.test(name)) continue;
    const slug = slugFromUrl(href);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    hits.push({
      name,
      title: txt(x.primarySubtitle),
      location: txt(x.secondarySubtitle),
      slug,
      url: `https://www.linkedin.com/in/${slug}/`,
      total,
    });
  }
  return { hits, total, detail: `voyager ${hits.length}/${total}` };
}

/** LinkedIn Recruiter function names — Hunter-style department skeleton. */
export const LINKEDIN_FUNCTIONS = [
  "Accounting",
  "Administrative",
  "Arts and Design",
  "Business Development",
  "Community and Social Services",
  "Consulting",
  "Education",
  "Engineering",
  "Entrepreneurship",
  "Finance",
  "Healthcare Services",
  "Human Resources",
  "Information Technology",
  "Legal",
  "Marketing",
  "Media and Communication",
  "Military and Protective Services",
  "Operations",
  "Product Management",
  "Program and Project Management",
  "Purchasing",
  "Quality Assurance",
  "Real Estate",
  "Research",
  "Sales",
  "Support",
] as const;

export async function voyagerPeopleFanout(
  companyName: string,
  companyId?: string,
): Promise<{ hits: VoyagerHit[]; total: number; detail: string }> {
  const jobs: Array<{ kw: string; start: number }> = [
    { kw: companyName, start: 0 },
    { kw: companyName, start: 10 },
    { kw: companyName, start: 20 },
    { kw: companyName, start: 30 },
    { kw: companyName, start: 40 },
    ...LINKEDIN_FUNCTIONS.map((fn) => ({ kw: `${companyName} ${fn}`, start: 0 })),
  ];
  const seen = new Set<string>();
  const hits: VoyagerHit[] = [];
  let total = 0;
  let i = 0;
  const width = 3;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (i < jobs.length) {
        const job = jobs[i++]!;
        const page = await voyagerPeopleSearch(job.kw, {
          count: 10,
          start: job.start,
          companyId,
        });
        if (page.total > total) total = page.total;
        for (const h of page.hits) {
          if (seen.has(h.slug)) continue;
          seen.add(h.slug);
          hits.push(h);
        }
      }
    }),
  );
  return { hits, total, detail: `voyager fanout ${hits.length}/${total}` };
}
