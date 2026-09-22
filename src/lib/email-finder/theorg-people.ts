/**
 * TheOrg public SSR — independent of LinkedIn.
 * Rotating Okk residential IPs so we can fan out orgs + teams.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

export type TheOrgHit = {
  name: string;
  title?: string;
  slug: string;
  url: string;
  team?: string;
  company?: string;
  domain?: string;
  linkedinUrl?: string;
  location?: string;
};
const execFileAsync = promisify(execFile);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

type ProxyAuth = { host: string; port: string; user: string; pass: string };
let proxyBase: ProxyAuth | null | undefined;

async function loadProxy(): Promise<ProxyAuth | null> {
  if (proxyBase !== undefined) return proxyBase;
  const url = env("OKK_PROXY_CONFIG_URL_BING") || env("OKK_PROXY_CONFIG_URL");
  if (!url) {
    proxyBase = null;
    return null;
  }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(4000),
      headers: { Accept: "text/plain" },
    });
    const text = await res.text();
    const line = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.includes(":") && !l.startsWith("#"));
    if (!line) {
      proxyBase = null;
      return null;
    }
    const parts = line.split(":");
    proxyBase = {
      host: parts[0]!,
      port: parts[1]!,
      user: parts[2]!,
      pass: parts.slice(3).join(":"),
    };
    return proxyBase;
  } catch {
    proxyBase = null;
    return null;
  }
}

async function fetchHtml(url: string): Promise<string | null> {
  const proxy = await loadProxy();
  const sid = randomBytes(3).toString("hex");
  try {
    const args = ["-sS", "-m", "10", "-L", "--max-redirs", "2", "--compressed", "-A", UA];
    if (proxy) {
      const user = `${proxy.user.replace(/-sid-[a-z0-9]+$/i, "")}-sid-${sid}`;
      args.push("-x", `http://${user}:${proxy.pass}@${proxy.host}:${proxy.port}`);
    }
    args.push(url);
    const { stdout } = await execFileAsync("curl", args, {
      maxBuffer: 2_000_000,
      timeout: 12_000,
    });
    return stdout.length > 800 ? stdout : null;
  } catch {
    return null;
  }
}

async function nextProps(url: string): Promise<Record<string, unknown> | null> {
  const html = await fetchHtml(url);
  if (!html) return null;
  const m = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m) return null;
  try {
    const j = JSON.parse(m[1]!) as {
      props?: { pageProps?: Record<string, unknown> };
    };
    return j.props?.pageProps ?? null;
  } catch {
    return null;
  }
}

const GQL = "https://prod-graphql-api.theorg.com/graphql";

type GqlTeam = { slug?: string; name?: string; memberCount?: number };
type GqlMember = { fullName?: string; slug?: string; role?: string };

async function theOrgGql<T>(
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T | null> {
  try {
    const res = await fetch(GQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": UA,
        Origin: "https://theorg.com",
        Referer: "https://theorg.com/",
        "X-Org-Client": "web",
        "X-Operation-Name": operationName,
      },
      body: JSON.stringify({ operationName, query, variables }),
      signal: AbortSignal.timeout(18_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: T };
    return j.data ?? null;
  } catch {
    return null;
  }
}

async function graphqlAllTeams(companySlug: string): Promise<GqlTeam[]> {
  const q = `query teamsByCompany($companySlug: String!, $limit: Int!, $offset: Int!) {
    teamsByCompany(companySlug: $companySlug, limit: $limit, offset: $offset) {
      slug name memberCount
    }
  }`;
  const out: GqlTeam[] = [];
  for (let offset = 0; offset < 400; offset += 50) {
    const data = await theOrgGql<{ teamsByCompany?: GqlTeam[] }>(
      "teamsByCompany",
      q,
      { companySlug, limit: 50, offset },
    );
    const page = data?.teamsByCompany ?? [];
    if (!page.length) break;
    out.push(...page);
    if (page.length < 50) break;
  }
  return out;
}

function pushGqlMember(
  m: GqlMember,
  hits: TheOrgHit[],
  seen: Set<string>,
  team: string | undefined,
  company: string | undefined,
  domain: string | undefined,
) {
  const name = (m.fullName ?? "").trim();
  const slug = (m.slug ?? "").trim();
  if (!name || !slug || name.split(/\s+/).length < 2 || seen.has(slug)) return;
  seen.add(slug);
  hits.push({
    name,
    title: m.role,
    slug,
    url: `https://theorg.com/org/_/p/${slug}`,
    team,
    company,
    domain,
  });
}

/** Public GraphQL: every team, first 50 members each (offset>0 is login-walled). */
async function graphqlTeamPeople(
  companySlug: string,
  hits: TheOrgHit[],
  seen: Set<string>,
  company: string | undefined,
  domain: string | undefined,
  deadline: number,
): Promise<number> {
  const teams = await graphqlAllTeams(companySlug);
  if (!teams.length) return 0;
  const q = `query team($companySlug: String, $teamSlug: String!, $memberLimit: Int, $memberOffset: Int) {
    team(companySlug: $companySlug, teamSlug: $teamSlug) {
      slug name memberCount
      members(limit: $memberLimit, offset: $memberOffset) {
        fullName slug role id
      }
    }
  }`;
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(12, teams.length) }, async () => {
      while (i < teams.length && (!deadline || Date.now() < deadline)) {
        const t = teams[i++]!;
        if (!t.slug) continue;
        const data = await theOrgGql<{
          team?: { name?: string; members?: GqlMember[] };
        }>("team", q, {
          companySlug,
          teamSlug: t.slug,
          memberLimit: 50,
          memberOffset: 0,
        });
        for (const m of data?.team?.members ?? []) {
          pushGqlMember(m, hits, seen, data?.team?.name ?? t.name, company, domain);
        }
      }
    }),
  );
  return teams.length;
}

function walkPeople(
  node: unknown,
  out: TheOrgHit[],
  seen: Set<string>,
  team?: string,
  company?: string,
  domain?: string,
) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const x of node) walkPeople(x, out, seen, team, company, domain);
    return;
  }
  if (typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const name = typeof o.fullName === "string" ? o.fullName : undefined;
  const role = typeof o.role === "string" ? o.role : undefined;
  const slug = typeof o.slug === "string" ? o.slug : undefined;
  const li =
    (typeof o.linkedinUrl === "string" && o.linkedinUrl) ||
    (typeof o.linkedin === "string" && o.linkedin) ||
    (typeof o.linkedInUrl === "string" && o.linkedInUrl) ||
    undefined;
  const loc =
    (typeof o.location === "string" && o.location) ||
    (typeof o.city === "string" && o.city) ||
    (typeof o.geo === "string" && o.geo) ||
    (typeof o.officeName === "string" && o.officeName) ||
    undefined;
  if (name && slug && name.split(/\s+/).length >= 2 && !seen.has(slug)) {
    seen.add(slug);
    out.push({
      name,
      title: role,
      slug,
      url: li && /linkedin\.com\/in\//i.test(li) ? li : `https://theorg.com/org/_/p/${slug}`,
      team,
      company,
      domain,
      location: loc,
      linkedinUrl: li && /linkedin\.com\/in\//i.test(li) ? li.split("?")[0] : undefined,
    });
  }
  const nestedTeam =
    typeof o.name === "string" && o.__typename === "Team" ? o.name : team;
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") walkPeople(v, out, seen, nestedTeam, company, domain);
  }
}

function slugCandidates(domain: string, companyName: string): string[] {
  const host = domain.replace(/^www\./, "");
  const brand = host.split(".")[0] ?? host;
  const dotted = host.replace(/\./g, "-");
  const name = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return [...new Set([dotted, `${brand}-com`, brand, name, `${name}-com`])].filter(
    (s) => s.length >= 2,
  );
}

const TEAM_GUESSES = [
  "engineering",
  "product",
  "marketing",
  "sales",
  "finance",
  "operations",
  "people",
  "human-resources",
  "legal",
  "research",
  "academic-affairs",
  "faculty",
  "admissions",
  "student-affairs",
  "communications",
  "information-technology",
  "advancement",
  "leadership",
  "executive",
  "education",
];

async function allTeamSlugs(
  slug: string,
  seed: string[],
): Promise<string[]> {
  const seen = new Set(seed.map((s) => s.toLowerCase()).filter(Boolean));
  try {
    const { decodoShards } = await import("./decodo-serp");
    const letters = "abcdefghijklmnopqrstuvwxyz".split("");
    const qs = [
      `site:theorg.com/org/${slug}/teams`,
      ...letters.map((l) => `site:theorg.com/org/${slug}/teams/${l}`),
    ];
    const pages = await decodoShards(qs);
    const re = new RegExp(`/org/${slug}/teams/([a-z0-9\\-]+)`, "i");
    for (const rows of pages) {
      for (const row of rows) {
        const m = (row.link ?? "").match(re);
        if (m?.[1]) seen.add(m[1].toLowerCase());
      }
    }
  } catch {
    /* optional */
  }
  return [...seen];
}

function websiteHost(co: Record<string, unknown>): string | undefined {
  const social = co.social as { websiteUrl?: string } | undefined;
  const raw = social?.websiteUrl || (typeof co.domain === "string" ? co.domain : "") || "";
  return raw
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    ?.toLowerCase();
}

async function peopleFromSlug(
  slug: string,
  maxTeams = 160,
  deadline = 0,
  expectDomain?: string,
): Promise<{ hits: TheOrgHit[]; related: Array<{ name: string; domain?: string }> }> {
  if (deadline && Date.now() > deadline) return { hits: [], related: [] };
  const props = await nextProps(`https://theorg.com/org/${slug}`);
  if (!props?.initialCompany) return { hits: [], related: [] };
  const co = props.initialCompany as {
    name?: string;
    domain?: string;
    website?: string;
    url?: string;
    offices?: Array<{ slug?: string }>;
    social?: { websiteUrl?: string };
  };
  const host = websiteHost(co as Record<string, unknown>);
  if (
    expectDomain &&
    host &&
    host !== expectDomain.replace(/^www\./, "").toLowerCase() &&
    !host.endsWith(`.${expectDomain}`)
  ) {
    return { hits: [], related: [] };
  }
  const company = co.name;
  const domain = host && host.includes(".") ? host : undefined;
  const hits: TheOrgHit[] = [];
  const seen = new Set<string>();
  walkPeople(props, hits, seen, undefined, company, domain);
  const gqlTeams = await graphqlTeamPeople(slug, hits, seen, company, domain, deadline).catch(
    () => 0,
  );
  const teams = (props.initialTeams as Array<{ slug?: string }> | undefined) ?? [];
  const offices = (co.offices ?? []).map((o) => o.slug).filter(Boolean) as string[];
  const relatedRaw = (props.relatedCompanies as Array<{ name?: string; social?: { websiteUrl?: string } }>) ?? [];
  const related = relatedRaw
    .map((r) => ({
      name: r.name ?? "",
      domain: websiteHost(r as unknown as Record<string, unknown>),
    }))
    .filter((r) => r.name);

  if (gqlTeams > 0 && hits.length > 80) {
    return { hits, related };
  }
  const extra = await allTeamSlugs(
    slug,
    [...teams.map((t) => t.slug || ""), ...TEAM_GUESSES],
  );
  const paths = [
    ...extra.slice(0, maxTeams).map((ts) => `/org/${slug}/teams/${ts}`),
    ...offices.map((s) => `/org/${slug}/offices/${s}`),
  ];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, paths.length || 1) }, async () => {
      while (i < paths.length && (!deadline || Date.now() < deadline)) {
        const path = paths[i++]!;
        const page = await nextProps(`https://theorg.com${path}`);
        if (page) walkPeople(page, hits, seen, undefined, company, domain);
      }
    }),
  );
  return { hits, related };
}

let featuredCache: { at: number; items: Array<{ name: string; slug: string }> } | null =
  null;

async function featuredOrgs(): Promise<Array<{ name: string; slug: string }>> {
  if (featuredCache && Date.now() - featuredCache.at < 6 * 3600_000) {
    return featuredCache.items;
  }
  const props = await nextProps("https://theorg.com/companies");
  const items = (props?.initialItems as Array<{ name?: string; uri?: string }>) ?? [];
  const out: Array<{ name: string; slug: string }> = [];
  for (const x of items) {
    const m = (x.uri ?? "").match(/\/org\/([a-z0-9\-]+)/i);
    if (x.name && m) out.push({ name: x.name, slug: m[1]!.toLowerCase() });
  }
  featuredCache = { at: Date.now(), items: out };
  return out;
}

const INDUSTRY_WORDS: Record<string, string[]> = {
  education: [
    "education",
    "university",
    "college",
    "school",
    "academy",
    "edtech",
    "k-12",
    "campus",
    "institute",
  ],
  "higher education": ["university", "college", "campus", "institute"],
  "real estate": ["real estate", "realty", "property", "housing"],
  "information technology": ["software", "technology", "saas", "cloud", "cyber"],
  "computer software": ["software", "saas"],
  "it services": ["it services", "consulting"],
};

function industryTokens(label: string): string[] {
  const key = label.toLowerCase().trim();
  const extra = INDUSTRY_WORDS[key] ?? [];
  const bits = key.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return [...new Set([key, ...extra, ...bits])].filter(Boolean);
}

export async function theOrgPeople(
  domain: string,
  companyName: string,
): Promise<{
  hits: TheOrgHit[];
  positions: number;
  teams: number;
  slug?: string;
  related: Array<{ name: string; domain?: string }>;
}> {
  const expect = domain.replace(/^www\./, "").toLowerCase() || undefined;
  const deadline = Date.now() + 90_000;
  for (const s of slugCandidates(domain, companyName)) {
    const props = await nextProps(`https://theorg.com/org/${s}`);
    if (!props?.initialCompany) continue;
    const company = props.initialCompany as {
      stats?: { positionCount?: number; teamsCount?: number };
      social?: { websiteUrl?: string };
    };
    const host = websiteHost(company as Record<string, unknown>);
    if (
      expect &&
      host &&
      host !== expect &&
      !expect.endsWith(host) &&
      !host.endsWith(expect)
    ) {
      continue;
    }
    const { hits, related } = await peopleFromSlug(s, 160, deadline, expect);
    return {
      hits,
      positions: company.stats?.positionCount ?? 0,
      teams: company.stats?.teamsCount ?? 0,
      slug: s,
      related,
    };
  }
  return { hits: [], positions: 0, teams: 0, related: [] };
}

export async function theOrgPeopleQuick(companyName: string): Promise<TheOrgHit[]> {
  const r = await theOrgPeople("", companyName);
  return r.hits;
}

/** Filter → TheOrg orgs → people. Runs even if LinkedIn is down. */
export async function theorgDiscover(opts: {
  keywords?: string;
  companyName?: string;
  domain?: string;
  industryLabel?: string;
  geoLabel?: string;
  title?: string;
}): Promise<TheOrgHit[]> {
  const hits: TheOrgHit[] = [];
  const seen = new Set<string>();
  const add = (rows: TheOrgHit[]) => {
    for (const h of rows) {
      if (seen.has(h.slug)) continue;
      seen.add(h.slug);
      hits.push(h);
    }
  };

  if (opts.companyName || opts.domain) {
    const r = await theOrgPeople(opts.domain ?? "", opts.companyName ?? "");
    add(r.hits);
    const q = (opts.keywords || opts.title || "").trim();
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      return hits.filter(
        (h) =>
          re.test(h.title ?? "") ||
          re.test(h.name) ||
          re.test(h.team ?? ""),
      );
    }
    return hits;
  }

  const industry = (opts.industryLabel ?? "").replace(/"/g, "").trim();
  const geo = (opts.geoLabel ?? "").replace(/"/g, "").trim();
  const kw = (opts.keywords ?? "").replace(/"/g, "").trim();
  const title = (opts.title ?? "").replace(/"/g, "").trim();
  const tokens = industryTokens(industry || kw);
  const queries: string[] = [];
  for (const t of tokens.slice(0, 6)) {
    queries.push(`site:theorg.com/org ${t}${geo ? ` "${geo}"` : ""}`);
  }
  if (kw && industry && kw.toLowerCase() !== industry.toLowerCase()) {
    queries.push(`site:theorg.com/org "${kw}" ${industry}${geo ? ` "${geo}"` : ""}`);
  }
  if (title) {
    queries.push(
      `site:theorg.com/org ${tokens[0] || "org"} "${title}"${geo ? ` ${geo}` : ""}`,
    );
  }
  for (const role of ["CEO", "Director", "VP", "Dean", "Principal"]) {
    if (tokens[0]) queries.push(`site:theorg.com/org ${tokens[0]} ${role}`);
  }
  if (!queries.length) {
    const fallback = kw || title || industry || geo;
    if (fallback) queries.push(`site:theorg.com/org "${fallback}"`);
  }

  const slugs: string[] = [];
  const seenSlug = new Set<string>();
  const pushSlug = (s: string) => {
    const x = s.toLowerCase();
    if (seenSlug.has(x) || x.length < 2) return;
    seenSlug.add(x);
    slugs.push(x);
  };

  try {
    const featured = await featuredOrgs();
    const re = tokens.length
      ? new RegExp(
          `\\b(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
          "i",
        )
      : null;
    for (const c of featured) {
      if (re && re.test(c.name)) pushSlug(c.slug);
    }
  } catch {
    /* optional */
  }

  if (queries.length) {
    try {
      const { decodoShards } = await import("./decodo-serp");
      const pages = await decodoShards(queries.slice(0, 12));
      for (const rows of pages) {
        for (const row of rows) {
          const m = (row.link ?? "").match(/theorg\.com\/org\/([a-z0-9\-]+)/i);
          if (m) pushSlug(m[1]!);
        }
      }
    } catch {
      /* optional */
    }
  }

  const target = slugs.slice(0, 80);
  const deadline = Date.now() + 45_000;
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, target.length || 1) }, async () => {
      while (i < target.length && Date.now() < deadline) {
        const s = target[i++]!;
        const r = await peopleFromSlug(s, 36, deadline);
        add(r.hits);
      }
    }),
  );

  if (title) {
    const re = new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    return hits.filter((h) => !h.title || re.test(h.title) || re.test(h.name));
  }
  return hits;
}
