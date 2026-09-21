/**
 * Live LinkedIn people via guest APIs + Decodo Fast Search shards.
 * Decodo rotates residential/ISP exits per request — we never share one IP.
 */

import { compact, companyNameFitsDomain, companyOnCard, distinctiveTokens, isCollisionBrand, legalForm, linkedinFitsDomain, personFitsEmployer, spacedBrand } from "./identity-lock";
import { titleMatchesRoles } from "./role-filter";

export interface LinkedInCompany {
  name: string;
  slug: string;
  linkedinUrl: string;
  website: string | null;
  industry?: string;
  size?: string;
  hq?: string;
  type?: string;
  description?: string;
  companyId?: string;
  staffCount?: number;
}

export interface LiveJob {
  title: string;
  location: string;
  department: string;
}

export interface LinkedInPerson {
  fullName: string;
  firstName: string;
  lastName: string;
  title?: string;
  location?: string;
  department?: string;
  seniority?: "decision" | "ic";
  profileUrl: string;
  slug: string;
  email?: string;
  emailScore?: number;
}

const TYPEAHEAD =
  "https://www.linkedin.com/jobs-guest/api/typeaheadHits?typeaheadType=COMPANY&query=";
const JOBS =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?f_C=";
const GUEST = "https://www.linkedin.com/organization-guest/company/";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const LEGAL =
  /^(pvt|ltd|llc|inc|llp|plc|gmbh|sa|pty|co|corp|corporation|company|private|limited|the|and|of)$/i;

const searchCache = new Map<string, LinkedInCompany[]>();

function hyphenSlug(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function cleanCompanyLabel(raw: string | null | undefined, domain: string): string {
  const brand = (domain.split(".")[0] ?? domain).replace(/[^a-z0-9]+/gi, "");
  const fallback = brand.charAt(0).toUpperCase() + brand.slice(1);
  if (!raw) return fallback;
  const s = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || s.length < 2 || s.length > 80) return fallback;
  if (/[<>]|doctype|^\s*html\b|just a moment|access denied/i.test(s)) return fallback;
  if (!new RegExp(brand, "i").test(s) && s.split(/\s+/).length > 3) return fallback;
  return s;
}

function hostFromUrl(raw: string): string | null {
  const t = raw.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const host = t.split("/")[0]?.split("?")[0]?.toLowerCase() ?? "";
  if (!host.includes(".") || host.includes("linkedin.com")) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return null;
  return host;
}

async function getText(url: string, ms: number, accept: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(ms),
      headers: {
        Accept: accept,
        "User-Agent": BROWSER_UA,
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    return (await res.text()).slice(0, 400_000);
  } catch {
    return null;
  }
}

interface TaHit {
  id: string;
  displayName: string;
}

async function typeahead(q: string): Promise<TaHit[]> {
  const raw = await getText(
    `${TYPEAHEAD}${encodeURIComponent(q)}`,
    3500,
    "application/json",
  );
  if (!raw || raw.length < 4) return [];
  try {
    const rows = JSON.parse(raw) as Array<{
      id?: string;
      displayName?: string;
    }>;
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r) => r.id && r.displayName)
      .map((r) => ({ id: String(r.id), displayName: r.displayName! }))
      .slice(0, 6);
  } catch {
    return [];
  }
}

async function expandPhrases(q: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}`,
      { signal: AbortSignal.timeout(2000) },
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ phrase?: string }>;
    return rows.map((r) => r.phrase ?? "").filter(Boolean).slice(0, 6);
  } catch {
    return [];
  }
}

function slugsForName(name: string): string[] {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !LEGAL.test(w));
  const core = words.join("-");
  const out = new Set<string>();
  if (core) out.add(core);
  out.add(hyphenSlug(name));
  if (core) {
    out.add(`${core}-pvt-ltd`);
    out.add(`${core}-private-limited`);
    out.add(words.join(""));
  }
  return [...out].filter((s) => s.length >= 2).slice(0, 4);
}

function parseGuestPage(html: string, slug: string, companyId?: string): LinkedInCompany | null {
  if (
    /uas\/login|Sign in to LinkedIn|session_redirect/i.test(html.slice(0, 4000)) &&
    html.length < 80_000
  ) {
    return null;
  }
  const title =
    html.match(/<title>([^<|]+)\s*\|?\s*LinkedIn/i)?.[1]?.trim() ??
    html.match(/top-card-layout__title[^>]*>([^<]+)/i)?.[1]?.trim() ??
    null;
  if (!title || /sign in|join now|^linkedin$|html>/i.test(title)) return null;
  const name = title.replace(/\s+/g, " ").slice(0, 80);
  if (/[<>]|^\s*html\b/i.test(name)) return null;

  let website: string | null = null;
  const redir = html.match(/redir\/redirect\?url=([^"'&]+)/i);
  if (redir) {
    try {
      website = hostFromUrl(decodeURIComponent(redir[1]));
    } catch {
      website = hostFromUrl(redir[1]);
    }
  }

  const about = (label: string) => {
    const m =
      html.match(
        new RegExp(`${label}\\s*</dt>\\s*<dd[^>]*>\\s*([^<]{2,80})`, "i"),
      ) ?? html.match(new RegExp(`${label}\\s+([^\\n<]{2,80})`, "i"));
    return m?.[1]?.replace(/\s+/g, " ").trim();
  };

  const emp =
    html.match(/([\d,]+)\s*employees/i)?.[1]?.replace(/,/g, "") ??
    html.match(/Company size[^<]*?([\d,]+\+?)/i)?.[1];
  const staffCount = emp ? Number(String(emp).replace(/[^\d]/g, "")) : undefined;

  return {
    name,
    slug,
    linkedinUrl: `https://www.linkedin.com/company/${slug}/`,
    website,
    industry: about("Industry"),
    size: staffCount
      ? `${staffCount.toLocaleString()} employees`
      : about("Company size"),
    hq: about("Headquarters"),
    type: about("Type"),
    description: html
      .match(/top-card-layout__headline[^>]*>([\s\S]*?)<\//i)?.[1]
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280),
    companyId,
    staffCount: Number.isFinite(staffCount) ? staffCount : undefined,
  };
}

export async function searchLinkedInCompanies(query: string): Promise<LinkedInCompany[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const key = q.toLowerCase();
  if (searchCache.has(key)) return searchCache.get(key)!;
  const hits = await typeahead(q);
  const out: LinkedInCompany[] = [];
  for (const h of hits) {
    const slugs = slugsForName(h.displayName);
    out.push({
      name: h.displayName,
      slug: slugs[0] ?? hyphenSlug(h.displayName),
      linkedinUrl: `https://www.linkedin.com/company/${slugs[0] ?? hyphenSlug(h.displayName)}/`,
      website: null,
      companyId: h.id,
    });
  }
  searchCache.set(key, out);
  return out;
}

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
  "Department unknown",
] as const;

export function departmentOf(title?: string): string {
  const t = (title ?? "").toLowerCase();
  if (!t) return "Department unknown";
  if (/\b(cmo|chief marketing|marketing|brand|demand gen)\b/.test(t))
    return "Marketing";
  if (/\b(sales|account executive|\bae\b|business development|revenue)\b/.test(t))
    return "Sales";
  if (/\b(cfo|chief financial|finance|treasury|audit)\b/.test(t)) return "Finance";
  if (/\b(accountant|controller|bookkeep)\b/.test(t)) return "Accounting";
  if (/\b(chro|chief people|human resources|\bhr\b|talent|recruit)\b/.test(t))
    return "Human Resources";
  if (/\b(general counsel|chief legal|legal|attorney|compliance)\b/.test(t))
    return "Legal";
  if (
    /\b(cto|cio|chief technology|chief information|software|developer|devops|\bit\b|information technology|cyber)\b/.test(
      t,
    )
  )
    return "Information Technology";
  if (
    /\b(engineer|engineering|geolog|environmental|civil|structural|mechanical|electrical|hydrogeolog|water resource|technical director|system integrator|modeller|geotechnical)\b/.test(
      t,
    )
  )
    return "Engineering";
  if (/\b(realtor|broker|real estate|property manager|leasing)\b/.test(t))
    return "Real Estate";
  if (/\b(coo|chief operating|operations|delivery)\b/.test(t)) return "Operations";
  if (/\b(consult|advisor|advisory)\b/.test(t)) return "Consulting";
  if (/\b(product manager|product owner|product management)\b/.test(t))
    return "Product Management";
  if (/\b(program manager|project manager|\bpmo\b|project management)\b/.test(t))
    return "Program and Project Management";
  if (/\b(research|scientist|data analyst|analytics)\b/.test(t)) return "Research";
  if (/\b(ux|ui|graphic|creative director)\b/.test(t)) return "Arts and Design";
  if (/\b(nurse|doctor|clinical|medical|pharma|healthcare)\b/.test(t))
    return "Healthcare Services";
  if (/\b(learning and development|\bl&d\b|l & d|training specialist|instructional designer|people development)\b/.test(t))
    return "Human Resources";
  if (/\b(professor|lecturer|teacher|faculty|principal|dean|school)\b/.test(t))
    return "Education";
  if (/\b(buyer|procurement|sourcing|purchasing)\b/.test(t)) return "Purchasing";
  if (/\b(quality assurance|\bqa\b)\b/.test(t)) return "Quality Assurance";
  if (/\b(admin|office manager|executive assistant|secretary|coordonnateur)\b/.test(t))
    return "Administrative";
  if (/\b(support|helpdesk|customer success)\b/.test(t)) return "Support";
  if (/\b(pr\b|public relations|communications|media)\b/.test(t))
    return "Media and Communication";
  if (/\b(business development|\bbd\b|partnership)\b/.test(t))
    return "Business Development";
  if (/\b(founder|owner|chief executive|\bceo\b|chairman|chairperson)\b/.test(t))
    return "Entrepreneurship";
  if (/\b(vice president|\bvp\b|head of|general manager|director)\b/.test(t))
    return "Operations";
  return "Department unknown";
}

export function isDecisionTitle(title?: string): boolean {
  return /\b(ceo|cfo|cto|coo|cio|cmo|chro|chief|founder|president|chairman|director|vice president|\bvp\b|head of|partner|principal|managing director|owner)\b/.test(
    (title ?? "").toLowerCase(),
  );
}

function decoratePerson(p: LinkedInPerson): LinkedInPerson {
  const fullName = cleanPersonName(p.fullName);
  const bits = fullName.split(/\s+/).filter(Boolean);
  const firstName = bits[0] || p.firstName;
  const lastName = bits.slice(1).join(" ") || cleanPersonName(p.lastName);
  return {
    ...p,
    fullName,
    firstName,
    lastName,
    department: departmentOf(p.title),
    seniority: isDecisionTitle(p.title) ? "decision" : "ic",
  };
}

function cleanPersonName(raw: string): string {
  return raw
    .replace(/\([^)]*\)/g, " ")
    .replace(/[®©™]/g, "")
    .replace(
      /,?\s*(P\.?\s*Eng\.?|PMP|M\.?\s*Sc\.?|Ph\.?\s*D\.?|MBA|CPA|\bPE\b|CEng)\.?\s*/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function personKey(p: { firstName: string; lastName: string; slug: string }): string {
  const n = `${p.firstName} ${p.lastName}`
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return n || p.slug.toLowerCase();
}

function nameFromCompanySlug(slug: string): { first: string; last: string } | null {
  const parts = slug
    .toLowerCase()
    .split("-")
    .filter(Boolean)
    .filter(
      (p) =>
        !/^\d+$/.test(p) &&
        !/^[a-f0-9]{5,}$/i.test(p) &&
        !/^[a-z]{1,3}\d+[a-z0-9]*$/i.test(p) &&
        !/^(pe|eng|ceng|phd|mba|cpt|rpeq|fiet|p-e)$/i.test(p),
    );
  if (parts.length < 2) return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return { first: cap(parts[0]!), last: cap(parts[1]!) };
}

const TITLE_START =
  /^(chief|vice|managing|general|principal|director|head|senior|lead|partner|founder|ceo|cfo|cto|coo|cio|engineer|consultant|officer|information|manager|analyst)\b/i;

function isPersonName(s: string): boolean {
  const bits = s.split(/\s+/).filter(Boolean);
  if (bits.length < 2 || bits.length > 5) return false;
  if (TITLE_START.test(bits[0]!)) return false;
  if (bits.some((b) => /^(linkedin|member|employees|see)$/i.test(b))) return false;
  return true;
}

function titlesFromFeed(
  html: string,
): Map<string, { name: string; title?: string }> {
  const out = new Map<string, { name: string; title?: string }>();
  const TITLE_PHRASE =
    "((?:Chief\\s+\\w+(?:\\s+\\w+)?|Vice\\s+President|Managing\\s+Director|General\\s+Manager|Principal(?:\\s+\\w+)?|Director(?:\\s+of\\s+\\w+)?|Head\\s+of\\s+[\\w& ]+|Senior\\s+\\w+(?:\\s+\\w+)?|CEO|CFO|CTO|COO|CIO)(?:\\s+(?:of|for)\\s+[\\w& ]{2,40})?)";
  const titleName = new RegExp(
    `${TITLE_PHRASE}\\s+([A-Z][a-zA-Z.'\\-]+(?:\\s+[A-Z][a-zA-Z.'\\-]+){1,3})`,
    "g",
  );
  const blocks = [
    ...html.matchAll(
      /main-feed-activity-card__commentary[^>]*>([\s\S]{0,1500}?)(?:<\/p>|<\/div>|data-test-id)/gi,
    ),
  ];
  for (const b of blocks) {
    const text = b[1]
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    for (const m of text.matchAll(titleName)) {
      const title = m[1].replace(/\s+/g, " ").trim();
      const name = m[2].replace(/\s+/g, " ").trim();
      if (!isPersonName(name)) continue;
      out.set(hyphenSlug(name), { name, title });
    }
    for (const m of text.matchAll(
      /([A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+)+)\s+from our\s+([^.]{6,60}?)(?:\s+team)?/g,
    )) {
      if (isPersonName(m[1].trim())) {
        out.set(hyphenSlug(m[1].trim()), {
          name: m[1].trim(),
          title: m[2].trim(),
        });
      }
    }
  }
  for (const m of html.matchAll(/\/in\/([a-zA-Z0-9_%\-]+)/gi)) {
    const slug = decodeURIComponent(m[1]);
    if (out.has(slug)) continue;
    const parsed = nameFromCompanySlug(slug);
    if (!parsed) continue;
    const key = hyphenSlug(`${parsed.first} ${parsed.last}`);
    const hit = out.get(key);
    if (hit) out.set(slug, hit);
  }
  return out;
}

function peopleFromGuestHtml(html: string): LinkedInPerson[] {
  const people: LinkedInPerson[] = [];
  const seen = new Set<string>();
  const titleBySlug = titlesFromFeed(html);

  const add = (slug: string, labeled?: string, title?: string) => {
    slug = decodeURIComponent(slug).replace(/\/+$/, "");
    if (seen.has(slug) || slug.length < 2) return;
    const parsed =
      labeled && isPersonName(labeled)
        ? (() => {
            const bits = labeled.split(/\s+/).filter(Boolean);
            return { first: bits[0]!, last: bits.slice(1).join(" ") };
          })()
        : nameFromCompanySlug(slug);
    if (!parsed?.first || !parsed.last) return;
    const key = `${parsed.first} ${parsed.last}`.toLowerCase();
    if (people.some((p) => p.fullName.toLowerCase() === key)) return;
    seen.add(slug);
    const hit = titleBySlug.get(slug) ?? titleBySlug.get(hyphenSlug(key));
    people.push(
      decoratePerson({
        fullName: `${parsed.first} ${parsed.last}`,
        firstName: parsed.first,
        lastName: parsed.last,
        title: title ?? hit?.title,
        profileUrl: `https://www.linkedin.com/in/${slug}/`,
        slug,
      }),
    );
  };

  for (const m of html.matchAll(
    /href="([^"]*\/in\/([a-zA-Z0-9_%\-]+)[^"]*)"/gi,
  )) {
    const href = m[1];
    const slug = m[2];
    if (/trk=org-employees/i.test(href)) {
      add(slug);
      continue;
    }
    if (
      /organization_guest_main-feed-card-text/i.test(href) &&
      !/reshare|card_resh/i.test(href)
    ) {
      add(slug);
    }
  }
  for (const { name, title } of titleBySlug.values()) {
    if (!isPersonName(name) || !title) continue;
    add(hyphenSlug(name), name, title);
  }
  return people;
}

async function liveJobs(companyId: string): Promise<LiveJob[]> {
  const html = await getText(
    `${JOBS}${encodeURIComponent(companyId)}&start=0`,
    4500,
    "text/html",
  );
  if (!html) return [];
  const titles = [
    ...html.matchAll(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/gi),
  ].map((m) =>
    m[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/&/g, "&")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const locs = [
    ...html.matchAll(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/gi),
  ].map((m) =>
    m[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const jobs: LiveJob[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < titles.length; i++) {
    const title = titles[i]!;
    const location = locs[i] ?? "";
    const key = `${title}|${location}`;
    if (seen.has(key) || title.length < 3) continue;
    seen.add(key);
    jobs.push({ title, location, department: departmentOf(title) });
  }
  return jobs.slice(0, 40);
}

async function serpLinkedInPeople(opts: {
  companyName: string;
  domain: string;
  companyId?: string;
  legalName?: string;
  roles?: string[];
}): Promise<LinkedInPerson[]> {
  const companyName = opts.companyName;
  const domain = opts.domain;
  const brand = compact(companyName);
  if (brand.length < 2) return [];
  const qName = companyName.length <= 5 ? companyName.toUpperCase() : companyName;
  const collision = (await import("./identity-lock")).isCollisionBrand(domain);
  const { personFitsEmployer } = await import("./identity-lock");
  const { titleMatchesRoles } = await import("./role-filter");
  const host =
    domain.endsWith(".au") ? "au.linkedin.com" :
    domain.endsWith(".uk") ? "uk.linkedin.com" :
    domain.endsWith(".in") ? "in.linkedin.com" :
    "linkedin.com";
  const { serpRoleShards } = await import("./role-filter");
  const shards = opts.roles?.length
    ? serpRoleShards(qName, domain, opts.roles)
    : [
        `site:linkedin.com/in "${qName}"`,
        `site:linkedin.com/in "at ${qName}"`,
        `site:${host}/in "${qName}"`,
        `site:linkedin.com/in "${domain}"`,
        `site:linkedin.com/in "${qName}" (Director OR Manager OR Engineer OR Founder OR Consultant OR Head)`,
      ];
  if (!opts.roles?.length && opts.legalName && compact(opts.legalName) !== compact(qName)) {
    shards.push(`site:linkedin.com/in "${opts.legalName}"`);
  }

  const { decodoShards, peopleFromOrganic } = await import("./decodo-serp");
  const okkQs = [
    `site:${host}/in "at ${qName}"`,
    `site:linkedin.com/in "${qName}"`,
  ];
  const voyagerP = import("./voyager-people")
    .then(async (m) => {
      const companyId =
        opts.companyId ||
        (await typeahead(qName).then((ta) => ta[0]?.id));
      return m.voyagerPeopleFanout(qName, companyId, opts.roles ?? []);
    })
    .catch(() => ({
      hits: [] as Array<{ name: string; title?: string; slug: string; url: string }>,
      total: 0,
      detail: "err",
    }));
  const [pages, okkHits, voyager] = await Promise.all([
    decodoShards(shards),
    import("./okk-bing-serp")
      .then((m) => m.okkBingShards(okkQs, qName))
      .catch(() => []),
    voyagerP,
  ]);

  const out: LinkedInPerson[] = [];
  const seen = new Set<string>();
  const addHit = (
    row: {
      name: string;
      title?: string;
      slug: string;
      url: string;
    },
    trusted: boolean,
  ) => {
    if (!isPersonName(row.name)) return;
    if (
      !trusted &&
      collision &&
      !personFitsEmployer({
        title: row.title ?? "",
        blob: `${row.name} ${row.title ?? ""}`,
        domain,
        company: companyName,
        legalName: opts.legalName || companyName,
      })
    )
      return;
    if (opts.roles?.length && row.title && !titleMatchesRoles(row.title, opts.roles)) return;
    if (seen.has(row.slug)) {
      const ex = out.find((p) => p.slug === row.slug);
      if (ex && row.title && !ex.title) {
        ex.title = row.title;
        const d = decoratePerson(ex);
        ex.department = d.department;
        ex.seniority = d.seniority;
      }
      return;
    }
    seen.add(row.slug);
    const bits = row.name.split(/\s+/);
    out.push(
      decoratePerson({
        fullName: row.name,
        firstName: bits[0]!,
        lastName: bits.slice(1).join(" "),
        title: row.title,
        profileUrl: row.url || `https://www.linkedin.com/in/${row.slug}/`,
        slug: row.slug,
      }),
    );
  };
  for (const rows of pages) {
    for (const row of peopleFromOrganic(rows, qName, domain)) addHit(row, false);
  }
  for (const row of okkHits) addHit(row, false);
  for (const row of voyager.hits) addHit(row, Boolean(opts.companyId));
  return out;
}

function doctorsFromHtml(html: string): LinkedInPerson[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ");
  const skip = /\b(soroush|zaghi|kerstein|won moon|robert kerstein)\b/i;
  const counts = new Map<string, number>();
  for (const m of text.matchAll(
    /\b(?:Dr\.?|Doctor)\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z.]{1,20}){1,3})/g,
  )) {
    const name = m[1]!.replace(/\s+/g, " ").trim();
    if (skip.test(name) || !isPersonName(name)) continue;
    if (/\b(Award|Institute|USA|London|Los Angeles|Practitioners?)\b/.test(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const out: LinkedInPerson[] = [];
  for (const [name, n] of counts) {
    if (n < 2) continue;
    const bits = name.split(/\s+/);
    const slug = hyphenSlug(name);
    out.push(
      decoratePerson({
        fullName: name,
        firstName: bits[0]!,
        lastName: bits.slice(1).join(" "),
        title: "Doctor",
        profileUrl: `https://www.linkedin.com/in/${slug}/`,
        slug,
      }),
    );
  }
  return out.slice(0, 12);
}

async function orgFromTypeahead(domain: string, nameHint: string): Promise<LinkedInCompany | null> {
  const brand = domain.split(".")[0] ?? domain;
  const collision = isCollisionBrand(domain);
  const queries = [...new Set([domain, nameHint, ...(collision ? [] : [spacedBrand(brand), brand])].filter((q) => q && q.length >= 3))];
  for (const q of queries) {
    const hits = await typeahead(q);
    for (const h of hits) {
      const slugs = [
        ...slugsForName(h.displayName),
        hyphenSlug(h.displayName),
      ];
      for (const slug of slugs.slice(0, 3)) {
        const html = await getText(`${GUEST}${encodeURIComponent(slug)}`, 5000, "text/html");
        if (!html || html.length < 2000) continue;
        const page = parseGuestPage(html, slug, h.id);
        if (!page) continue;
        if (linkedinFitsDomain({ website: page.website, name: page.name, domain })) {
          return { ...page, companyId: h.id };
        }
      }
    }
  }
  return null;
}

export async function discoverLinkedInForDomain(
  domain: string,
  opts: { roles?: string[] } = {},
): Promise<{
  company: LinkedInCompany | null;
  people: LinkedInPerson[];
  jobs: LiveJob[];
  detail: string;
  related?: Array<{ name: string; domain?: string }>;
}> {
  const brand = domain.split(".")[0] ?? domain;
  const tld = domain.split(".").slice(1).join(".");
  const tried = new Set<string>();
  const siteHtml = await getText(`https://${domain}/`, 8000, "text/html");
  const siteName =
    siteHtml
      ?.match(/property=["']og:site_name["'][^>]+content=["']([^"']+)/i)?.[1]
      ?.trim() ||
    siteHtml
      ?.match(/<title[^>]*>([^<]+)/i)?.[1]
      ?.split(/[|\-–—]/)[0]
      ?.trim() ||
    spacedBrand(brand);
  const sitePeople = siteHtml ? doctorsFromHtml(siteHtml) : [];

  const trySlug = async (
    slug: string,
  ): Promise<{ company: LinkedInCompany; people: LinkedInPerson[] } | null> => {
    if (!slug || tried.has(slug)) return null;
    tried.add(slug);
    const html = await getText(
      `${GUEST}${encodeURIComponent(slug)}`,
      5000,
      "text/html",
    );
    if (!html || html.length < 2000) return null;
    const page = parseGuestPage(html, slug);
    if (page && !linkedinFitsDomain({ website: page.website, name: page.name, domain })) {
      return null;
    }
    const people = peopleFromGuestHtml(html);
    if (!page && people.length === 0) return null;
    return {
      company:
        page ?? {
          name: companyNameFitsDomain(siteName, domain) ? siteName : spacedBrand(brand),
          slug,
          linkedinUrl: `https://www.linkedin.com/company/${slug}/`,
          website: domain,
        },
      people,
    };
  };

  const locked = await orgFromTypeahead(domain, siteName);
  const distinctive = distinctiveTokens(siteName, domain).length > 0;
  const qName = distinctive
    ? siteName
    : companyNameFitsDomain(siteName, domain)
      ? siteName
      : spacedBrand(brand).length > 3
        ? spacedBrand(brand)
        : brand.length <= 5
          ? brand.toUpperCase()
          : brand;
  const companyId = locked?.companyId;
  const { voyagerCompany } = await import("./voyager-people");
  const hunterTok = import("./hunter-trial").then((m) =>
    m.solveTurnstile("https://hunter.io/email-finder"),
  );
  const [direct, serp, org, jobs0, theorg, sn] = await Promise.all([
    (async () => {
      if (locked) return { company: locked, people: [] as LinkedInPerson[] };
      const preferred = tld && tld.length <= 4 ? `${brand}-${tld}` : brand;
      return (await trySlug(preferred)) ?? (await trySlug(brand));
    })(),
    serpLinkedInPeople({
      companyName: qName,
      domain,
      companyId,
      legalName: siteName,
      roles: opts.roles,
    }),
    companyId ? voyagerCompany(companyId).catch(() => null) : null,
    companyId ? liveJobs(companyId) : Promise.resolve([] as LiveJob[]),
    import("./theorg-people")
      .then((m) => m.theOrgPeople(domain, qName))
      .catch(() => ({ hits: [] as Array<{ name: string; title?: string; slug: string; url: string }>, positions: 0, teams: 0, related: [] })),
    companyId
      ? import("./sales-nav")
          .then((m) =>
            m.salesNavLeadSearch(
              { keywords: opts.roles?.length ? opts.roles.join(" ") : "" },
              [companyId],
              opts.roles?.length ? 100 : 2500,
            ),
          )
          .catch(() => ({ hits: [] as Array<{ name: string; title?: string; url?: string; slug?: string }> }))
      : Promise.resolve({ hits: [] as Array<{ name: string; title?: string; url?: string; slug?: string }> }),
  ]);
  let company: LinkedInCompany | null = locked ?? direct?.company ?? null;
  if (company && !linkedinFitsDomain({ website: company.website, name: company.name, domain })) {
    company = null;
  }
  let people = direct?.people ?? [];

  if (!people.length) {
    const slugs: string[] = [];
    const ta = await typeahead(brand);
    for (const h of ta) slugs.push(...slugsForName(h.displayName));
    if (ta.length === 0) {
      const phrases = await expandPhrases(brand);
      for (const p of phrases.slice(0, 2)) {
        const more = await typeahead(p);
        for (const h of more) slugs.push(...slugsForName(h.displayName));
      }
    }
    for (const slug of slugs) {
      const hit = await trySlug(slug);
      if (hit?.company) company = hit.company;
      if (hit?.people.length) {
        people = hit.people;
        break;
      }
    }
  }

  const seen = new Set(people.map((p) => p.slug));
  const seenName = new Set(people.map((p) => personKey(p)));
  const addNamed = (p: LinkedInPerson, trusted = false) => {
    const row = decoratePerson(p);
    if (
      !trusted &&
      isCollisionBrand(domain) &&
      !personFitsEmployer({
        title: row.title ?? "",
        blob: `${row.fullName} ${row.title ?? ""}`,
        domain,
        company: qName,
        legalName: siteName,
        hq: company?.hq,
      })
    )
      return;
    if (
      opts.roles?.length &&
      row.title &&
      !titleMatchesRoles(row.title, opts.roles)
    )
      return;
    const nk = personKey(row);
    if (seen.has(row.slug) || seenName.has(nk)) {
      const ex = people.find((x) => x.slug === row.slug || personKey(x) === nk);
      if (ex && row.title && !ex.title) {
        ex.title = row.title;
        ex.department = row.department;
        ex.seniority = row.seniority;
      }
      return;
    }
    seen.add(row.slug);
    seenName.add(nk);
    people.push(row);
  };
  for (const p of serp) addNamed(p);
  for (const p of sitePeople) addNamed(p, true);
  for (const h of theorg.hits) {
    if (!isPersonName(cleanPersonName(h.name))) continue;
    const bits = cleanPersonName(h.name).split(/\s+/);
    addNamed({
      fullName: h.name,
      firstName: bits[0]!,
      lastName: bits.slice(1).join(" "),
      title: h.title,
      profileUrl: h.url,
      slug: h.slug,
    });
  }
  for (const h of sn.hits ?? []) {
    const name = "name" in h ? String(h.name) : "";
    if (!isPersonName(cleanPersonName(name))) continue;
    const bits = cleanPersonName(name).split(/\s+/);
    const slug =
      ("slug" in h && h.slug) ||
      ("url" in h && String(h.url).match(/\/in\/([^/?]+)/)?.[1]) ||
      "";
    addNamed({
      fullName: name,
      firstName: bits[0]!,
      lastName: bits.slice(1).join(" "),
      title: "title" in h ? String(h.title || "") : undefined,
      location: "location" in h ? String(h.location || "") : undefined,
      profileUrl: ("url" in h && String(h.url)) || `https://www.linkedin.com/in/${slug}/`,
      slug: String(slug),
    }, Boolean(companyId));
  }

  people.sort((a, b) => {
    const sa = a.seniority === "decision" ? 1 : 0;
    const sb = b.seniority === "decision" ? 1 : 0;
    if (sb !== sa) return sb - sa;
    return a.fullName.localeCompare(b.fullName);
  });

  const displayName = (distinctive ? siteName : company?.name ?? qName).replace(/\([^)]*\)/g, "").trim();
  if (
    displayName &&
    !isCollisionBrand(domain) &&
    companyNameFitsDomain(displayName, domain) &&
    compact(displayName) !== compact(qName) &&
    people.length < 80
  ) {
    const extra = await serpLinkedInPeople({
      companyName: displayName,
      domain,
      companyId,
      legalName: siteName,
      roles: opts.roles,
    });
    extra.forEach((p) => addNamed(p));
  }
  if (company && distinctive) {
    const missing = distinctiveTokens(siteName, domain).some(
      (t) => !company!.name.toLowerCase().includes(t.toLowerCase()),
    );
    if (missing || companyNameFitsDomain(company.name, domain) === false) {
      company = { ...company, name: siteName };
    }
  }

  const untitled = people.filter((p) => !p.title && p.fullName.split(/\s+/).length >= 2).slice(0, 12);
  if (untitled.length) {
    try {
      const { decodoSearch, peopleFromOrganic } = await import("./decodo-serp");
      const { mapPool } = await import("./http");
      await mapPool(untitled, 4, async (p) => {
        const name = p.fullName.replace(/"/g, "");
        const rows = (
          await Promise.all([
            decodoSearch(`site:linkedin.com/in "${name}" "${qName}"`),
            decodoSearch(`site:linkedin.com/in "${name}" "${domain}"`),
          ])
        ).flat();
        const hits = peopleFromOrganic(rows, qName, domain);
        const key = compact(p.fullName);
        const hit =
          hits.find((h) => compact(h.name) === key && h.title) ||
          hits.find((h) => h.title) ||
          hits[0];
        if (!hit) return;
        if (hit.title) p.title = hit.title.replace(/\s+-\s+LinkedIn$/i, "").trim();
        if (hit.url) p.profileUrl = hit.url;
        if (hit.slug) p.slug = hit.slug;
        const d = decoratePerson(p);
        p.department = d.department;
        p.seniority = d.seniority;
      });
    } catch {
      /* SERP titles optional */
    }
  }
  const still = people.filter((p) => !p.title && p.profileUrl).slice(0, 8);
  if (still.length) {
    const { enrichLinkedInProfile } = await import("./linkedin-public");
    await Promise.all(
      still.map(async (p) => {
        try {
          const prof = await enrichLinkedInProfile(p.profileUrl);
          if (!prof?.title) return;
          if (isCollisionBrand(domain) && prof.company && !companyOnCard(prof.company, qName, domain))
            return;
          p.title = prof.title;
          if (prof.location) p.location = prof.location;
          const d = decoratePerson(p);
          p.department = d.department;
          p.seniority = d.seniority;
        } catch {
          /* public card optional */
        }
      }),
    );
  }

  if (isCollisionBrand(domain)) {
    const selfForm = legalForm(siteName);
    people = people.filter((p) => {
      const t = p.title ?? "";
      const form = legalForm(t);
      if (selfForm && form && selfForm !== form) return false;
      if (
        /\bat\s+/i.test(t) &&
        !personFitsEmployer({
          title: t,
          blob: `${p.fullName} ${t} ${p.location ?? ""}`,
          domain,
          company: qName,
          legalName: siteName,
          hq: company?.hq,
        })
      )
        return false;
      return true;
    });
  }

  if (opts.roles?.length) {
    people = people.filter((p) => titleMatchesRoles(p.title, opts.roles ?? []));
  }

  people.sort((a, b) => {
    const sa = a.seniority === "decision" ? 1 : 0;
    const sb = b.seniority === "decision" ? 1 : 0;
    if (sb !== sa) return sb - sa;
    return a.fullName.localeCompare(b.fullName);
  });

  if (org && linkedinFitsDomain({ website: org.website ?? company?.website, name: org.name || company?.name, domain })) {
    company = {
      name: org.name || company?.name || brand,
      slug: org.universalName || company?.slug || hyphenSlug(brand),
      linkedinUrl: `https://www.linkedin.com/company/${org.universalName || company?.slug || brand}/`,
      website: company?.website ?? org.website ?? domain,
      industry: org.industry || company?.industry,
      hq: org.hq || company?.hq,
      type: company?.type,
      description: company?.description,
      companyId: companyId || company?.companyId,
      staffCount: org.staffCount,
      size: org.staffCount
        ? `${org.staffCount.toLocaleString()} employees`
        : company?.size,
    };
  } else if (company && companyId) {
    company.companyId = companyId;
  }

  const jobs = jobs0.length ? jobs0 : [];
  const locN = new Set(jobs.map((j) => j.location).filter(Boolean)).size;
  const deptN = new Set(
    people.map((p) => p.department).filter((d) => d && d !== "Department unknown"),
  ).size;
  const titled = people.filter((p) => p.title).length;

  try {
    const { hunterFindEmail, hunterDomainCount } = await import("./hunter-trial");
    const token = await hunterTok;
    if (token) {
      const targets = [
        ...people.filter((p) => p.seniority === "decision"),
        ...people.filter((p) => p.seniority !== "decision"),
      ].slice(0, 10);
      const [count, ...hits] = await Promise.all([
        hunterDomainCount(domain, token),
        ...targets.map((p) => hunterFindEmail(domain, p.fullName, token)),
      ]);
      if (typeof count === "number" && company) {
        company.size = `${company.size ?? ""} · Hunter ${count.toLocaleString()} emails`.replace(
          /^ · /,
          "",
        );
      }
      for (let i = 0; i < targets.length; i++) {
        const h = hits[i];
        if (!h?.email) continue;
        targets[i]!.email = h.email;
        targets[i]!.emailScore = h.score;
        if (h.linkedinUrl && !targets[i]!.profileUrl.includes("/in/")) {
          targets[i]!.profileUrl = h.linkedinUrl;
        }
      }
    }
  } catch {
    /* hunter trial optional */
  }

  return {
    company,
    people,
    jobs,
    related: theorg.related ?? [],
    detail: company
      ? `${company.name}${company.size ? ` · ${company.size}` : ""} · ${people.length} live names (${titled} titled)${opts.roles?.length ? ` · roles ${opts.roles.join(", ")}` : ""} · TheOrg ${theorg.hits.length}/${theorg.positions || "?"} · ${jobs.length} open roles · ${locN} cities / ${deptN} functions`
      : `Decodo SERP · ${people.length} named`,
  };
}

export async function fastLinkedInDomainSearch(
  domainInput: string,
  opts: { titleFilter?: string } = {},
) {
  const domain = domainInput
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]!;
  const t0 = Date.now();
  const { parseRoleFilter } = await import("./role-filter");
  const roles = parseRoleFilter(opts.titleFilter);
  const [li, tech, profile, companyFind] = await Promise.all([
    discoverLinkedInForDomain(domain, { roles }),
    import("./tech-stack").then((m) =>
      m.detectTechStack(domain).catch(() => ({
        technologies: [] as Array<{ name: string; category: string }>,
      })),
    ),
    import("./company-profile")
      .then((m) => {
        const hint = cleanCompanyLabel(undefined, domain);
        return m.enrichCompanyProfile(domain, hint);
      })
      .catch(() => ({
        similar: [] as Array<{ name: string; domain?: string }>,
        fundingStage: undefined as string | undefined,
        totalFunding: undefined as string | undefined,
        latestFunding: undefined as string | undefined,
        revenue: undefined as string | undefined,
      })),
    import("./company-find")
      .then((m) => m.findCompany(domain))
      .catch(() => null),
  ]);
  const jobBlob = (li.jobs ?? []).map((j) => j.title).join(" ");
  if (jobBlob) {
    const { JOB_TECH } = await import("./tech-stack");
    const seen = new Set(tech.technologies.map((t) => t.name));
    for (const r of JOB_TECH) {
      if (r.re.test(jobBlob) && !seen.has(r.name)) {
        seen.add(r.name);
        tech.technologies.push({
          name: r.name,
          category: r.category,
          evidence: "job title",
          confidence: 70,
        });
      }
    }
  }
  const emails = li.people
    .filter((p) => p.lastName)
    .map((p) => {
      const first = p.firstName.toLowerCase();
      const last = p.lastName.toLowerCase();
      const guessed = `${first}.${last}@${domain}`;
      const email = p.email || guessed;
      return {
        email,
        confidence: p.emailScore || (p.title ? 82 : 70),
        status: "found" as const,
        sources: [
          {
            url: p.profileUrl,
            extractedAt: new Date().toISOString(),
            kind: "public_graph" as const,
          },
        ],
        firstName: p.firstName,
        lastName: p.lastName,
        title: p.title,
        isRoleBased: false,
        kind: "person" as const,
        patternId: "first.last" as const,
        patternLabel: "first.last",
      };
    });
  const people = li.people
    .filter((p) => p.lastName)
    .map((p) => ({
      firstName: p.firstName,
      lastName: p.lastName,
      fullName: p.fullName,
      title: p.title,
      location: p.location,
      department: p.department,
      seniority: p.seniority,
      email:
        p.email ||
        `${p.firstName.toLowerCase()}.${p.lastName.toLowerCase()}@${domain}`,
      sourceUrl: p.profileUrl,
    }));
  const ms = Date.now() - t0;
  const c = companyFind?.data;
  const companyName = cleanCompanyLabel(c?.name ?? li.company?.name, domain);
  return {
    domain,
    companyName,
    website: `https://${domain}`,
    hasMx: c?.mx.hasMx ?? true,
    mxProvider: c?.emailProvider ?? null,
    mxHosts: c?.mx.hosts ?? [],
    industry: c?.category.industry ?? li.company?.industry ?? null,
    headcount: c?.metrics.employees ?? li.company?.size ?? null,
    hq: c?.location ?? li.company?.hq ?? null,
    companyType: c?.companyType ?? li.company?.type ?? null,
    description: c?.description ?? li.company?.description ?? null,
    jobs: li.jobs,
    technologies: (c?.technologies?.length ? c.technologies : tech.technologies).map((t) => ({
      name: t.name,
      category: t.category,
    })),
    fundingStage: c?.metrics.fundingStage ?? profile.fundingStage ?? null,
    totalFunding: c?.metrics.raised ?? profile.totalFunding ?? null,
    latestFunding: c?.metrics.latestFunding ?? profile.latestFunding ?? null,
    revenue: c?.metrics.estimatedAnnualRevenue ?? profile.revenue ?? null,
    similarCompanies: c?.similarCompanies?.length ? c.similarCompanies : profile.similar ?? [],
    logo: c?.logo ?? null,
    phone: c?.phone ?? null,
    tags: c?.tags ?? [],
    foundedYear: c?.foundedYear ?? null,
    emailProvider: c?.emailProvider ?? null,
    social: c?.social ?? [],
    ticker: c?.ticker ?? null,
    siteEmails: c?.site.emailAddresses ?? [],
    company: c
      ? { ...c, jobs: li.jobs ?? c.jobs, name: companyName }
      : undefined,
    emails,
    patterns: [
      {
        patternId: "first.last",
        label: "first.last",
        prevalence: 1,
        sampleCount: emails.length,
        example: `jane.doe@${domain}`,
      },
    ],
    pagesCrawled: 1,
    pagesAttempted: [li.company?.linkedinUrl ?? "linkedin-guest"],
    durationMs: ms,
    people,
    waterfall: [
      {
        id: "linkedin",
        provider: "LinkedIn + Decodo Fast Search",
        status: people.length ? "hit" : "miss",
        detail: li.detail,
        ms,
        emailsFound: emails.length,
        stoppedHere: true,
      },
    ],
    fromIndex: 0,
    fromCrawl: 0,
    fromGraph: people.length,
    peopleCount: people.length,
    legalName: cleanCompanyLabel(li.company?.name, domain),
    pipeline: [
      {
        id: "linkedin",
        label: "LinkedIn + Decodo Fast Search",
        status: people.length ? "ok" : "warn",
        detail: li.detail,
        ms,
      },
    ],
  };
}

/** Live name lookup when the harvested list doesn't have the person yet. */
export async function lookupPersonAtCompany(opts: {
  domain: string;
  companyName?: string;
  query: string;
}): Promise<
  Array<{
    firstName: string;
    lastName: string;
    fullName: string;
    title?: string;
    location?: string;
    department?: string;
    seniority?: "decision" | "ic";
    email?: string;
    sourceUrl?: string;
  }>
> {
  const q = opts.query.trim().replace(/"/g, "");
  if (q.length < 3) return [];
  const domain = opts.domain.replace(/^www\./, "").toLowerCase();
  const brand = cleanCompanyLabel(opts.companyName, domain);
  const { apialtEnabled, apialtLookupPerson } = await import("./apialt");
  if (apialtEnabled()) {
    try {
      const { isPlausibleName } = await import("./decodo-serp");
      const { cleanRoleTitle } = await import("./linkedin-public");
      const hits = await apialtLookupPerson(q, brand);
      const tokens = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
      const out: Array<{
        firstName: string;
        lastName: string;
        fullName: string;
        title?: string;
        location?: string;
        department?: string;
        seniority?: "decision" | "ic";
        email?: string;
        sourceUrl?: string;
      }> = [];
      const seen = new Set<string>();
      for (const h of hits) {
        if (!isPlausibleName(h.name)) continue;
        const lower = h.name.toLowerCase();
        if (tokens.some((t) => !lower.includes(t)) && tokens.length > 1) continue;
        if (tokens.length === 1 && !lower.includes(tokens[0]!)) continue;
        if (seen.has(h.slug.toLowerCase())) continue;
        seen.add(h.slug.toLowerCase());
        const bits = h.name.split(/\s+/);
        const p = decoratePerson({
          fullName: h.name,
          firstName: bits[0]!,
          lastName: bits.slice(1).join(" "),
          title: cleanRoleTitle(h.title, brand),
          profileUrl: `https://www.linkedin.com/in/${h.slug}/`,
          slug: h.slug,
        });
        out.push({
          firstName: p.firstName,
          lastName: p.lastName,
          fullName: p.fullName,
          title: p.title,
          location: h.location || p.location,
          department: p.department,
          seniority: p.seniority,
          sourceUrl: `https://www.linkedin.com/in/${h.slug}/`,
        });
      }
      if (out.length) return out;
    } catch {
      /* fall through to public SERP — never invent */
    }
  }
  const { decodoSearch, peopleFromOrganic, isPlausibleName } = await import("./decodo-serp");
  const { profileSlugFromUrl, identityLocked } = await import("./identity-lock");
  const queries = [
    `site:linkedin.com/in "${q}" "${brand}"`,
    `site:linkedin.com/in "${q}" "${domain}"`,
    `"${q}" "at ${brand}" site:linkedin.com/in`,
    `"${q}" "${domain}" site:linkedin.com/in`,
    `site:linkedin.com/posts "${q}" "${brand}"`,
    `site:linkedin.com/posts "${q}" "${domain}"`,
    `"${q}" "${brand}" (director OR founder OR "co-founder")`,
  ];
  const rows = (await Promise.all(queries.map((x) => decodoSearch(x)))).flat();
  const hits = peopleFromOrganic(rows, brand, domain);
  const extra = rows
    .map((r) => {
      const url = r.link ?? "";
      const slug = profileSlugFromUrl(url);
      if (!slug) return null;
      const title = r.title ?? "";
      if (!identityLocked({ title, fullName: q, company: brand, domain })) return null;
      const blob = `${title} ${r.description ?? ""}`;
      if (/\b(former|ex-|previously|alumni)\b/i.test(blob)) return null;
      const head = (r.title ?? "").replace(/\s*\|\s*LinkedIn.*$/i, "").split(/\s*[-–|]\s*/);
      const name = (head[0] ?? "")
        .replace(/[^\w\s.'-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!isPlausibleName(name)) return null;
      if (!new RegExp(q.split(/\s+/)[0]!, "i").test(name) && !new RegExp(q, "i").test(blob))
        return null;
      return {
        name,
        title: head.slice(1).join(" - ") || undefined,
        slug: decodeURIComponent(slug),
        url: url.split("?")[0]!,
      };
    })
    .filter(Boolean);
  const tokens = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const seen = new Set<string>();
  const raw: Array<{
    firstName: string;
    lastName: string;
    fullName: string;
    title?: string;
    location?: string;
    department?: string;
    seniority?: "decision" | "ic";
    email?: string;
    sourceUrl?: string;
    slug: string;
  }> = [];
  const { cleanRoleTitle } = await import("./linkedin-public");
  for (const h of [...hits, ...extra]) {
    if (!h) continue;
    const slug = ("slug" in h ? h.slug : "").replace(/\/+$/, "");
    if (!slug || seen.has(slug.toLowerCase())) continue;
    const name = h.name.replace(/[^\w\s.'-]/g, " ").replace(/\s+/g, " ").trim();
    const lower = name.toLowerCase();
    if (tokens.some((t) => !lower.includes(t)) && tokens.length > 1) continue;
    if (tokens.length === 1 && !lower.includes(tokens[0]!)) continue;
    seen.add(slug.toLowerCase());
    const bits = name.split(/\s+/);
    const title = cleanRoleTitle(
      "title" in h ? h.title : undefined,
      brand,
    );
    const p = decoratePerson({
      fullName: name,
      firstName: bits[0]!,
      lastName: bits.slice(1).join(" "),
      title,
      profileUrl: `https://www.linkedin.com/in/${slug}/`,
      slug,
    });
    raw.push({
      firstName: p.firstName,
      lastName: p.lastName,
      fullName: p.fullName,
      title: p.title,
      location: p.location,
      department: p.department,
      seniority: p.seniority,
      email: `${p.firstName.toLowerCase()}.${p.lastName.toLowerCase()}@${domain}`,
      sourceUrl: `https://www.linkedin.com/in/${slug}/`,
      slug,
    });
  }
  const byName = new Map<string, (typeof raw)[number]>();
  const slugScore = (s: string) =>
    (/-[a-z0-9]{4,}$/i.test(s) ? 6 : 0) + (s.split("-").length >= 3 ? 2 : 0) - (/^(?:[a-z]+[a-z]+)$/i.test(s.replace(/-/g, "")) ? 0 : 0);
  for (const p of raw) {
    const k = p.fullName.toLowerCase();
    const prev = byName.get(k);
    if (!prev || slugScore(p.slug) > slugScore(prev.slug)) byName.set(k, p);
  }
  return [...byName.values()].map(({ slug: _s, ...rest }) => rest);
}
