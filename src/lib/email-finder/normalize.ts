import type { ParsedName } from "./types";

const DIACRITICS = /[\u0300-\u036f]/g;

/** Strip accents: José → jose (common enterprise mailbox policy). */
export function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(DIACRITICS, "");
}

export function slugifyToken(value: string): string {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/** Accept company.com, https://www.company.com/path, @company.com */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^mailto:/, "");
  if (d.includes("@")) d = d.split("@").pop() ?? d;
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
  d = d.split("/")[0]?.split("?")[0]?.split("#")[0] ?? d;
  d = d.replace(/^\.+|\.+$/g, "");
  return d;
}

const HONORIFICS = new Set([
  "mr",
  "mrs",
  "ms",
  "miss",
  "dr",
  "prof",
  "sir",
  "madam",
  "mx",
]);

const SUFFIXES = new Set([
  "jr",
  "sr",
  "ii",
  "iii",
  "iv",
  "phd",
  "md",
  "esq",
  "cpa",
]);

/**
 * Parse a full name into first / middle / last with enterprise mailbox rules:
 * - Drop honorifics & generational suffixes
 * - Hyphenated last names kept as single last token for flast patterns
 * - "Last, First" inverted
 */
export function parseFullName(raw: string): ParsedName {
  let cleaned = stripDiacritics(raw).trim().replace(/\s+/g, " ");
  if (!cleaned) {
    return { first: "", last: "", raw };
  }

  // "Doe, John A." → "John A. Doe"
  if (cleaned.includes(",")) {
    const [left, right] = cleaned.split(",").map((s) => s.trim());
    if (left && right) cleaned = `${right} ${left}`;
  }

  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.replace(/\./g, ""))
    .filter(Boolean)
    .filter((t) => !HONORIFICS.has(t.toLowerCase()))
    .filter((t) => !SUFFIXES.has(t.toLowerCase()));

  if (tokens.length === 0) {
    return { first: "", last: "", raw };
  }
  if (tokens.length === 1) {
    return { first: slugifyToken(tokens[0]), last: "", raw };
  }
  if (tokens.length === 2) {
    return {
      first: slugifyToken(tokens[0]),
      last: slugifyToken(tokens[1]),
      raw,
    };
  }

  return {
    first: slugifyToken(tokens[0]),
    middle: slugifyToken(tokens[1]),
    last: slugifyToken(tokens.slice(2).join("")),
    raw,
  };
}

export function isValidDomainShape(domain: string): boolean {
  if (!domain || domain.length > 253) return false;
  if (domain.startsWith(".") || domain.endsWith(".")) return false;
  if (!domain.includes(".")) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(
    domain,
  );
}

/** RFC 5322 simplified local+domain syntax (not full RFC — intentional for speed). */
export function isValidEmailSyntax(email: string): boolean {
  if (!email || email.length > 254) return false;
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".")) {
    return false;
  }
  if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  return isValidDomainShape(domain);
}
