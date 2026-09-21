/**
 * ICP Finder — SparkToro-style, ROAS-weighted.
 * Built from person enrich + company enrich of the people who paid,
 * not from each logo's job board or Google autocomplete.
 */

import { parseRss } from "./signals-sources";
import { classifyTitle } from "./title-taxonomy";
import type { PersonFindData } from "./person-find";
import type { CompanyFindData } from "./company-find";
import { buildAudiencePrompt, sparkToroFullReport, stToAffinity } from "./sparktoro";
import { saveIcpReport } from "./icp-store";

export type IcpCustomerIn = {
  email?: string;
  name?: string;
  domain?: string;
  acv?: number;
};

export type IcpInput = {
  website: string;
  brief?: string;
  customers?: IcpCustomerIn[];
  competitors?: string[];
};

export type AffinityRow = {
  name: string;
  url?: string;
  kind: string;
  pct: number;
  affinity: number;
  evidence: string;
  source: string;
};

export type IcpSegment = {
  name: string;
  shareOfRevenue: number;
  who: string;
  whereToShowUp: string[];
  evidence: string[];
};

export type IcpBuyer = {
  email: string | null;
  name: string | null;
  title: string | null;
  role: string | null;
  seniority: string | null;
  company: string | null;
  domain: string;
  industry: string | null;
  size: string | null;
  location: string | null;
  linkedin: string | null;
  twitter: string | null;
  acv: number;
  sharePct: number;
  sources: string[];
};

export type IcpReport = {
  company: { domain: string; name: string; brief: string; products: string[] };
  spend: { totalAcv: number; weightedCustomers: number };
  buyers: IcpBuyer[];
  demographics: {
    titles: AffinityRow[];
    seniority: AffinityRow[];
    industries: AffinityRow[];
    sizes: AffinityRow[];
    locations: AffinityRow[];
    functions: AffinityRow[];
    age: AffinityRow[];
    gender: AffinityRow[];
    salary: AffinityRow[];
    audienceTitles: AffinityRow[];
  };
  social: AffinityRow[];
  websites: AffinityRow[];
  youtube: AffinityRow[];
  podcasts: AffinityRow[];
  reddit: AffinityRow[];
  keywords: AffinityRow[];
  apps: AffinityRow[];
  bioPhrases: AffinityRow[];
  lookalikes: AffinityRow[];
  press: AffinityRow[];
  networks: AffinityRow[];
  prompts: AffinityRow[];
  tam: {
    estimated_population: number | null;
    year_over_year_growth_pct: number | null;
    estimated_market_value: number | null;
    currency: string | null;
    rationale: string | null;
  } | null;
  sparkToro: { reportId: string; prompt: string; creditsRemaining: number | null } | null;
  segments: IcpSegment[];
  takeAction: string[];
  sources: string[];
  durationMs: number;
};

const ROLE_LOCAL =
  /^(info|hello|hi|hey|contact|sales|marketing|support|admin|team|office|hr|jobs|press|media|billing|accounts|noreply|no-reply|webmaster|help)$/i;

function normDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/[^\w.-]/g, "");
}

function hostOf(url: string): string {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function nameFromLocal(local: string): string | undefined {
  if (!local || ROLE_LOCAL.test(local)) return undefined;
  const parts = local
    .split(/[._+\-]+/)
    .filter((p) => p.length > 1 && !/^\d+$/.test(p) && !/^(mail|email|corp|inc)$/i.test(p));
  if (!parts.length) return undefined;
  return parts.map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase()).join(" ");
}

function parseEmail(raw?: string): { email?: string; domain?: string; local?: string } {
  const m = (raw ?? "").trim().toLowerCase().match(/^([a-z0-9._%+\-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i);
  if (!m) return {};
  return { email: m[0], local: m[1], domain: normDomain(m[2]!) };
}

async function getJson<T>(url: string, timeout = 9000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function getText(url: string, timeout = 9000): Promise<string> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        Accept: "*/*",
      },
    });
    if (!res.ok) return "";
    return res.text();
  } catch {
    return "";
  }
}

function bag(): Map<string, { w: number; n: number; url?: string; evidence: string[]; source: string; kind: string }> {
  return new Map();
}

function add(
  m: Map<string, { w: number; n: number; url?: string; evidence: string[]; source: string; kind: string }>,
  name: string,
  weight: number,
  meta: { url?: string; evidence?: string; source: string; kind: string },
) {
  const key = name.trim();
  if (!key || key.length < 2) return;
  if (/^(home|about|blog|login|contact|privacy|terms)$/i.test(key)) return;
  const cur = m.get(key.toLowerCase()) ?? { w: 0, n: 0, url: meta.url, evidence: [], source: meta.source, kind: meta.kind };
  cur.w += weight;
  cur.n += 1;
  if (meta.url && !cur.url) cur.url = meta.url;
  if (meta.evidence) cur.evidence.push(meta.evidence);
  m.set(key.toLowerCase(), { ...cur, kind: meta.kind, source: meta.source });
}

function rank(
  m: Map<string, { w: number; n: number; url?: string; evidence: string[]; source: string; kind: string }>,
  totalW: number,
  limit = 12,
): AffinityRow[] {
  const rows = [...m.entries()].map(([k, v]) => {
    const pct = totalW > 0 ? Math.round((v.w / totalW) * 1000) / 10 : 0;
    const affinity = Math.min(100, Math.round(pct * 1.4 + Math.min(30, v.n * 8)));
    const display = k.includes(".") || k.startsWith("r/") || k.startsWith("@") ? k : k.replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      name: display,
      url: v.url,
      kind: v.kind,
      pct,
      affinity,
      evidence: [...new Set(v.evidence)].slice(0, 3).join(" · ") || v.source,
      source: v.source,
    };
  });
  return rows.sort((a, b) => b.affinity - a.affinity || b.pct - a.pct).slice(0, limit);
}

const SENIORITY: Array<{ re: RegExp; label: string }> = [
  { re: /\b(chief|ceo|cto|cfo|cmo|coo|ciso|founder|co-founder|president|owner)\b/i, label: "C-level / founder" },
  { re: /\b(vp|vice president|head of|director)\b/i, label: "VP / Director" },
  { re: /\b(manager|lead|principal|staff|partner)\b/i, label: "Manager / Lead" },
  { re: /\b(marketing|sales|growth|demand)\b/i, label: "GTM / Marketing" },
  { re: /\b(engineer|developer|analyst|specialist|consultant)\b/i, label: "IC / Practitioner" },
];

function seniorityOf(title: string | null, levels: string[]): string | null {
  if (levels.includes("owner") || levels.includes("cxo") || levels.includes("partner")) return "C-level / founder";
  if (levels.includes("vp") || levels.includes("director")) return "VP / Director";
  if (title) {
    const hit = SENIORITY.find((s) => s.re.test(title));
    if (hit) return hit.label;
  }
  if (levels.includes("manager") || levels.includes("senior")) return "Manager / Lead";
  return title ? "IC / Practitioner" : null;
}

async function itunesPodcasts(q: string): Promise<Array<{ name: string; url: string; artist: string }>> {
  if (q.trim().length < 4) return [];
  const j = await getJson<{ results?: Array<{ collectionName?: string; collectionViewUrl?: string; artistName?: string }> }>(
    `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=podcast&limit=6`,
  );
  return (j?.results ?? [])
    .map((r) => ({ name: r.collectionName ?? "", url: r.collectionViewUrl ?? "", artist: r.artistName ?? "" }))
    .filter((x) => x.name);
}

function extractReddit(blobs: string[]): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = [];
  const seen = new Set<string>();
  for (const s of blobs) {
    const m = s.match(/reddit\.com\/r\/([A-Za-z0-9_]+)/i) || s.match(/\br\/([A-Za-z0-9_]{3,30})\b/);
    if (!m) continue;
    const name = `r/${m[1]}`;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, url: `https://www.reddit.com/r/${m[1]}` });
  }
  return out;
}

const INDUSTRY_REDDIT: Record<string, string[]> = {
  education: ["r/edtech", "r/Teachers", "r/highereducation"],
  software: ["r/SaaS", "r/startups", "r/entrepreneur"],
  health: ["r/healthIT", "r/healthcare"],
  finance: ["r/fintech", "r/smallbusiness"],
  marketing: ["r/marketing", "r/Emailmarketing", "r/sales"],
  real: ["r/realtors", "r/realestate"],
  insurance: ["r/Insurance", "r/sales"],
};

function redditsFor(industry: string | null, role: string | null): string[] {
  const blob = `${industry ?? ""} ${role ?? ""}`.toLowerCase();
  const out: string[] = [];
  for (const [k, subs] of Object.entries(INDUSTRY_REDDIT)) {
    if (blob.includes(k)) out.push(...subs);
  }
  if (/\bmarketing|growth|demand\b/.test(blob)) out.push("r/Emailmarketing", "r/marketing");
  return [...new Set(out)];
}

function defaultAcv(index: number, n: number): number {
  /* first listed = highest ACV; last = most frequent / lower ticket */
  return Math.max(1, Math.round(1000 / (index + 1)));
}

function tokensOf(...parts: Array<string | null | undefined>): string[] {
  const STOP = /^(the|and|for|with|from|that|this|your|their|about|using|saas|tool|platform|company|inc|llc|ltd|email)$/i;
  const out = new Set<string>();
  for (const p of parts) {
    for (const w of (p ?? "").match(/[A-Za-z][A-Za-z0-9+#-]{3,}/g) ?? []) {
      if (!STOP.test(w)) out.add(w);
    }
  }
  return [...out];
}

type EnrichedBuyer = {
  in: IcpCustomerIn & { email?: string; domain: string; acv: number };
  person: PersonFindData | null;
  company: CompanyFindData | null;
  roleHint: string | null;
};

export async function findIcp(input: IcpInput): Promise<IcpReport> {
  const t0 = Date.now();
  const domain = normDomain(input.website || "");
  if (!domain.includes(".")) throw new Error("website domain required");
  const brief = (input.brief ?? "").trim();

  const parsed = (input.customers ?? [])
    .map((c, i) => {
      const fromEmail = parseEmail(c.email) ;
      const fromName = parseEmail(c.name);
      const email = fromEmail.email || fromName.email;
      const d = normDomain(c.domain || fromEmail.domain || fromName.domain || "");
      const acv = Number(c.acv);
      return {
        email,
        name: c.name && !c.name.includes("@") ? c.name : nameFromLocal(fromEmail.local || fromName.local || "") ,
        domain: d,
        acv: Number.isFinite(acv) && acv > 0 ? acv : defaultAcv(i, input.customers?.length ?? 1),
        roleHint: fromEmail.local && ROLE_LOCAL.test(fromEmail.local) ? fromEmail.local : null,
      };
    })
    .filter((c) => c.domain.includes("."));

  const competitors = (input.competitors ?? []).map(normDomain).filter((d) => d.includes("."));
  const totalAcv = parsed.reduce((s, c) => s + c.acv, 0) || 1;

  const { findPerson } = await import("./person-find");
  const { findCompany } = await import("./company-find");

  const [youCo, buyersRaw, compCos] = await Promise.all([
    findCompany(domain).catch(() => null),
    Promise.all(
      parsed.slice(0, 8).map(async (c) => {
        const [personRes, company] = await Promise.all([
          c.email && !c.roleHint
            ? findPerson({
                email: c.email,
                fullName: c.name,
                domain: c.domain,
                company: c.domain.split(".")[0],
              }).catch(() => null)
            : Promise.resolve(null),
          findCompany(c.domain).catch(() => null),
        ]);
        let person = personRes?.data ?? null;
        if (person && !person.job_title && c.name && !c.name.includes(" ")) {
          try {
            const { lookupPersonAtCompany } = await import("./linkedin-company");
            const hits = await lookupPersonAtCompany({
              domain: c.domain,
              companyName: company?.data.displayName || c.domain.split(".")[0],
              query: c.name,
            });
            const needle = c.name.toLowerCase();
            const hit = hits.find(
              (h) =>
                h.firstName.toLowerCase() === needle ||
                h.fullName.toLowerCase().startsWith(needle),
            );
            if (hit) {
              person = {
                ...person,
                full_name: hit.fullName,
                first_name: hit.firstName,
                last_name: hit.lastName,
                job_title: hit.title ?? person.job_title,
                location_name: hit.location ?? person.location_name,
                linkedin_url: hit.sourceUrl || person.linkedin_url,
              };
            }
          } catch {
            /* keep enrich as-is */
          }
        }
        return { in: c, person, company: company?.data ?? null, roleHint: c.roleHint } satisfies EnrichedBuyer;
      }),
    ),
    Promise.all(competitors.slice(0, 5).map((d) => findCompany(d).catch(() => null))),
  ]);

  const sources = new Set<string>(["person-enrich", "company-enrich"]);
  const titles = bag();
  const seniority = bag();
  const industries = bag();
  const sizes = bag();
  const locations = bag();
  const functions = bag();
  const social = bag();
  const websites = bag();
  const youtube = bag();
  const podcasts = bag();
  const reddit = bag();
  const keywords = bag();
  const apps = bag();
  const bios = bag();
  const lookalikes = bag();

  const buyers: IcpBuyer[] = [];
  const industryTokens: string[] = [];
  const roleTokens: string[] = [];

  for (const row of buyersRaw) {
    const w = row.in.acv;
    const p = row.person;
    const co = row.company;
    const tax = classifyTitle(p?.job_title || (row.roleHint ? row.roleHint : null));
    const title =
      p?.job_title ||
      (row.roleHint ? `${row.roleHint[0]!.toUpperCase()}${row.roleHint.slice(1)} (role inbox)` : null);
    const sen = seniorityOf(title, tax.levels);
    const industry = co?.industry || co?.industryV2 || p?.job_company_industry || p?.industry || null;
    const loc =
      p?.location_name ||
      [p?.location_locality, p?.location_region, p?.location_country].filter(Boolean).join(", ") ||
      co?.location ||
      [co?.geo?.city, co?.geo?.country].filter(Boolean).join(", ") ||
      null;
    const size = co?.metrics.employees || p?.job_company_size || null;
    const name = (p?.full_name && p.full_name.trim()) || row.in.name || null;
    const companyName = co?.displayName || co?.name || p?.job_company_name || row.in.domain.split(".")[0] || row.in.domain;

    buyers.push({
      email: row.in.email ?? null,
      name: name ?? null,
      title,
      role: tax.role || row.roleHint || null,
      seniority: sen,
      company: companyName,
      domain: row.in.domain,
      industry,
      size,
      location: loc,
      linkedin: p?.linkedin_url || co?.linkedin?.url || null,
      twitter: p?.twitter_url || co?.twitter?.url || null,
      acv: w,
      sharePct: Math.round((w / totalAcv) * 1000) / 10,
      sources: [...new Set([...(p ? ["person"] : []), ...(co ? ["company"] : [])])],
    });

    if (title) add(titles, title.replace(/ \(role inbox\)/i, ""), w, { source: "person-enrich", kind: "title", evidence: `${name || row.in.email} @ ${companyName}` });
    if (sen) add(seniority, sen, w, { source: "person-enrich", kind: "seniority", evidence: title ?? "" });
    if (tax.role) add(functions, tax.role.replace(/_/g, " "), w, { source: "person-enrich", kind: "function", evidence: title ?? row.roleHint ?? "" });
    else if (row.roleHint) add(functions, row.roleHint, w, { source: "role-inbox", kind: "function", evidence: row.in.email ?? "" });
    if (industry) add(industries, industry, w, { source: "company-enrich", kind: "industry", evidence: companyName });
    if (size) add(sizes, size, w, { source: "company-enrich", kind: "size", evidence: companyName });
    if (loc) add(locations, loc, w, { source: "person-enrich", kind: "location", evidence: name || companyName });

    add(websites, row.in.domain, w, { url: `https://${row.in.domain}`, source: "paying-logo", kind: "site", evidence: companyName });
    if (p?.linkedin_url)
      add(social, `LinkedIn · ${name || p.linkedin_username || "buyer"}`, w, {
        url: p.linkedin_url,
        source: "person-enrich",
        kind: "linkedin",
        evidence: title ?? "",
      });
    if (p?.twitter_url)
      add(social, `X · ${p.twitter_username || name}`, w, { url: p.twitter_url, source: "person-enrich", kind: "x", evidence: name ?? "" });
    if (p?.github_url)
      add(social, `GitHub · ${p.github_username || name}`, w, { url: p.github_url, source: "person-enrich", kind: "github", evidence: name ?? "" });
    if (co?.linkedin.url)
      add(social, `LinkedIn · ${companyName}`, w * 0.6, { url: co.linkedin.url, source: "company-enrich", kind: "linkedin", evidence: "company page" });
    if (co?.twitter.url)
      add(social, `X · ${co.twitter.handle || companyName}`, w * 0.5, { url: co.twitter.url, source: "company-enrich", kind: "x", evidence: companyName });
    if (co?.crunchbase.url)
      add(websites, hostOf(co.crunchbase.url) || "crunchbase.com", w * 0.4, { url: co.crunchbase.url, source: "company-enrich", kind: "site", evidence: companyName });
    if (co?.youtube.url)
      add(youtube, `${companyName} on YouTube`, w, { url: co.youtube.url, source: "company-enrich", kind: "youtube", evidence: companyName });

    for (const t of co?.technologies ?? []) add(apps, t.name, w, { source: "company-enrich", kind: t.category || "app", evidence: companyName });
    for (const tag of (co?.tags ?? []).slice(0, 8)) add(keywords, tag, w, { source: "company-enrich", kind: "tag", evidence: companyName });
    if (industry) add(keywords, industry, w, { source: "company-enrich", kind: "industry", evidence: companyName });
    if (title) add(keywords, title, w, { source: "person-enrich", kind: "title", evidence: name ?? "" });
    for (const sk of (p?.skills ?? []).slice(0, 8)) add(keywords, sk, w * 0.4, { source: "person-enrich", kind: "skill", evidence: name ?? "" });
    if (p?.headline) add(bios, p.headline.slice(0, 90), w, { source: "person-enrich", kind: "bio", evidence: name ?? "" });
    if (p?.summary) {
      for (const phrase of p.summary.split(/[.|\n]/).map((s) => s.trim()).filter((s) => s.length > 12 && s.length < 80).slice(0, 3)) {
        add(bios, phrase, w * 0.5, { source: "person-enrich", kind: "bio", evidence: name ?? "" });
      }
    }
    if (title) add(bios, title, w, { source: "person-enrich", kind: "title", evidence: companyName });

    for (const sim of (co?.similarCompanies ?? []).slice(0, 6)) {
      if (!sim.name || /html|http|similar/i.test(sim.name)) continue;
      add(lookalikes, sim.name, w * 0.5, {
        url: sim.domain ? `https://${sim.domain}` : sim.linkedinUrl,
        source: "company-enrich",
        kind: "lookalike",
        evidence: `${companyName}${sim.industry ? ` · ${sim.industry}` : ""}`,
      });
    }

    if (industry) industryTokens.push(industry);
    if (tax.role) roleTokens.push(tax.role.replace(/_/g, " "));
    if (row.roleHint) roleTokens.push(row.roleHint);
    for (const sub of redditsFor(industry, tax.role || row.roleHint || null)) {
      add(reddit, sub, w * 0.7, { url: `https://www.reddit.com/${sub.replace(/^r\//, "r/")}`, source: "industry-map", kind: "subreddit", evidence: industry || title || "" });
    }
  }

  for (const co of compCos) {
    if (!co?.data) continue;
    const w = totalAcv * 0.05;
    add(websites, co.data.domain, w, { url: co.data.website, source: "competitor", kind: "site", evidence: co.data.displayName });
    for (const t of co.data.technologies.slice(0, 8)) add(apps, t.name, w, { source: "competitor", kind: "app", evidence: co.data.displayName });
  }

  const uniqueIndustries = [...new Set(industryTokens.map((s) => s.split(/[,/|]/)[0]!.trim()).filter((s) => s.length > 3))].slice(0, 4);
  const uniqueRoles = [...new Set(roleTokens.filter((s) => s.length > 2))].slice(0, 4);
  const podQueries = [
    ...uniqueIndustries.map((i) => `${i} founder`),
    ...uniqueRoles.map((r) => `${r} saas`),
    uniqueIndustries[0] && uniqueRoles[0] ? `${uniqueIndustries[0]} ${uniqueRoles[0]}` : "",
  ].filter(Boolean) as string[];

  const { prompt: stPrompt, location: stLoc } = buildAudiencePrompt({
    brief,
    product: youCo?.data.headline || youCo?.data.description || undefined,
    buyers,
  });
  let st = null as Awaited<ReturnType<typeof sparkToroFullReport>> | null;
  try {
    st = await sparkToroFullReport(stPrompt, stLoc, {
      audienceKey: parsed.map((c) => c.email || c.domain).sort().join(","),
      domains: parsed.map((c) => c.domain),
      allowCreate: false,
    });
    for (const s of st.sources) sources.add(s);
  } catch (e) {
    sources.add("sparktoro-failed");
  }

  if (!st?.reportId) {
    const [podLists, redditRss, ytRss] = await Promise.all([
      Promise.all(podQueries.slice(0, 4).map((q) => itunesPodcasts(q))),
      uniqueIndustries[0]
        ? getText(`https://news.google.com/rss/search?q=${encodeURIComponent(`site:reddit.com ${uniqueIndustries[0]}`)}&hl=en-US&gl=US&ceid=US:en`)
        : Promise.resolve(""),
      uniqueIndustries[0]
        ? getText(`https://news.google.com/rss/search?q=${encodeURIComponent(`site:youtube.com ${uniqueIndustries[0]} ${uniqueRoles[0] ?? ""}`)}&hl=en-US&gl=US&ceid=US:en`)
        : Promise.resolve(""),
    ]);
    sources.add("itunes");
    const keepTokens = tokensOf(...uniqueIndustries, ...uniqueRoles, brief).filter((t) => t.length > 4);
    const podOk = (name: string) =>
      keepTokens.some((t) => name.toLowerCase().includes(t.toLowerCase())) ||
      uniqueIndustries.some((i) => name.toLowerCase().includes(i.split(/\s+/)[0]!.toLowerCase()));
    for (const p of podLists.flat()) {
      if (!podOk(p.name) && !podOk(p.artist)) continue;
      add(podcasts, p.name, totalAcv * 0.25, { url: p.url, source: "itunes", kind: "podcast", evidence: p.artist });
    }
    for (const it of parseRss(redditRss, "reddit")) {
      for (const r of extractReddit([it.url, it.title, it.snippet])) {
        add(reddit, r.name, totalAcv * 0.2, { url: r.url, source: "reddit-index", kind: "subreddit", evidence: it.title });
      }
    }
    for (const it of parseRss(ytRss, "youtube")) {
      if (!/youtube\.com|youtu\.be/i.test(it.url)) continue;
      const name = it.title.replace(/\s*[-|].*(youtube|google).*$/i, "").slice(0, 90);
      if (!name || (!podOk(name) && keepTokens.length)) continue;
      add(youtube, name, totalAcv * 0.15, { url: it.url, source: "youtube-index", kind: "youtube", evidence: uniqueIndustries[0] ?? "" });
    }
  }

  const titleRows = rank(titles, totalAcv, 12);
  const functionRows = rank(functions, totalAcv, 8);
  const industryRows = rank(industries, totalAcv, 8);
  const buyerSites = rank(websites, totalAcv, 8);
  const buyerSocial = rank(social, totalAcv, 8);

  const stSocial = st ? stToAffinity(st.social, "sparktoro", "social") : [];
  const stSites = st ? stToAffinity(st.websites, "sparktoro", "site") : [];
  const stYt = st ? stToAffinity(st.youtube, "sparktoro", "youtube") : rank(youtube, totalAcv, 12);
  const stPods = st ? stToAffinity(st.podcasts, "sparktoro", "podcast") : rank(podcasts, totalAcv, 12);
  const stReddit = st ? stToAffinity(st.reddit, "sparktoro", "subreddit") : rank(reddit, totalAcv, 12);
  const stKw = st ? stToAffinity(st.keywords, "sparktoro", "keyword") : rank(keywords, totalAcv, 16);
  const stApps = st ? stToAffinity(st.apps, "sparktoro", "app") : rank(apps, totalAcv, 14);
  const stBios = st ? stToAffinity(st.bios, "sparktoro", "bio") : rank(bios, totalAcv, 16);
  const stPress = st ? stToAffinity(st.press, "sparktoro", "press") : [];
  const stNets = st ? stToAffinity(st.networks, "sparktoro", "network") : [];
  const stPrompts = st ? stToAffinity(st.prompts, "sparktoro", "prompt") : [];

  const socialRows = [...buyerSocial, ...stSocial].slice(0, 40);
  const siteRows = [...stSites, ...buyerSites].slice(0, 40);
  const podRows = stPods;
  const redditRows = stReddit;

  const segments: IcpSegment[] = buyers.map((b) => ({
    name: [b.company, b.industry].filter(Boolean).join(" · ") || b.domain,
    shareOfRevenue: b.sharePct,
    who: [b.name, b.title, b.email].filter(Boolean).join(" · ") || b.domain,
    whereToShowUp: [
      b.linkedin ? "LinkedIn (this buyer)" : "",
      ...socialRows.filter((s) => s.kind === "linkedin").slice(0, 1).map((s) => s.name),
      ...redditRows.slice(0, 1).map((s) => s.name),
      ...podRows.slice(0, 1).map((s) => s.name),
    ].filter(Boolean),
    evidence: [
      `ACV weight ${b.sharePct}%`,
      b.industry || "industry unknown",
      b.size ? `${b.size} employees` : "",
      b.location || "",
    ].filter(Boolean),
  }));

  /* collapse identical industry+function */
  const collapsed = new Map<string, IcpSegment>();
  for (const s of segments) {
    const key = `${s.name}`.toLowerCase();
    const cur = collapsed.get(key);
    if (!cur) collapsed.set(key, { ...s });
    else {
      cur.shareOfRevenue = Math.round((cur.shareOfRevenue + s.shareOfRevenue) * 10) / 10;
      if (!cur.who.includes(s.who)) cur.who = `${cur.who} · ${s.who}`;
    }
  }
  const segmentRows = [...collapsed.values()].sort((a, b) => b.shareOfRevenue - a.shareOfRevenue);

  const takeAction: string[] = [];
  if (titleRows[0])
    takeAction.push(
      `Outbound to “${titleRows[0].name}” — ${titleRows[0].pct}% of named ACV (people who paid).`,
    );
  if (functionRows[0]) takeAction.push(`Function to buy: ${functionRows.map((f) => `${f.name} (${f.pct}%)`).join(", ")}.`);
  if (industryRows[0]) takeAction.push(`Industry: ${industryRows.map((i) => `${i.name} (${i.pct}%)`).slice(0, 3).join(" · ")}.`);
  if (st?.tam?.estimated_population)
    takeAction.push(
      `TAM: ${st.tam.estimated_population.toLocaleString()} people · ${st.tam.currency} ${Math.round((st.tam.estimated_market_value ?? 0) / 1e6)}M market value (SparkToro).`,
    );
  if (stSites[0]) takeAction.push(`Sponsor / SEO: ${stSites.slice(0, 5).map((s) => s.name).join(", ")} — SparkToro websites this audience visits (affinity ${stSites[0].affinity}).`);
  if (stSocial[0]) takeAction.push(`Creators they follow: ${stSocial.slice(0, 5).map((s) => s.name).join(", ")}.`);
  if (stPods[0]) takeAction.push(`Podcasts they download: ${stPods.slice(0, 4).map((s) => s.name).join(", ")}.`);
  if (stReddit[0]) takeAction.push(`Subreddits: ${stReddit.slice(0, 5).map((s) => s.name).join(", ")}.`);
  if (stKw[0]) takeAction.push(`Search terms: ${stKw.slice(0, 5).map((s) => `${s.name} (aff ${s.affinity})`).join(", ")}.`);
  if (stPress[0]) takeAction.push(`PR list: ${stPress.slice(0, 4).map((s) => s.name).join(", ")}.`);
  const topLike = rank(lookalikes, totalAcv, 5);
  if (topLike[0]) takeAction.push(`Clone paying logos: ${topLike.slice(0, 4).map((l) => l.name).join(", ")}.`);
  if (buyers[0]?.email)
    takeAction.push(`Highest-weight buyer: ${buyers[0].email}${buyers[0].title ? ` (${buyers[0].title})` : ""} at ${buyers[0].company}.`);

  const you = youCo?.data;
  const out = {
    company: {
      domain,
      name: you?.displayName || you?.name || domain,
      brief: brief || you?.headline || you?.description || "",
      products: (you?.tags ?? []).slice(0, 8),
    },
    spend: { totalAcv: parsed.length ? totalAcv : 0, weightedCustomers: buyers.length },
    buyers,
    demographics: {
      titles: titleRows,
      seniority: rank(seniority, totalAcv, 6),
      industries: industryRows.length ? industryRows : stToAffinity(st?.demographics.industry ?? [], "sparktoro", "industry"),
      sizes: rank(sizes, totalAcv, 6).length ? rank(sizes, totalAcv, 6) : stToAffinity(st?.demographics.company_employee_count ?? [], "sparktoro", "size"),
      locations: [
        ...rank(locations, totalAcv, 8),
        ...stToAffinity(st?.demographics.country ?? [], "sparktoro", "location"),
        ...stToAffinity(st?.demographics.state ?? [], "sparktoro", "location"),
      ].slice(0, 12),
      functions: functionRows,
      age: stToAffinity(st?.demographics.age ?? [], "sparktoro", "age"),
      gender: stToAffinity(st?.demographics.gender ?? [], "sparktoro", "gender"),
      salary: stToAffinity(st?.demographics.salary ?? [], "sparktoro", "salary"),
      audienceTitles: stToAffinity(st?.demographics.title_role ?? [], "sparktoro", "title"),
    },
    social: socialRows,
    websites: siteRows,
    youtube: stYt,
    podcasts: podRows,
    reddit: redditRows,
    keywords: stKw,
    apps: stApps.length ? stApps : rank(apps, totalAcv, 14),
    bioPhrases: stBios.length ? stBios : rank(bios, totalAcv, 16),
    lookalikes: topLike,
    press: stPress,
    networks: stNets,
    prompts: stPrompts,
    tam: st?.tam ?? null,
    sparkToro: st?.reportId ? { reportId: st.reportId, prompt: st.prompt, creditsRemaining: st.creditsRemaining } : null,
    segments: segmentRows,
    takeAction,
    sources: [...sources],
    durationMs: Date.now() - t0,
  };
  saveIcpReport(out);
  return out;
}
