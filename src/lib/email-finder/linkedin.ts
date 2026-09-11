import { parseFullName } from "./normalize";
import { isPersonSlug } from "./identity-lock";
import type { LinkedInParse, ParsedName } from "./types";

/**
 * Parse public LinkedIn profile URLs without scraping LinkedIn
 * (scraping violates ToS and is blocked). We extract the vanity slug
 * and reverse-engineer a name — matching Anymailfinder's first step
 * (name + company capture) with company supplied separately or via
 * query params when available.
 *
 * Supported forms:
 *  - https://www.linkedin.com/in/jane-doe/
 *  - https://linkedin.com/in/jane-doe-a1b2c3/
 *  - https://www.linkedin.com/in/jane-doe?company=Acme
 *  - linkedin.com/in/first-last-12345
 */
export function parseLinkedInUrl(input: string): LinkedInParse {
  const raw = input.trim();
  let url: URL | null = null;

  try {
    const withProto = raw.startsWith("http") ? raw : `https://${raw}`;
    url = new URL(withProto);
  } catch {
    // try path-only
  }

  const href = url?.href ?? raw;
  const path = url?.pathname ?? raw;
  const match = path.match(/\/in\/([^/?#]+)/i);

  if (!match) {
    return {
      profileUrl: href,
      slug: "",
      guessedName: null,
      companyHint: url?.searchParams.get("company") ?? null,
      domainHint: url?.searchParams.get("domain") ?? null,
    };
  }

  const slug = decodeURIComponent(match[1]).replace(/\/+$/, "");
  if (!isPersonSlug(slug)) {
    return {
      profileUrl: href,
      slug: "",
      guessedName: null,
      companyHint: url?.searchParams.get("company") ?? null,
      domainHint: url?.searchParams.get("domain") ?? null,
    };
  }
  const guessedName = nameFromSlug(slug);
  const companyHint =
    url?.searchParams.get("company") ??
    url?.searchParams.get("companyName") ??
    null;
  const domainHint =
    url?.searchParams.get("domain") ??
    url?.searchParams.get("companyDomain") ??
    null;

  return {
    profileUrl: href.startsWith("http") ? href : `https://${href}`,
    slug,
    guessedName,
    companyHint,
    domainHint,
  };
}

/**
 * LinkedIn vanity URLs are typically first-last or first-last-hash.
 * Trailing alphanumeric hash tokens (6–12 chars with digits) are stripped.
 */
export function nameFromSlug(slug: string): ParsedName | null {
  if (!slug) return null;

  let parts = slug
    .toLowerCase()
    .split("-")
    .filter(Boolean)
    .filter((p) => !/^\d+$/.test(p));

  // Drop trailing hash-like tokens: a1b2c3d4, 123abc, etc.
  while (parts.length > 2) {
    const last = parts[parts.length - 1];
    if (/[0-9]/.test(last) && last.length >= 4 && last.length <= 14) {
      parts = parts.slice(0, -1);
      continue;
    }
    break;
  }

  // Also drop a final pure short token that looks like a member id
  if (parts.length > 2) {
    const last = parts[parts.length - 1];
    if (/^[a-z0-9]{5,12}$/.test(last) && /\d/.test(last)) {
      parts = parts.slice(0, -1);
    }
  }

  if (parts.length === 0) return null;
  if (parts.length === 1) {
    return parseFullName(parts[0]);
  }

  // Capitalize for display parse
  const display = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  return parseFullName(display);
}

export function isLinkedInUrl(value: string): boolean {
  return /linkedin\.com\/in\//i.test(value.trim());
}
