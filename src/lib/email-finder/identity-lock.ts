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
  if (s.length < 3 || s.length > 70) return false;
  if (/activity-|pulse-|urn:li|posts/i.test(s)) return false;
  if (/\d{8,}/.test(s)) return false;
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

export function companyOnCard(blob: string, companyName: string, domain?: string | null): boolean {
  const hay = compact(blob);
  const brand = compact(companyName);
  if (brand.length >= 5 && hay.includes(brand)) return true;
  const stem = compact((domain ?? "").split(".")[0] ?? "");
  if (stem.length >= 5 && hay.includes(stem)) return true;
  if (domain) {
    const d = compact(domain);
    if (d.length >= 6 && hay.includes(d)) return true;
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
  return true;
}

export function emailOnDomain(email: string | null | undefined, domain: string | null | undefined): boolean {
  if (!email || !domain) return false;
  const host = email.split("@")[1]?.toLowerCase().replace(/^www\./, "");
  const d = domain.toLowerCase().replace(/^www\./, "");
  return host === d;
}
