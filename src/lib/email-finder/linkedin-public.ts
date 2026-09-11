/**
 * LinkedIn public profile + company domain fill (no Sales Nav cookie).
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { DiscoverPerson } from "./voyager-search";

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

async function fetchViaOkk(url: string): Promise<string | null> {
  const cfg = env("OKK_PROXY_CONFIG_URL_BING") || env("OKK_PROXY_CONFIG_URL");
  if (!cfg) return null;
  try {
    const text = await (await fetch(cfg, { signal: AbortSignal.timeout(4000) })).text();
    const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.includes(":") && !l.startsWith("#"));
    if (!line) return null;
    const [host, port, user, ...rest] = line.split(":");
    const pass = rest.join(":");
    const sid = randomBytes(3).toString("hex");
    const proxyUser = `${(user ?? "").replace(/-sid-[a-z0-9]+$/i, "")}-sid-${sid}`;
    const args = [
      "-sS", "-m", "14", "-L", "--max-redirs", "2", "--compressed",
      "-A", UA,
      "-x", `http://${proxyUser}:${pass}@${host}:${port}`,
      url,
    ];
    const { stdout } = await execFileAsync("curl", args, {
      maxBuffer: 2_500_000,
      timeout: 16_000,
    });
    return stdout.length > 2000 ? stdout : null;
  } catch {
    return null;
  }
}

const TECH_NOT_COMPANY =
  /^(k8s|kubernetes|gpu|aws|azure|gcp|linux|docker|terraform|python|java|react|node\.?js|ai|ml|cloud|devops)$/i;
const SLOGAN =
  /\b(temple|passionate|helping|love to|enthusiast|ninja|guru|is my|advocate|geek|wizard)\b/i;

/** Job title only — never a tech name or LinkedIn slogan. */
export function cleanRoleTitle(
  raw?: string,
  companyHint?: string,
): string | undefined {
  if (!raw) return undefined;
  let t = raw
    .replace(/[^\w\s.&+/()#'-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*\|\s*LinkedIn.*$/i, "")
    .trim();
  if (!t || t.length < 3) return undefined;
  if (TECH_NOT_COMPANY.test(t)) return undefined;
  const at = t.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
  if (at) {
    const role = at[1]!.trim();
    const co = at[2]!.replace(/\s*[-–|].*$/, "").trim();
    if (TECH_NOT_COMPANY.test(co)) return role || undefined;
    if (SLOGAN.test(role) && !/\b(manager|director|engineer|officer|lead|vp|head|founder)\b/i.test(role)) {
      return undefined;
    }
    return role || undefined;
  }
  if (SLOGAN.test(t) && !/\b(manager|director|engineer|officer|lead|vp|head|founder|cto|ceo)\b/i.test(t)) {
    return undefined;
  }
  if (companyHint) {
    t = t.replace(new RegExp(`\\s+at\\s+${companyHint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*$`, "i"), "").trim();
  }
  return t.slice(0, 80) || undefined;
}

export function companyFromHeadline(raw?: string): string | undefined {
  if (!raw) return undefined;
  const at = raw.match(/\s+(?:at|@)\s+([A-Z][\w.&' -]{1,40})/i);
  const co = at?.[1]?.replace(/\s*[-–|].*$/, "").trim();
  if (!co || TECH_NOT_COMPANY.test(co) || /linkedin/i.test(co)) return undefined;
  if (SLOGAN.test(co)) return undefined;
  return co;
}

function parseOgProfile(html: string, slug: string): Partial<PublicProfile> {
  const attr = (prop: string) => {
    const m =
      html.match(new RegExp(`property="${prop}" content="([^"]*)"`, "i")) ??
      html.match(new RegExp(`content="([^"]*)" property="${prop}"`, "i"));
    return m?.[1]?.replace(/&/g, "&").replace(/&#39;/g, "'") ?? "";
  };
  const ogTitle = attr("og:title").replace(/\s*\|\s*LinkedIn.*$/i, "").trim();
  const ogDesc = attr("og:description");
  const bits = ogTitle.split(/\s*[-–|]\s*/);
  const fullName = (bits[0] ?? "").trim();
  let company = companyFromHeadline(bits.slice(1).join(" - ")) || companyFromHeadline(ogTitle);
  if (company && (TECH_NOT_COMPANY.test(company) || /^linkedin$/i.test(company))) company = undefined;
  const exp = ogDesc.match(/Experience:\s*([^·|]+)/i)?.[1]?.trim();
  const loc = ogDesc.match(/Location:\s*([^·|]+)/i)?.[1]?.trim();
  const edu = ogDesc.match(/Education:\s*([^·|]+)/i)?.[1]?.trim();
  if (exp && !TECH_NOT_COMPANY.test(exp) && !SLOGAN.test(exp)) company = company || exp;
  const headline = ogDesc.split("·")[0]?.replace(/….*$/, "").trim();
  let title: string | undefined;
  if (headline && fullName && !headline.startsWith("View ")) {
    title = cleanRoleTitle(
      headline
        .replace(new RegExp(fullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "")
        .replace(/^as\s+/i, "")
        .trim(),
      company,
    );
  }
  title = cleanRoleTitle(title, company);
  return {
    fullName: fullName.split(/\s+/).length >= 2 ? fullName : undefined,
    title,
    company,
    location: loc,
    slug,
    linkedinUrl: `https://www.linkedin.com/in/${slug}/`,
    ...(edu ? {} : {}),
  };
}

export type PublicProfile = {
  fullName: string;
  title?: string;
  company?: string;
  domain?: string;
  location?: string;
  linkedinUrl: string;
  slug: string;
};

export async function enrichLinkedInProfile(
  rawUrl: string,
): Promise<PublicProfile | null> {
  const { parseLinkedInUrl, nameFromSlug } = await import("./linkedin");
  const li = parseLinkedInUrl(rawUrl);
  if (!li.slug) return null;
  const linkedinUrl = `https://www.linkedin.com/in/${li.slug}/`;
  const fromSlug = nameFromSlug(li.slug);
  const fallbackName = fromSlug
    ? `${fromSlug.first}${fromSlug.middle ? ` ${fromSlug.middle}` : ""} ${fromSlug.last}`.trim()
    : "";

  let title: string | undefined;
  let company: string | undefined;
  let location: string | undefined;
  let fullName = fallbackName;

  const html = await fetchViaOkk(linkedinUrl);
  if (html) {
    const og = parseOgProfile(html, li.slug);
    if (og.fullName) fullName = og.fullName;
    title = og.title;
    company = og.company;
    location = og.location;
  }

  try {
    const { decodoSearch } = await import("./decodo-serp");
    const pages = await Promise.all([
      decodoSearch(`"${linkedinUrl}"`),
      decodoSearch(`site:linkedin.com/in/${li.slug}`),
      fallbackName
        ? decodoSearch(`site:linkedin.com/in "${fallbackName}"`)
        : Promise.resolve([]),
    ]);
    for (const row of pages.flat()) {
      const url = row.link ?? "";
      const path = `/in/${li.slug}`.toLowerCase();
      if (!url.toLowerCase().includes(path)) continue;
      const head = (row.title ?? "")
        .replace(/\s*\|\s*LinkedIn.*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
      const bits = head.split(/\s*[-–|]\s*/);
      const n = (bits[0] ?? "").trim();
      if (n.split(/\s+/).length >= 2) fullName = n;
      const rest = bits.slice(1).join(" - ");
      const at = rest.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
      if (at) {
        title = cleanRoleTitle(at[1]!.trim(), company) || title;
        const co = at[2]!.replace(/\s*[-–|].*$/, "").trim();
        if (co && !TECH_NOT_COMPANY.test(co) && !SLOGAN.test(co)) company = co;
      } else if (rest) {
        title = cleanRoleTitle(rest, company) || title;
      }
      const loc = (row.description ?? "").match(
        /\b([A-Z][a-zA-Z.]{2,20}(?:\s+[A-Z][a-zA-Z.]{2,16}){0,2},\s*(?:[A-Z]{2}|[A-Z][a-z]{2,20}(?:\s+[A-Z][a-z]{2,16})?))\b/,
      )?.[1];
      if (loc) location = loc;
      if (fullName && (title || company)) break;
    }
  } catch {
    /* SERP optional */
  }

  if (li.companyHint && !company) company = li.companyHint;
  let domain = li.domainHint || undefined;
  if (!domain && company && !TECH_NOT_COMPANY.test(company) && !SLOGAN.test(company)) {
    try {
      const { resolveCompanyDomain } = await import("./company-suggest");
      domain = await resolveCompanyDomain(company);
    } catch {
      /* */
    }
  }

  if (!fullName) return null;
  return {
    fullName,
    title,
    company,
    domain,
    location,
    linkedinUrl,
    slug: li.slug,
  };
}

export async function fillCompanyDomains(
  rows: DiscoverPerson[],
  budgetMs = 12_000,
): Promise<DiscoverPerson[]> {
  const t0 = Date.now();
  const out = rows.map((r) => ({ ...r }));
  const companies = [
    ...new Set(
      out
        .filter((p) => p.company && !p.domain)
        .map((p) => p.company!.replace(/\s+/g, " ").trim()),
    ),
  ].slice(0, 80);
  const { resolveCompanyDomain } = await import("./company-suggest");
  const domains = new Map<string, string>();
  let ci = 0;
  await Promise.all(
    Array.from({ length: Math.min(10, companies.length || 1) }, async () => {
      while (ci < companies.length && Date.now() - t0 < budgetMs) {
        const name = companies[ci++]!;
        const d = await resolveCompanyDomain(name);
        if (d) domains.set(name.toLowerCase(), d);
      }
    }),
  );
  for (const p of out) {
    if (p.company && !p.domain) {
      const d = domains.get(p.company.replace(/\s+/g, " ").trim().toLowerCase());
      if (d) p.domain = d;
    }
    if (
      p.domain &&
      /^(bit\.ly|t\.co|ow\.ly|goo\.gl|lnkd\.in|tinyurl\.com)$/i.test(p.domain)
    ) {
      p.domain = undefined;
    }
  }
  return out;
}

export async function enrichPeople(
  rows: DiscoverPerson[],
  budgetMs = 18_000,
): Promise<DiscoverPerson[]> {
  const t0 = Date.now();
  let out = await fillCompanyDomains(rows, Math.min(budgetMs, 12_000));
  const missing = out
    .filter((p) => !p.linkedinUrl || !p.location || !p.title || !p.company)
    .slice(0, 80);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, missing.length || 1) }, async () => {
      while (i < missing.length && Date.now() - t0 < budgetMs) {
        const p = missing[i++]!;
        if (p.linkedinUrl) {
          const prof = await enrichLinkedInProfile(p.linkedinUrl);
          if (!prof) continue;
          if (prof.title && !p.title) p.title = prof.title;
          if (prof.company && !p.company) p.company = prof.company;
          if (prof.domain && !p.domain) p.domain = prof.domain;
          if (prof.location && !p.location) p.location = prof.location;
          continue;
        }
        try {
          const { decodoSearch } = await import("./decodo-serp");
          const q = [
            `site:linkedin.com/in "${p.name}"`,
            p.company ? `"${p.company}"` : "",
          ]
            .filter(Boolean)
            .join(" ");
          const rows = await decodoSearch(q);
          const hit = rows.find((r) => /linkedin\.com\/in\//i.test(r.link ?? ""));
          if (hit?.link && !p.linkedinUrl) {
            p.linkedinUrl = hit.link.split("?")[0];
            p.url = p.linkedinUrl;
          }
        } catch {
          /* */
        }
      }
    }),
  );
  if (out.some((p) => p.company && !p.domain)) {
    out = await fillCompanyDomains(
      out,
      Math.max(3_000, budgetMs - (Date.now() - t0)),
    );
  }
  return out;
}
