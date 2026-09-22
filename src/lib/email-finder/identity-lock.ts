/**
 * Identity lock: miss is allowed, wrong person is not.
 * Attach LinkedIn / foreign emails only when the queried employer is in the
 * profile TITLE and no other employer is named there.
 */

export function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function isPersonSlug(slug: string): boolean {
  const s = slug.trim().replace(/\/+$/, "");
  if (s.length < 3 || s.length > 100) return false;
  if (/activity-|pulse-|urn:li|posts/i.test(s)) return false;
  // Pure numeric / activity-length ids are not vanity profiles.
  // LinkedIn uniqueness suffixes ARE (jane-doe-160496411, 7–12 digits).
  if (/^\d+$/.test(s)) return false;
  if (/\d{15,}/.test(s)) return false;
  if ((s.match(/_/g) ?? []).length >= 2) return false;
  if (/_/.test(s) && /moment|activity|canva-activity/i.test(s)) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(s);
}

/** Profile slug from a LinkedIn URL. Posts → username before first _. Never activity ids. */
export function profileSlugFromUrl(url: string): string | null {
  const u = (url.split("?")[0] ?? "").replace(/\/+$/, "");
  const post = u.match(/linkedin\.com\/(?:\w{2}\/)?posts\/([a-zA-Z0-9][a-zA-Z0-9-]*)_/i);
  if (post && isPersonSlug(post[1]!)) return post[1]!;
  const inn = u.match(/linkedin\.com\/(?:\w{2}\/)?in\/([a-zA-Z0-9][a-zA-Z0-9_-]*)/i);
  if (!inn) return null;
  const slug = decodeURIComponent(inn[1]!);
  return isPersonSlug(slug) ? slug : null;
}

const LEGAL_TOKEN =
  /^(pty|ltd|limited|inc|llc|llp|plc|co|corp|corporation|company|holdings|group|gmbh|pvt|private|sa|ag|bv|nv)$/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLegalTokens(s: string): string {
  return s
    .replace(/\b(pty\.?|ltd\.?|limited|inc\.?|llc|llp|plc|corp\.?|corporation|gmbh|pvt\.?|private limited|holdings|group)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Official name is a prefix of a longer employer string with non-legal extra
 *  tokens → different company (ACME vs ACME Unlimited). Legal suffixes stay. */
export function otherBrandEntity(
  blob: string,
  companyName: string,
  domain?: string | null,
): string | null {
  const official = stripLegalTokens((companyName.split(/[|\-–]/)[0] ?? companyName).trim());
  const brand = official.split(/\s+/)[0] ?? "";
  if (brand.length < 2) return null;
  const re = new RegExp(
    `\\b${escapeRe(brand)}\\s+([A-Za-z][A-Za-z0-9&'-]{1,24})\\b`,
    "i",
  );
  const m = blob.match(re);
  if (!m?.[1] || LEGAL_TOKEN.test(m[1])) return null;
  const named = `${brand} ${m[1]}`;
  const extra = compact(stripLegalTokens(named));
  const base = compact(official);
  if (!extra.startsWith(base) || extra.length <= base.length) return null;
  if (domain && extra === compact(domain.split(".")[0] ?? "")) return null;
  return named;
}

export function companyOnCard(blob: string, companyName: string, domain?: string | null): boolean {
  if (otherBrandEntity(blob, companyName, domain)) return false;
  const hay = compact(blob);
  const brand = compact(companyName);
  if (brand.length >= 5 && hay.includes(brand)) return true;
  if (domain) {
    const d = compact(domain);
    if (d.length >= 6 && hay.includes(d)) return true;
  }
  const stem = compact((domain ?? "").split(".")[0] ?? "");
  if (stem.length >= 2 && stem.length <= 4) {
    return new RegExp(`\\b${escapeRe(stem)}\\b`, "i").test(blob);
  }
  if (stem.length >= 5 && hay.includes(stem)) {
    if (domain && isCollisionBrand(domain)) return false;
    return true;
  }
  return false;
}

/** Headline / og:title only — description mentions of the brand do not count. */
export function employerInTitle(title: string, companyName: string, domain?: string | null): boolean {
  const t = title.replace(/\s*\|\s*LinkedIn.*$/i, "").trim();
  if (!t) return false;
  return companyOnCard(t, companyName, domain);
}

const OTHER_EMP = /(?:\b(?:at|with)\s+|@\s*)([A-Z][A-Za-z0-9&.'' ]{1,42})(?:\s*[|·•]|\s*$)/g;

export function otherEmployerInTitle(title: string, companyName: string, domain?: string | null): string | null {
  const t = title.replace(/\s*\|\s*LinkedIn.*$/i, "").trim();
  let m: RegExpExecArray | null;
  const re = new RegExp(OTHER_EMP.source, "g");
  while ((m = re.exec(t))) {
    const named = (m[1] ?? "").trim();
    if (named.length < 2) continue;
    if (/^(the|and|inc|llc|ltd|group|team|linkedin)$/i.test(named)) continue;
    if (companyOnCard(named, companyName, domain)) continue;
    return named;
  }
  return null;
}

const C_SUITE =
  /\b(ceo|cfo|cto|coo|cmo|cio|chief\s+\w+\s+officer|co-?founder|founder|owner|president|chairman|vice[-\s]?president|\bvp\b|area vice)\b/i;
const IC_ROLE =
  /\b(engineer(?:ing)?|developer|analyst|intern|architect|specialist|consultant|qa\b|quality|sde\d*|salesforce|devops|programmer|tester|lead(?:er)?|manager|administrator|designer)\b/i;

/** Keep a people-search hit only if this employer is on the card, or it's a
 *  role-only IC title on a non-acronym brand. C-suite without the company
 *  is some other firm's CEO. */
export function keepCompanyPerson(
  title: string | undefined,
  companyName: string,
  domain?: string | null,
): boolean {
  const t = (title ?? "").replace(/\s*\|\s*LinkedIn.*$/i, "").trim();
  if (companyOnCard(t, companyName, domain) || employerInTitle(t, companyName, domain)) {
    return !otherEmployerInTitle(t, companyName, domain);
  }
  if (otherEmployerInTitle(t, companyName, domain)) return false;
  if (otherBrandEntity(t, companyName, domain)) return false;
  if (!t) return true;
  if (domain && isCollisionBrand(domain)) return false;
  if (C_SUITE.test(t)) return false;
  if (/\b(aspiring|student|storyteller|enthusiast|helping)\b/i.test(t)) return false;
  return IC_ROLE.test(t);
}

export function identityLocked(opts: {
  title: string;
  blob?: string;
  fullName: string;
  company?: string | null;
  domain?: string | null;
}): boolean {
  const { title, fullName, company, domain } = opts;
  if (!company && !domain) return false;
  const head = title.replace(/\s*\|\s*LinkedIn.*$/i, "").split(/\s*[-–|]\s*/)[0]?.trim() ?? "";
  const nameOk =
    !head ||
    fullName
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)
      .every((t) => head.toLowerCase().includes(t.toLowerCase()));
  if (!nameOk) return false;
  if (!employerInTitle(title, company ?? "", domain)) return false;
  if (otherEmployerInTitle(title, company ?? "", domain)) return false;
  if (domain && isCollisionBrand(domain)) {
    return personFitsEmployer({
      title,
      blob: opts.blob,
      domain,
      company,
      legalName: company,
    });
  }
  return true;
}

export function emailOnDomain(email: string | null | undefined, domain: string | null | undefined): boolean {
  if (!email || !domain) return false;
  const host = email.split("@")[1]?.toLowerCase().replace(/^www\./, "");
  const d = domain.toLowerCase().replace(/^www\./, "");
  return host === d;
}

export function hostOf(urlOrHost: string | null | undefined): string | null {
  if (!urlOrHost) return null;
  const t = urlOrHost.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const host = t.split("/")[0]?.split("?")[0]?.toLowerCase() ?? "";
  if (!host.includes(".") || /linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com/i.test(host))
    return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return null;
  return host;
}

export function websiteMatchesDomain(website: string | null | undefined, domain: string): boolean {
  const a = hostOf(website);
  const b = hostOf(domain) ?? domain.replace(/^www\./i, "").toLowerCase();
  return Boolean(a && b && a === b);
}

/** Split 32dentalsolutions → "32 dental solutions". */
export function spacedBrand(stem: string): string {
  const words = [
    "solutions",
    "solution",
    "dental",
    "dentist",
    "family",
    "clinic",
    "health",
    "care",
    "group",
    "labs",
    "lab",
    "tech",
    "media",
    "digital",
    "capital",
    "partners",
    "systems",
    "global",
    "holdings",
    "consulting",
    "services",
    "service",
  ];
  let s = stem.toLowerCase();
  const held: string[] = [];
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(w, "g"), () => {
      held.push(w);
      return `§${held.length - 1}§`;
    });
  }
  s = s.replace(/§(\d+)§/g, (_, i) => ` ${held[Number(i)]} `);
  return s.replace(/(\d+)/g, " $1 ").replace(/\s+/g, " ").trim();
}

export function companyNameFitsDomain(name: string, domain: string): boolean {
  const stem = (domain.split(".")[0] ?? domain).toLowerCase();
  const n = compact(name);
  const b = compact(stem);
  if (!b || b.length < 2 || !n) return false;
  if (b === n) return true;
  // Domain stem is a substring of the company name (jpmorgan ⊂ jpmorganchase).
  if (b.length >= 6 && n.includes(b)) return true;
  // Company compact is a substring of the domain (aidacare ⊂ aidacareaustralia).
  if (n.length >= 5 && b.includes(n)) return true;
  const tokens = coreNameTokens(name);
  if (tokens.length && tokens.every((t) => b.includes(t))) return true;
  return false;
}

export function linkedinFitsDomain(opts: {
  website?: string | null;
  name?: string | null;
  domain: string;
}): boolean {
  if (opts.website && websiteMatchesDomain(opts.website, opts.domain)) return true;
  if (opts.website && hostOf(opts.website) && !websiteMatchesDomain(opts.website, opts.domain))
    return false;
  if (isCollisionBrand(opts.domain)) return false;
  return companyNameFitsDomain(opts.name ?? "", opts.domain);
}

const GENERIC_TAIL =
  /^(group|holdings|capital|labs|global|partners|corp|inc|llc|ltd|pvt|limited|company|co|media|tech|systems|solutions|software|services|service)$/i;

const GENERIC_COMPANY_TOKEN =
  /^(socials?|digital|media|agency|studio|marketing|group|services?|solutions?|consulting|company|the|and|for|by|with|official|global|international|india)$/i;

/** Tokens that identify a company — "peach" not "socials by". */
export function coreNameTokens(name: string): string[] {
  const all = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !GENERIC_COMPANY_TOKEN.test(t) && !GENERIC_TAIL.test(t));
  const core = all.filter((t) => t.length >= 4);
  return core.length ? core : all;
}

/**
 * Collision = the domain stem is too common to identify an employer alone.
 * "abc.com", "tlcgroup.com", "radiussystems.net" — not a list of companies.
 */
export function isCollisionBrand(domain: string): boolean {
  const stem = (domain.split(".")[0] ?? "").toLowerCase();
  if (stem.length <= 4) return true;
  const parts = spacedBrand(stem).split(/\s+/).filter(Boolean);
  if (parts.length === 2 && parts[0]!.length <= 8 && GENERIC_TAIL.test(parts[1]!)) return true;
  return false;
}

export function legalForm(s: string): "pvt" | "ltd" | "llc" | "inc" | "plc" | "llp" | null {
  const t = s.toLowerCase();
  if (/\bpvt\.?\s*ltd\b|\bprivate limited\b/.test(t)) return "pvt";
  if (/\bllc\b/.test(t)) return "llc";
  if (/\bplc\b/.test(t)) return "plc";
  if (/\bllp\b/.test(t)) return "llp";
  if (/\binc\.?\b/.test(t)) return "inc";
  if (/\bltd\.?\b|\blimited\b/.test(t)) return "ltd";
  return null;
}

export function distinctiveTokens(name: string, domain: string): string[] {
  const stem = (domain.split(".")[0] ?? "").toLowerCase();
  const skip = new Set(
    ["group", "holdings", "ltd", "inc", "llc", "pvt", "limited", "the", "and", "company", "corp", "co", "official"]
      .concat(stem.match(/[a-z]{3,}/g) ?? [])
      .concat(spacedBrand(stem).split(/\s+/)),
  );
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length >= 4 && !skip.has(w.toLowerCase()));
}

export function foreignSiblingDomain(blob: string, domain: string): boolean {
  const stem = (domain.split(".")[0] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tld = domain.split(".").slice(1).join(".").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\b${stem}\\.(?!${tld}\\b)(?:co\\.uk|com\\.au|co\\.il|com|net|org|io|in|uk|pl|eu|ai)\\b`,
    "i",
  );
  return re.test(blob);
}

/** SERP people for collision brands must show the domain or a distinctive legal token. */
export function personFitsEmployer(opts: {
  title: string;
  blob?: string;
  domain: string;
  company?: string | null;
  legalName?: string | null;
  hq?: string | null;
}): boolean {
  const blob = `${opts.title} ${opts.blob ?? ""}`;
  if (foreignSiblingDomain(blob, opts.domain)) return false;
  const selfForm = legalForm(`${opts.legalName ?? ""} ${opts.company ?? ""}`);
  const titleForm = legalForm(opts.title);
  if (selfForm && titleForm && selfForm !== titleForm) return false;
  if (!isCollisionBrand(opts.domain)) {
    return employerInTitle(opts.title, opts.company || opts.legalName || "", opts.domain);
  }
  if (compact(blob).includes(compact(opts.domain))) return true;
  const dist = distinctiveTokens(`${opts.legalName ?? ""} ${opts.company ?? ""}`, opts.domain);
  if (dist.some((t) => new RegExp(`\\b${t}\\b`, "i").test(blob))) return true;
  const legal = compact(opts.legalName ?? "");
  if (legal.length >= 8 && compact(blob).includes(legal)) return true;
  if (selfForm === "pvt" && /\b(private limited|pvt\.?\s*ltd)\b/i.test(blob)) return true;
  const hqBits = (opts.hq ?? "")
    .split(/[;,/]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  if (
    hqBits.some((bit) => new RegExp(`\\b${bit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(blob)) &&
    compact(blob).includes(compact(opts.domain.split(".")[0] ?? ""))
  )
    return true;
  return false;
}
