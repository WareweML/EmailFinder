/**
 * Live LinkedIn people via guest APIs + Decodo Fast Search shards.
 * Decodo rotates residential/ISP exits per request — we never share one IP.
 */

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

function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function hyphenSlug(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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
  if (!title || /sign in|join now|^linkedin$/i.test(title)) return null;

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
    name: title.replace(/\s+/g, " ").slice(0, 80),
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
  if (/\b(professor|lecturer|teacher|trainer|learning)\b/.test(t))
    return "Education";
  if (/\b(buyer|procurement|sourcing|purchasing)\b/.test(t)) return "Purchasing";
  if (/\b(quality assurance|\bqa\b)\b/.test(t)) return "Quality Assurance";
  if (/\b(admin|office manager|executive assistant|secretary|coordonnateur)\b/.test(t))
    return "Administrative";
  if (/\b(support|helpdesk|customer success)\b/.test(t)) return "Support";
  if (/\b(pr\b|public relations|communications|media)\b/.test(t))
    return "Media and Communication";
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

async function serpLinkedInPeople(companyName: string): Promise<LinkedInPerson[]> {
  const brand = compact(companyName);
  if (brand.length < 2) return [];
  const qName = companyName.length <= 5 ? companyName.toUpperCase() : companyName;

  const titles = [
    "Engineer",
    "Manager",
    "Director",
    "Consultant",
    "Analyst",
    "Principal",
    "Specialist",
    "Officer",
    "Architect",
    "Scientist",
    "Marketing",
    "Sales",
    "Finance",
    "Operations",
  ];
  const shards = [
    `site:linkedin.com/in "${qName}"`,
    `site:au.linkedin.com/in "${qName}"`,
    `site:ca.linkedin.com/in "${qName}"`,
    `site:uk.linkedin.com/in "${qName}"`,
    ...titles.map((t) => `site:au.linkedin.com/in "at ${qName}" ${t}`),
    ...titles.slice(0, 4).map((t) => `site:ca.linkedin.com/in "at ${qName}" ${t}`),
  ];

  const { decodoShards, peopleFromOrganic } = await import("./decodo-serp");
  const okkQs = [
    `site:au.linkedin.com/in "at ${qName}" Engineer`,
    `site:au.linkedin.com/in "at ${qName}" Manager`,
    `site:au.linkedin.com/in "at ${qName}" Director`,
    `site:linkedin.com/in "${qName}"`,
  ];
  const voyagerP = import("./voyager-people")
    .then(async (m) => {
      const ta = await typeahead(qName);
      const companyId = ta[0]?.id;
      return m.voyagerPeopleFanout(qName, companyId);
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
  const addHit = (row: {
    name: string;
    title?: string;
    slug: string;
    url: string;
  }) => {
    if (seen.has(row.slug) || !isPersonName(row.name)) return;
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
  for (const row of voyager.hits) addHit(row);
  for (const rows of pages) {
    for (const row of peopleFromOrganic(rows, qName)) addHit(row);
  }
  for (const row of okkHits) addHit(row);
  return out;
}

export async function discoverLinkedInForDomain(domain: string): Promise<{
  company: LinkedInCompany | null;
  people: LinkedInPerson[];
  jobs: LiveJob[];
  detail: string;
}> {
  const brand = domain.split(".")[0] ?? domain;
  const tried = new Set<string>();

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
    const people = peopleFromGuestHtml(html);
    const page = parseGuestPage(html, slug);
    if (!page && people.length === 0) return null;
    return {
      company:
        page ?? {
          name: brand,
          slug,
          linkedinUrl: `https://www.linkedin.com/company/${slug}/`,
          website: domain,
        },
      people,
    };
  };

  const qName = brand.length <= 5 ? brand.toUpperCase() : brand;
  const ta0 = await typeahead(qName);
  const companyId = ta0[0]?.id;
  const { voyagerCompany } = await import("./voyager-people");
  const hunterTok = import("./hunter-trial").then((m) =>
    m.solveTurnstile("https://hunter.io/email-finder"),
  );
  const [direct, serp, org, jobs0, theorg] = await Promise.all([
    trySlug(brand),
    serpLinkedInPeople(qName),
    companyId ? voyagerCompany(companyId).catch(() => null) : null,
    companyId ? liveJobs(companyId) : Promise.resolve([] as LiveJob[]),
    import("./theorg-people")
      .then((m) => m.theOrgPeople(domain, qName))
      .catch(() => ({ hits: [] as Array<{ name: string; title?: string; slug: string; url: string }>, positions: 0, teams: 0 })),
  ]);
  let company: LinkedInCompany | null = direct?.company ?? null;
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
  const addNamed = (p: LinkedInPerson) => {
    const row = decoratePerson(p);
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

  people.sort((a, b) => {
    const sa = a.seniority === "decision" ? 1 : 0;
    const sb = b.seniority === "decision" ? 1 : 0;
    if (sb !== sa) return sb - sa;
    return a.fullName.localeCompare(b.fullName);
  });

  if (org) {
    company = {
      name: org.name || company?.name || brand,
      slug: org.universalName || company?.slug || hyphenSlug(brand),
      linkedinUrl: `https://www.linkedin.com/company/${org.universalName || company?.slug || brand}/`,
      website: company?.website ?? null,
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
    detail: company
      ? `${company.name}${company.size ? ` · ${company.size}` : ""} · ${people.length} live names (${titled} titled) · TheOrg ${theorg.hits.length}/${theorg.positions || "?"} · ${jobs.length} open roles · ${locN} cities / ${deptN} functions`
      : `Decodo SERP · ${people.length} named`,
  };
}

export async function fastLinkedInDomainSearch(domainInput: string) {
  const domain = domainInput
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]!;
  const t0 = Date.now();
  const [li, tech] = await Promise.all([
    discoverLinkedInForDomain(domain),
    import("./tech-stack").then((m) =>
      m.detectTechStack(domain).catch(() => ({
        technologies: [] as Array<{ name: string; category: string }>,
      })),
    ),
  ]);
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
  return {
    domain,
    companyName: li.company?.name ?? null,
    website: `https://${domain}`,
    hasMx: true,
    mxProvider: null,
    mxHosts: [],
    industry: li.company?.industry ?? null,
    headcount: li.company?.size ?? null,
    hq: li.company?.hq ?? null,
    companyType: li.company?.type ?? null,
    description: li.company?.description ?? null,
    jobs: li.jobs,
    technologies: tech.technologies.map((t) => ({
      name: t.name,
      category: t.category,
    })),
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
    legalName: li.company?.name ?? null,
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
