/**
 * Live public-web email discovery for a domain.
 * Crawls company site + sitemaps + CMS APIs, extracts emails with sources.
 */

import {
  normalizeDomain,
  isValidDomainShape,
  isValidEmailSyntax,
} from "./normalize";
import { isDisposableDomain, isRoleBasedEmail } from "./disposable";
import { detectPatternFromEmail, PATTERN_MAP } from "./patterns";
import { lookupMx } from "./dns";
import { verifyEmail } from "./verify";
import type { DomainPatternHit, PatternId, VerificationStatus } from "./types";
import { resilientFetch } from "./http";

const UA =
  "Mozilla/5.0 (compatible; MailgraphBot/1.0; +https://mailgraph.app)";
const FETCH_TIMEOUT_MS = 10000;
const MAX_PAGES = 18;
const MAX_BODY = 900_000;

const PRIORITY_PATHS = [
  "/",
  "/contact",
  "/contact-us",
  "/contactus",
  "/about",
  "/about-us",
  "/aboutus",
  "/team",
  "/our-team",
  "/people",
  "/leadership",
  "/staff",
  "/company",
  "/privacy",
  "/privacy-policy",
  "/legal",
  "/imprint",
  "/impressum",
  "/en/contact",
  "/en/about",
  "/support",
  "/help",
  "/careers",
  "/jobs",
  "/press",
  "/media",
  "/blog",
];

const ROLE_LOCALS = [
  "hello",
  "hi",
  "info",
  "contact",
  "support",
  "help",
  "sales",
  "team",
  "admin",
  "office",
  "press",
  "media",
  "marketing",
  "hr",
  "jobs",
  "careers",
  "billing",
  "finance",
  "legal",
  "privacy",
  "security",
  "partnerships",
  "partners",
  "business",
  "enquiries",
  "inquiry",
  "service",
  "customerservice",
  "webmaster",
];

export type CrawlSourceKind =
  | "html"
  | "sitemap"
  | "api"
  | "mailto"
  | "cloudflare"
  | "role_probe"
  | "knowledge_base"
  | "public_graph"
  | "person_smtp";

export interface CrawlSource {
  url: string;
  extractedAt: string;
  kind: CrawlSourceKind;
}

export interface DiscoveredEmail {
  email: string;
  confidence: number;
  status: VerificationStatus | "found";
  sources: CrawlSource[];
  firstName?: string;
  lastName?: string;
  title?: string;
  isRoleBased: boolean;
  patternId?: PatternId | null;
  patternLabel?: string;
  kind?: "person" | "role";
}

export interface DomainCrawlResult {
  domain: string;
  companyName: string | null;
  website: string;
  hasMx: boolean;
  mxProvider: string | null;
  mxHosts: string[];
  emails: DiscoveredEmail[];
  patterns: DomainPatternHit[];
  pagesCrawled: number;
  pagesAttempted: string[];
  durationMs: number;
  pipeline: Array<{
    id: string;
    label: string;
    status: "ok" | "warn" | "skip" | "error";
    detail: string;
    ms: number;
  }>;
  people?: Array<{
    firstName: string;
    lastName: string;
    fullName: string;
    title?: string;
    location?: string;
    department?: string;
    seniority?: "decision" | "ic";
    email?: string;
    sourceUrl?: string;
  }>;
  industry?: string | null;
  headcount?: string | null;
  hq?: string | null;
  companyType?: string | null;
  description?: string | null;
  jobs?: Array<{ title: string; location: string; department: string }>;
  technologies?: Array<{ name: string; category: string }>;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&/gi, "&")
    .replace(/</gi, "<")
    .replace(/>/gi, ">")
    .replace(/"/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

export function decodeCloudflareEmail(hex: string): string | null {
  try {
    if (hex.length < 4 || hex.length % 2 !== 0) return null;
    const key = parseInt(hex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    }
    return out.includes("@") ? out : null;
  } catch {
    return null;
  }
}

const EMAIL_RE =
  /[a-zA-Z0-9](?:[a-zA-Z0-9._%+\-]{0,62}[a-zA-Z0-9])?@[a-zA-Z0-9](?:[a-zA-Z0-9.\-]{0,61}[a-zA-Z0-9])?\.[a-zA-Z]{2,}/g;

const OBFUSCATED_RE =
  /([a-zA-Z0-9._%+\-]+)\s*(?:\[?\s*at\s*\]?|\(at\)|@)\s*([a-zA-Z0-9.\-]+)\s*(?:\[?\s*dot\s*\]?|\(dot\)|\.)\s*([a-zA-Z]{2,})/gi;

function extractEmailsFromText(
  text: string,
  domain: string,
): Array<{ email: string; via: CrawlSourceKind }> {
  const found: Array<{ email: string; via: CrawlSourceKind }> = [];
  const decoded = decodeHtmlEntities(text);
  const lowerDomain = domain.toLowerCase();

  for (const m of decoded.matchAll(EMAIL_RE)) {
    const email = m[0].toLowerCase().replace(/[.,;:)+\]>]+$/, "");
    if (!isValidEmailSyntax(email)) continue;
    const host = email.split("@")[1] ?? "";
    if (host === lowerDomain) found.push({ email, via: "html" });
  }

  for (const m of decoded.matchAll(/mailto:([^"'?\s>]+)/gi)) {
    let email = decodeURIComponent(m[1]).toLowerCase().split("?")[0] ?? "";
    email = email.replace(/^mailto:/, "").replace(/[.,;:)+\]>]+$/, "");
    if (isValidEmailSyntax(email) && email.endsWith(`@${lowerDomain}`)) {
      found.push({ email, via: "mailto" });
    }
  }

  for (const m of decoded.matchAll(/data-cfemail=["']([a-f0-9]+)["']/gi)) {
    const email = decodeCloudflareEmail(m[1])?.toLowerCase();
    if (email && email.endsWith(`@${lowerDomain}`)) {
      found.push({ email, via: "cloudflare" });
    }
  }

  OBFUSCATED_RE.lastIndex = 0;
  let om: RegExpExecArray | null;
  while ((om = OBFUSCATED_RE.exec(decoded))) {
    const email = `${om[1]}@${om[2]}.${om[3]}`.toLowerCase();
    if (isValidEmailSyntax(email) && email.endsWith(`@${lowerDomain}`)) {
      found.push({ email, via: "html" });
    }
  }

  return found;
}

async function fetchText(
  url: string,
): Promise<{ ok: boolean; status: number; body: string; finalUrl: string }> {
  const res = await resilientFetch(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxAttempts: 3,
    preferBot: true,
    maxBody: MAX_BODY,
  });
  return {
    ok: res.ok,
    status: res.status,
    body: res.body,
    finalUrl: res.url,
  };
}

function parseSitemapLocs(
  xml: string,
  domain: string,
  limit = 40,
): string[] {
  const locs: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    try {
      const u = new URL(m[1].trim());
      const host = u.hostname.replace(/^www\./, "").toLowerCase();
      if (host === domain || host.endsWith(`.${domain}`)) {
        locs.push(u.href);
        if (locs.length >= limit) break;
      }
    } catch {
      // ignore
    }
  }
  return locs;
}

function extractCompanyName(html: string, domain: string): string | null {
  const og = html.match(
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i,
  );
  if (og?.[1]) return decodeHtmlEntities(og[1]).trim();
  const title = html.match(/<title[^>]*>([^<]+)/i);
  if (title?.[1]) {
    const t = decodeHtmlEntities(title[1])
      .split(/[|\-–—]/)[0]
      ?.trim();
    if (t && t.length > 1 && t.length < 80) return t;
  }
  const brand = domain.split(".")[0] ?? domain;
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

function extractSameDomainLinks(
  html: string,
  baseUrl: string,
  domain: string,
): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href=["']([^"'#]+)/gi)) {
    try {
      const u = new URL(m[1], baseUrl);
      const host = u.hostname.replace(/^www\./, "").toLowerCase();
      if (host === domain || host.endsWith(`.${domain}`)) {
        if (!/\.(pdf|jpg|png|gif|css|js|zip|svg|woff2?)(\?|$)/i.test(u.pathname)) {
          out.push(u.href);
        }
      }
    } catch {
      // ignore
    }
  }
  return out;
}

function scoreDiscovered(
  email: string,
  sources: CrawlSource[],
  status: VerificationStatus | "found",
): number {
  let conf = 40;
  conf += Math.min(30, sources.length * 12);
  if (sources.some((s) => s.kind === "mailto" || s.kind === "cloudflare"))
    conf += 10;
  if (sources.some((s) => s.kind === "public_graph")) conf += 20;
  if (status === "valid") conf = Math.max(conf, 90);
  if (status === "invalid") conf = Math.min(conf, 35);
  if (isRoleBasedEmail(email)) conf = Math.min(conf, status === "valid" ? 99 : 60);
  return Math.max(1, Math.min(99, conf));
}

export async function crawlDomainEmails(
  domainInput: string,
  options: { verifyRoles?: boolean; maxPages?: number } = {},
): Promise<DomainCrawlResult> {
  const t0 = Date.now();
  const domain = normalizeDomain(domainInput);
  const pipeline: DomainCrawlResult["pipeline"] = [];
  const pagesAttempted: string[] = [];
  const maxPages = Math.min(options.maxPages ?? MAX_PAGES, 40);

  if (!isValidDomainShape(domain) || isDisposableDomain(domain)) {
    return {
      domain,
      companyName: null,
      website: `https://${domain}`,
      hasMx: false,
      mxProvider: null,
      mxHosts: [],
      emails: [],
      patterns: [],
      pagesCrawled: 0,
      pagesAttempted: [],
      durationMs: Date.now() - t0,
      pipeline: [
        {
          id: "domain",
          label: "Domain",
          status: "error",
          detail: "Invalid or disposable domain",
          ms: 0,
        },
      ],
    };
  }

  const tMx = Date.now();
  const mx = await lookupMx(domain);
  pipeline.push({
    id: "mx",
    label: "MX lookup",
    status: mx.hasMx ? "ok" : "warn",
    detail: mx.hasMx
      ? `MX via ${mx.provider ?? mx.mxHosts[0]?.exchange ?? "custom"}`
      : "No MX records",
    ms: Date.now() - tMx,
  });

  const emailMap = new Map<string, DiscoveredEmail>();
  const now = () => new Date().toISOString();

  const addEmail = (
    email: string,
    url: string,
    kind: CrawlSourceKind,
  ) => {
    const key = email.toLowerCase();
    if (!key.endsWith(`@${domain}`)) return;
    const source: CrawlSource = { url, extractedAt: now(), kind };
    const existing = emailMap.get(key);
    if (existing) {
      if (!existing.sources.some((s) => s.url === url)) {
        existing.sources.push(source);
        existing.confidence = scoreDiscovered(
          key,
          existing.sources,
          existing.status,
        );
      }
      return;
    }
    const role = isRoleBasedEmail(key);
    emailMap.set(key, {
      email: key,
      confidence: scoreDiscovered(key, [source], "found"),
      status: "found",
      sources: [source],
      isRoleBased: role,
      kind: role ? "role" : "person",
      firstName: role ? key.split("@")[0] : undefined,
    });
  };

  const seen = new Set<string>();
  const queue: string[] = [];
  const enqueue = (url: string) => {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "").toLowerCase();
      if (host !== domain && !host.endsWith(`.${domain}`)) return;
      u.hash = "";
      const key = `${u.protocol}//${u.hostname}${u.pathname}`
        .replace(/\/+$/, "")
        .toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      queue.push(u.href);
    } catch {
      // ignore
    }
  };

  enqueue(`https://${domain}/`);
  enqueue(`https://www.${domain}/`);
  for (const path of PRIORITY_PATHS) {
    enqueue(`https://${domain}${path}`);
    enqueue(`https://www.${domain}${path}`);
  }

  const tSm = Date.now();
  let sitemapCount = 0;
  for (const sm of [
    `https://${domain}/sitemap.xml`,
    `https://${domain}/sitemap_index.xml`,
    `https://${domain}/wp-sitemap.xml`,
    `https://www.${domain}/sitemap.xml`,
    `https://${domain}/robots.txt`,
  ]) {
    const res = await fetchText(sm);
    if (!res.ok || !res.body) continue;
    if (sm.endsWith("robots.txt")) {
      for (const m of res.body.matchAll(/sitemap:\s*(\S+)/gi)) {
        const smRes = await fetchText(m[1]);
        if (!smRes.ok) continue;
        if (
          smRes.body.includes("<sitemapindex") ||
          smRes.body.includes("<sitemap>")
        ) {
          for (const child of parseSitemapLocs(smRes.body, domain, 6)) {
            const childRes = await fetchText(child);
            if (childRes.ok) {
              for (const loc of parseSitemapLocs(childRes.body, domain, 30)) {
                enqueue(loc);
                sitemapCount++;
              }
            }
          }
        } else {
          for (const loc of parseSitemapLocs(smRes.body, domain)) {
            enqueue(loc);
            sitemapCount++;
          }
        }
      }
    } else if (
      res.body.includes("<sitemapindex") ||
      (res.body.includes("<sitemap>") && res.body.includes("<loc>"))
    ) {
      for (const child of parseSitemapLocs(res.body, domain, 8)) {
        const childRes = await fetchText(child);
        if (childRes.ok) {
          for (const loc of parseSitemapLocs(childRes.body, domain, 30)) {
            enqueue(loc);
            sitemapCount++;
          }
        }
      }
    } else {
      for (const loc of parseSitemapLocs(res.body, domain)) {
        enqueue(loc);
        sitemapCount++;
      }
    }
  }
  pipeline.push({
    id: "sitemap",
    label: "Sitemap discovery",
    status: sitemapCount > 0 ? "ok" : "skip",
    detail:
      sitemapCount > 0
        ? `${sitemapCount} URLs from sitemaps`
        : "No sitemap URLs",
    ms: Date.now() - tSm,
  });

  const tApi = Date.now();
  let apiHits = 0;
  for (const api of [
    `https://${domain}/wp-json/wp/v2/pages?per_page=50`,
    `https://www.${domain}/wp-json/wp/v2/pages?per_page=50`,
    `https://${domain}/wp-json/wp/v2/posts?per_page=30`,
    `https://${domain}/wp-json/wp/v2/users?per_page=20`,
  ]) {
    const res = await fetchText(api);
    if (!res.ok || !res.body) continue;
    for (const e of extractEmailsFromText(res.body, domain)) {
      addEmail(e.email, api, "api");
      apiHits++;
    }
    for (const m of res.body.matchAll(/"link"\s*:\s*"([^"]+)"/g)) {
      try {
        const link = JSON.parse(`"${m[1]}"`) as string;
        enqueue(link);
      } catch {
        enqueue(m[1].replace(/\\\//g, "/"));
      }
    }
  }
  pipeline.push({
    id: "api",
    label: "CMS / API index",
    status: apiHits > 0 ? "ok" : "skip",
    detail: apiHits > 0 ? `${apiHits} email hits from APIs` : "No CMS emails",
    ms: Date.now() - tApi,
  });

  const tCrawl = Date.now();
  let pagesCrawled = 0;
  let companyName: string | null = null;
  let website = `https://${domain}`;

  const CONCURRENCY = 5;
  while (queue.length > 0 && pagesCrawled < maxPages) {
    const batch: string[] = [];
    while (
      batch.length < CONCURRENCY &&
      queue.length > 0 &&
      pagesCrawled + batch.length < maxPages
    ) {
      batch.push(queue.shift()!);
    }
    for (const u of batch) pagesAttempted.push(u);
    const results = await Promise.all(batch.map((u) => fetchText(u)));
    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      const url = batch[i];
      if (!res.ok || !res.body) continue;
      pagesCrawled++;
      if (!companyName) {
        companyName = extractCompanyName(res.body, domain);
        website = res.finalUrl;
      }
      for (const e of extractEmailsFromText(res.body, domain)) {
        addEmail(e.email, res.finalUrl || url, e.via);
      }
      if (pagesCrawled < maxPages) {
        for (const link of extractSameDomainLinks(
          res.body,
          res.finalUrl || url,
          domain,
        )) {
          const path = new URL(link).pathname.toLowerCase();
          if (
            /contact|about|team|people|staff|privacy|legal|impressum|imprint|careers|press|support/.test(
              path,
            )
          ) {
            enqueue(link);
          } else if (queue.length < maxPages * 2) {
            enqueue(link);
          }
        }
      }
    }
  }

  pipeline.push({
    id: "crawl",
    label: "Website crawl",
    status: pagesCrawled > 0 ? "ok" : "error",
    detail: `Fetched ${pagesCrawled} pages · ${emailMap.size} unique emails`,
    ms: Date.now() - tCrawl,
  });

  const tRoles = Date.now();
  const shouldProbeRoles = options.verifyRoles !== false && mx.hasMx;
  if (shouldProbeRoles) {
    const existing = new Set(emailMap.keys());
    const missingRoles = ROLE_LOCALS.filter(
      (l) => !existing.has(`${l}@${domain}`),
    ).slice(0, 8);
    const toVerify = [
      ...[...emailMap.keys()].filter((e) => isRoleBasedEmail(e)).slice(0, 6),
      ...missingRoles.map((l) => `${l}@${domain}`),
    ].slice(0, 10);

    await Promise.all(
      toVerify.map(async (email) => {
        const v = await verifyEmail(email, { skipSmtp: false });
        if (v.status === "valid" || v.status === "catch_all") {
          if (!emailMap.has(email)) {
            addEmail(email, `smtp-probe://${domain}`, "role_probe");
          }
          const hit = emailMap.get(email);
          if (hit) {
            hit.status = v.status === "valid" ? "valid" : "catch_all";
            hit.confidence = scoreDiscovered(email, hit.sources, hit.status);
          }
        } else if (v.status === "invalid" && emailMap.has(email)) {
          const hit = emailMap.get(email)!;
          hit.status = "invalid";
          hit.confidence = scoreDiscovered(email, hit.sources, "invalid");
        }
      }),
    );
  }
  pipeline.push({
    id: "roles",
    label: "Role mailbox probe",
    status: shouldProbeRoles ? "ok" : "skip",
    detail: shouldProbeRoles
      ? "Probed common role addresses via SMTP"
      : "Skipped role SMTP",
    ms: Date.now() - tRoles,
  });

  // Patterns from discovered personal-looking emails
  const patternCounts = new Map<PatternId, number>();
  for (const e of emailMap.values()) {
    if (e.isRoleBased) continue;
    const id = detectPatternFromEmail(e.email);
    if (id) patternCounts.set(id, (patternCounts.get(id) ?? 0) + 1);
  }
  const totalPat = [...patternCounts.values()].reduce((a, b) => a + b, 0) || 1;
  const patterns: DomainPatternHit[] = (
    totalPat > 1
      ? [...patternCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([id, n]) => ({
            patternId: id,
            label: PATTERN_MAP.get(id)?.label ?? id,
            prevalence: n / totalPat,
            sampleCount: n,
            example: `jane.doe@${domain}`,
          }))
      : [
          {
            patternId: "first.last" as PatternId,
            label: "first.last",
            prevalence: 0.4,
            sampleCount: 0,
            example: `jane.doe@${domain}`,
          },
          {
            patternId: "first" as PatternId,
            label: "first",
            prevalence: 0.15,
            sampleCount: 0,
            example: `jane@${domain}`,
          },
          {
            patternId: "flast" as PatternId,
            label: "flast",
            prevalence: 0.13,
            sampleCount: 0,
            example: `jdoe@${domain}`,
          },
        ]
  ).slice(0, 6);

  const emails = [...emailMap.values()].sort(
    (a, b) => b.confidence - a.confidence,
  );

  return {
    domain,
    companyName,
    website,
    hasMx: mx.hasMx,
    mxProvider: mx.provider,
    mxHosts: mx.mxHosts.map((h) => h.exchange),
    emails,
    patterns,
    pagesCrawled,
    pagesAttempted,
    durationMs: Date.now() - t0,
    pipeline,
  };
}
