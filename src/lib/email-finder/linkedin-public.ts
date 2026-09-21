/**
 * LinkedIn profile: Voyager (if session) → guest HTML → Decodo public card.
 * LinkedIn has no unauthenticated Profile API; guest HTML is authwalled.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { DiscoverPerson } from "./voyager-search";
import { companyNameFitsDomain } from "./identity-lock";

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
  const staticLine = env("OKK_PROXY");
  const tryCurl = async (args: string[]) => {
    try {
      const { stdout } = await execFileAsync("curl", args, {
        maxBuffer: 2_500_000,
        timeout: 16_000,
      });
      return stdout.length > 2000 ? stdout : null;
    } catch {
      return null;
    }
  };
  if (cfg) {
    try {
      const text = await (await fetch(cfg, { signal: AbortSignal.timeout(4000) })).text();
      const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.includes(":") && !l.startsWith("#"));
      if (line) {
        const [host, port, user, ...rest] = line.split(":");
        const pass = rest.join(":");
        const sid = randomBytes(3).toString("hex");
        const proxyUser = `${(user ?? "").replace(/-sid-[a-z0-9]+$/i, "")}-sid-${sid}`;
        const html = await tryCurl([
          "-sS", "-m", "14", "-L", "--max-redirs", "2", "--compressed",
          "-A", UA,
          "-x", `http://${proxyUser}:${pass}@${host}:${port}`,
          url,
        ]);
        if (html) return html;
      }
    } catch {
      /* */
    }
  }
  if (staticLine) {
    const parts = staticLine.split(":");
    if (parts.length >= 4) {
      const [host, port, user, ...rest] = parts;
      const pass = rest.join(":");
      const sid = randomBytes(4).toString("hex");
      const user2 = (user ?? "").replace(/sessid-[A-Za-z0-9]+/i, `sessid-${sid}`);
      const html = await tryCurl([
        "-sS", "-m", "14", "-L", "--max-redirs", "2", "--compressed",
        "-A", UA,
        "--socks5-hostname", `${user2}:${pass}@${host}:${port}`,
        url,
      ]);
      if (html) return html;
    }
  }
  return null;
}

const TECH_NOT_COMPANY =
  /^(k8s|kubernetes|gpu|aws|azure|gcp|linux|docker|terraform|python|java|react|node\.?js|ai|ml|cloud|devops)$/i;
const SLOGAN =
  /\b(temple|passionate|helping|love to|enthusiast|ninja|guru|is my|advocate|geek|wizard|i help|we help|stop blending)\b/i;
const ROLE_WORD =
  /\b(manager|director|engineer|officer|lead|vp|head|founder|writer|specialist|consultant|analyst|executive|designer|marketer|strategist|officer|intern|associate|partner|owner|ceo|cto|cfo|coo|president)\b/i;

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
  if (/^(i|we)\s/i.test(t) && !ROLE_WORD.test(t)) return undefined;
  if (t.split(/\s+/).length > 8 && !ROLE_WORD.test(t)) return undefined;
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

export type PublicProfile = {
  fullName: string;
  title?: string;
  company?: string;
  domain?: string;
  location?: string;
  linkedinUrl: string;
  slug: string;
  experience?: Array<{ title?: string; company?: string; current?: boolean }>;
  source?: string;
};

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
  };
}

function liText(v: unknown, depth = 0): string {
  if (v == null || depth > 4) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v !== "object") return "";
  const o = v as Record<string, unknown>;
  if (typeof o.text === "string") return o.text.trim();
  if (typeof o.value === "string") return o.value.trim();
  if (o.localized && typeof o.localized === "object") {
    const loc = o.localized as Record<string, unknown>;
    const us = loc.en_US ?? loc.en_us;
    if (typeof us === "string") return us.trim();
    const first = Object.values(loc).find((x) => typeof x === "string");
    if (typeof first === "string") return first.trim();
  }
  if (o.value && typeof o.value === "object") return liText(o.value, depth + 1);
  return "";
}

function yearOf(v: unknown): number {
  if (!v || typeof v !== "object") return 0;
  const o = v as Record<string, unknown>;
  const y = o.year ?? o.startYear ?? (o.start as Record<string, unknown> | undefined)?.year;
  return typeof y === "number" ? y : Number(y) || 0;
}

function isCurrentRole(x: Record<string, unknown>): boolean {
  if (x.ended === true || x.ended === "true") return false;
  if (x.isCurrent === true || x.current === true) return true;
  const dr = (x.dateRange ?? x.timePeriod ?? x.dateRangeV2 ?? {}) as Record<string, unknown>;
  const end = dr.end ?? dr.endDate ?? dr.endDateTime ?? x.endDate ?? x.endedOn;
  if (end == null || end === "") return true;
  if (typeof end === "object") {
    const e = end as Record<string, unknown>;
    if (e.year == null && e.month == null) return true;
    return false;
  }
  return false;
}

function parseVoyagerIncluded(
  included: Array<Record<string, unknown>>,
  slug: string,
): Partial<PublicProfile> | null {
  let fullName = "";
  let headlineTitle: string | undefined;
  let headlineCompany: string | undefined;
  let location: string | undefined;
  const positions: Array<{
    title?: string;
    company?: string;
    domain?: string;
    current: boolean;
    start: number;
  }> = [];

  for (const x of included) {
    const t = String(x.$type ?? x.type ?? "");
    const urn = String(x.entityUrn ?? "");
    const first = liText(x.firstName) || liText(x.firstNameV2) || liText(x.givenName);
    const last = liText(x.lastName) || liText(x.lastNameV2) || liText(x.familyName);
    const isProfile =
      urn.includes("fsd_profile") ||
      (t.includes("Profile") && !t.includes("Position") && !t.includes("Education"));
    if (first && last && (isProfile || !fullName)) {
      const n = `${first} ${last}`.replace(/\s+/g, " ").trim();
      if (n.split(/\s+/).length >= 2) fullName = n;
    }
    const head =
      liText(x.headline) ||
      liText(x.occupation) ||
      liText(x.multiLocaleHeadline) ||
      liText(x.headlineV2);
    if (head && isProfile) {
      const at = head.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
      if (at) {
        headlineTitle = cleanRoleTitle(at[1]!.trim()) || headlineTitle;
        const co = at[2]!.replace(/\s*[-–|].*$/, "").trim();
        if (co && !TECH_NOT_COMPANY.test(co) && !/^linkedin$/i.test(co)) headlineCompany = co;
      } else {
        headlineTitle = headlineTitle || cleanRoleTitle(head);
      }
    }
    const geo =
      liText(x.geoLocationName) ||
      liText(x.locationName) ||
      liText(x.geo) ||
      liText((x.geoLocation as Record<string, unknown> | undefined)?.geo);
    if (geo && geo.length < 48 && !/university|college|school|vidyalaya/i.test(geo)) {
      location = location || geo;
    }
    const posTitle = liText(x.title) || liText(x.localizedTitle);
    const posCo =
      liText(x.companyName) ||
      liText(x.company) ||
      (typeof x.company === "object" ? liText((x.company as Record<string, unknown>).name) : "");
    const isPos = t.includes("Position") || t.includes("Experience") || (posTitle && posCo);
    if (isPos && (posTitle || posCo)) {
      const site =
        liText(x.companyPageUrl) ||
        liText(x.websiteUrl) ||
        liText(x.website) ||
        (typeof x.company === "object"
          ? liText((x.company as Record<string, unknown>).websiteUrl) ||
            liText((x.company as Record<string, unknown>).universalName)
          : "");
      const domain =
        typeof site === "string" && /\./.test(site) && !/linkedin\.com/i.test(site)
          ? site.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]
          : undefined;
      const start =
        yearOf(x.dateRange) ||
        yearOf((x.dateRange as Record<string, unknown> | undefined)?.start) ||
        yearOf(x.timePeriod) ||
        yearOf((x.timePeriod as Record<string, unknown> | undefined)?.startDate);
      if (posCo && TECH_NOT_COMPANY.test(posCo)) continue;
      if (posCo && /^linkedin$/i.test(posCo)) continue;
      positions.push({
        title: posTitle ? cleanRoleTitle(posTitle, posCo) : undefined,
        company: posCo || undefined,
        domain,
        current: isCurrentRole(x),
        start,
      });
    }
  }
  const current = positions
    .filter((p) => p.current && p.company)
    .sort((a, b) => b.start - a.start)[0];
  const company = current?.company || headlineCompany;
  const title = current?.title || headlineTitle;
  let domain = current?.domain;
  if (!fullName) return null;
  return {
    fullName,
    title,
    company,
    domain,
    location,
    slug,
    linkedinUrl: `https://www.linkedin.com/in/${slug}/`,
    experience: positions
      .filter((p) => p.company)
      .sort((a, b) => Number(b.current) - Number(a.current) || b.start - a.start)
      .slice(0, 8)
      .map((p) => ({ title: p.title, company: p.company, current: p.current })),
  };
}

function decodeLiJson(raw: string): string {
  return raw
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&(?:amp|#38);/g, "&")
    .replace(/&(?:lt|#60);/g, "<")
    .replace(/&(?:gt|#62);/g, ">")
    .replace(/<!--[\s\S]*?-->/g, "");
}

function parseSsrProfile(html: string, slug: string): Partial<PublicProfile> | null {
  if (!html || html.length < 800) return null;
  if (/trkCode|unusual traffic|authwall|checkpoint/i.test(html.slice(0, 2500)) && html.length < 4000) {
    return null;
  }
  const og = parseOgProfile(html, slug);
  const jsonLd = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i,
  )?.[1];
  if (jsonLd) {
    try {
      const ld = JSON.parse(jsonLd) as {
        name?: string;
        jobTitle?: string;
        worksFor?: { name?: string };
        address?: { addressLocality?: string; addressCountry?: string };
      };
      if (ld.name && ld.name.split(/\s+/).length >= 2) og.fullName = og.fullName || ld.name;
      if (ld.jobTitle) og.title = og.title || cleanRoleTitle(ld.jobTitle);
      if (ld.worksFor?.name) og.company = og.company || ld.worksFor.name;
      const loc = [ld.address?.addressLocality, ld.address?.addressCountry]
        .filter(Boolean)
        .join(", ");
      if (loc && !/university|college|school|vidyalaya/i.test(loc)) og.location = og.location || loc;
    } catch {
      /* */
    }
  }
  const included: Array<Record<string, unknown>> = [];
  for (const m of html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/gi)) {
    const blob = decodeLiJson(m[1]!);
    if (!/"firstName"|"headline"|"fsd_profile"/.test(blob)) continue;
    try {
      const j = JSON.parse(blob) as {
        included?: Array<Record<string, unknown>>;
        data?: { included?: Array<Record<string, unknown>> };
        firstName?: unknown;
      };
      if (Array.isArray(j.included)) included.push(...j.included);
      else if (Array.isArray(j.data?.included)) included.push(...j.data!.included!);
      else if (j.firstName) included.push(j as unknown as Record<string, unknown>);
    } catch {
      /* */
    }
  }
  const voy = included.length ? parseVoyagerIncluded(included, slug) : null;
  const fullName = voy?.fullName || og.fullName;
  if (!fullName) return null;
  return {
    fullName,
    title: voy?.title || og.title,
    company: voy?.company || og.company,
    domain: voy?.domain || og.domain,
    location: voy?.location || og.location,
    slug,
    linkedinUrl: `https://www.linkedin.com/in/${slug}/`,
  };
}

async function voyagerProfileBySlug(slug: string): Promise<Partial<PublicProfile> | null> {
  try {
    const { apialtEnabled, apialtProfile } = await import("./apialt");
    if (apialtEnabled()) {
      const hit = await apialtProfile(slug);
      if (hit?.fullName) return hit;
      return null;
    }
    const { liGet, loadLiSession, liCircuitOpen } = await import("./linkedin-http");
    // ONE cookie call per lookup. Chaining dash + SN + HTML is what LinkedIn
    // treats as a farm and uses to log the seat out.
    const sessOn = !!loadLiSession();
    const circ = liCircuitOpen();
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync("/tmp/li-dash-attempt.json", JSON.stringify({ slug, sessOn, circ, at: Date.now() }));
    } catch {
      /* */
    }
    if (sessOn && !circ) {
      const dash =
        "https://www.linkedin.com/voyager/api/identity/dash/profiles" +
        `?q=memberIdentity&memberIdentity=${encodeURIComponent(slug)}` +
        "&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-96";
      const res = await liGet(dash, `https://www.linkedin.com/in/${slug}/`);
      try {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(
          "/tmp/li-dash-attempt.json",
          JSON.stringify({ slug, sessOn: true, circ: false, status: res.status, len: res.body.length, via: res.via }),
        );
      } catch {
        /* */
      }
      if (res.status === 200 && res.body.length > 80) {
        const j = JSON.parse(res.body) as {
          included?: Array<Record<string, unknown>>;
          data?: { included?: Array<Record<string, unknown>> };
          profile?: Record<string, unknown>;
          firstName?: unknown;
        };
        const included = j.included ?? j.data?.included ?? [];
        const parsed =
          (included.length ? parseVoyagerIncluded(included, slug) : null) ||
          (j.profile || j.firstName
            ? parseVoyagerIncluded(
                [j.profile ?? (j as unknown as Record<string, unknown>)],
                slug,
              )
            : null);
        try {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(
            "/tmp/li-last-dash.json",
            JSON.stringify({
              slug,
              len: res.body.length,
              company: parsed?.company,
              title: parsed?.title,
              experience: parsed?.experience,
              inc: included.length,
            }),
          );
          writeFileSync("/tmp/li-last-dash-body.json", res.body.slice(0, 200_000));
        } catch {
          /* */
        }
        if (parsed?.fullName) return parsed;
      }
      return null;
    }
    const guest = await fetchViaOkk(`https://www.linkedin.com/in/${slug}/`);
    if (guest) {
      const parsed = parseSsrProfile(guest, slug);
      if (parsed?.fullName) return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

const profileCache = new Map<string, { at: number; value: PublicProfile | null }>();

async function lockProfileDomain(value: PublicProfile): Promise<PublicProfile> {
  const title = cleanRoleTitle(value.title, value.company);
  let domain = value.domain;
  const company = value.company;
  if (company && !TECH_NOT_COMPANY.test(company) && !SLOGAN.test(company)) {
    if (domain && !companyNameFitsDomain(company, domain)) domain = undefined;
    if (!domain) {
      try {
        const { resolveCompanyDomain } = await import("./company-suggest");
        domain = await resolveCompanyDomain(company);
        if (domain && !companyNameFitsDomain(company, domain)) domain = undefined;
      } catch {
        /* keep company; domain stays unset rather than a lookalike */
      }
    }
  } else if (!company) {
    domain = undefined;
  }
  const experience = (value.experience ?? []).map((e) => ({
    ...e,
    title: cleanRoleTitle(e.title, e.company) ?? e.title,
  }));
  return { ...value, title, domain, experience };
}

export async function enrichLinkedInProfile(
  rawUrl: string,
): Promise<PublicProfile | null> {
  const { parseLinkedInUrl, nameFromSlug } = await import("./linkedin");
  const { profileSlugFromUrl } = await import("./identity-lock");
  const li = parseLinkedInUrl(rawUrl);
  if (!li.slug) {
    const fallback = profileSlugFromUrl(rawUrl);
    if (fallback) li.slug = fallback;
  }
  if (!li.slug) return null;
  const { getIndexedProfile, putIndexedProfile } = await import("./li-profile-index");

  const persist = (value: PublicProfile) => {
    profileCache.set(li.slug.toLowerCase(), { at: Date.now(), value });
    if (value.company || value.title) putIndexedProfile(value);
  };

  const cached = profileCache.get(li.slug.toLowerCase());
  if (cached?.value && Date.now() - cached.at < 10 * 60_000) {
    const locked = await lockProfileDomain(cached.value);
    if (locked.domain !== cached.value.domain || locked.title !== cached.value.title) persist(locked);
    return locked;
  }
  const indexed = getIndexedProfile(li.slug);
  if (indexed?.fullName && (indexed.company || indexed.title)) {
    const value = await lockProfileDomain({
      fullName: indexed.fullName,
      title: indexed.title,
      company: indexed.company,
      domain: indexed.domain,
      location: indexed.location,
      linkedinUrl: indexed.linkedinUrl,
      slug: li.slug,
      experience: indexed.experience,
    });
    persist(value);
    return value;
  }
  const linkedinUrl = `https://www.linkedin.com/in/${li.slug}/`;
  const fromSlug = nameFromSlug(li.slug);
  const fallbackName =
    fromSlug?.raw && fromSlug.raw.split(/\s+/).length >= 2
      ? fromSlug.raw
      : "";

  let title: string | undefined;
  let company: string | undefined;
  let location: string | undefined;
  let fullName = fallbackName.split(/\s+/).filter(Boolean).length >= 2 ? fallbackName : "";
  let experience: PublicProfile["experience"];

  const voy = await voyagerProfileBySlug(li.slug);
  if (voy?.fullName) fullName = voy.fullName;
  if (voy?.title) title = voy.title;
  if (voy?.company) company = voy.company;
  if (voy?.location) location = voy.location;
  if (voy?.experience?.length) experience = voy.experience;

  if (!fullName || !company) {
    try {
      const { decodoSearch } = await import("./decodo-serp");
      const [byUrl, bySlug] = await Promise.all([
        decodoSearch(`"${linkedinUrl}"`),
        decodoSearch(`site:linkedin.com/in/${li.slug}`),
      ]);
      const apply = (row: { title?: string; link?: string; description?: string }, trusted: boolean) => {
        const url = row.link ?? "";
        const path = `/in/${li.slug}`.toLowerCase();
        const blob = `${row.title ?? ""} ${row.description ?? ""}`;
        if (
          !trusted &&
          !url.toLowerCase().includes(path) &&
          !blob.toLowerCase().includes(li.slug.toLowerCase())
        )
          return;
        const head = (row.title ?? "")
          .replace(/\s*\|\s*LinkedIn.*$/i, "")
          .replace(/\s*\.{2,}$/g, "")
          .replace(/\s+/g, " ")
          .trim();
        const bits = head.split(/\s*[-–|]\s*/);
        const n = (bits[0] ?? "").trim();
        if (
          !fullName &&
          n.split(/\s+/).length >= 2 &&
          n.split(/\s+/).length <= 4 &&
          !/\b(asap|landing|page|hire|job|salary|remote|click|apply|urgent|needed)\b/i.test(n) &&
          !/^linkedin$/i.test(n)
        )
          fullName = n;
        const rest = bits.slice(1).join(" - ");
        const fromHead = rest.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
        const fromDesc = blob.match(
          /((?:Founder|Co-Founder|CEO|CTO|CFO|COO|CMO|Director|Manager|Head|Engineer|Consultant|President|Owner)[^·|]{0,60}?)\s+at\s+([^·|]+)/i,
        );
        const role = (fromHead?.[1] ?? fromDesc?.[1] ?? rest)?.trim();
        const co = (fromHead?.[2] ?? fromDesc?.[2] ?? "")
          .replace(/\s*[-–|].*$/, "")
          .replace(/\s*\.{2,}$/g, "")
          .trim();
        if (role && !title) title = cleanRoleTitle(role, company) || title;
        if (co && !company && !TECH_NOT_COMPANY.test(co) && !SLOGAN.test(co) && !/^linkedin$/i.test(co))
          company = co;
        const loc = (row.description ?? "").match(
          /\b([A-Z][a-zA-Z.]{2,20}(?:\s+[A-Z][a-zA-Z.]{2,16}){0,2},\s*(?:[A-Z]{2}|[A-Z][a-z]{2,20}(?:\s+[A-Z][a-z]{2,16})?))\b/,
        )?.[1];
        if (
          loc &&
          !/university|vidyalaya|college|school|institute|campus|faculty|linkedin/i.test(loc) &&
          loc.length < 48
        )
          location = loc;
      };
      for (const row of bySlug) apply(row, true);
      for (const row of byUrl) apply(row, false);
    } catch {
      /* SERP optional */
    }
  }

  if (li.companyHint && !company) company = li.companyHint;
  let domain = voy?.domain || li.domainHint || undefined;
  if (!domain && company && !TECH_NOT_COMPANY.test(company) && !SLOGAN.test(company)) {
    try {
      const { resolveCompanyDomain } = await import("./company-suggest");
      domain = await resolveCompanyDomain(company);
    } catch {
      /* */
    }
  }

  if (!fullName) return null;
  const value = await lockProfileDomain({
    fullName,
    title,
    company,
    domain,
    location,
    linkedinUrl,
    slug: li.slug,
    experience,
    source: voy?.source,
  });
  if (value.company || value.title) persist(value);
  return value;
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
    if (p.domain || !p.company) continue;
    const d = domains.get(p.company.replace(/\s+/g, " ").trim().toLowerCase());
    if (d) p.domain = d;
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

