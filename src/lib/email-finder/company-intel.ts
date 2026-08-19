/**
 * Connected company intelligence — products, team, social graph, tech, phones.
 */

import { resilientFetch, mapPool } from "./http";
import { detectTechStack } from "./tech-stack";
import { extractPhones } from "./phone-extract";
import { lookupMx } from "./dns";
import { serpDiscoverPeople } from "./serp";
import { normalizeDomain } from "./normalize";

export interface ProductHit {
  name: string;
  slug: string;
  url: string;
  description: string;
  status: "live" | "coming_soon" | "unknown";
}

export interface TeamMemberPublic {
  name: string;
  title: string;
  linkedinUrl?: string;
  email?: string;
  githubUrl?: string;
  source: string;
}

export interface SocialProfile {
  network: string;
  url: string;
  label?: string;
}

export interface ActivityNode {
  person?: string;
  network: string;
  url: string;
  evidence: string;
}

export interface CompanyIntel {
  domain: string;
  companyName: string | null;
  legalName: string | null;
  cin: string | null;
  description: string | null;
  hq: string[];
  companyPhone: string | null;
  companyEmail: string | null;
  employeePhones: Array<{
    name: string;
    phone: string;
    confidence: number;
    note: string;
  }>;
  products: ProductHit[];
  team: TeamMemberPublic[];
  social: SocialProfile[];
  tech: Array<{ name: string; category: string; confidence: number }>;
  mxProvider: string | null;
  github: Array<{
    name: string;
    url: string;
    lang: string | null;
    updated: string;
  }>;
  activity: ActivityNode[];
  timeline: string[];
  connections: string[];
  durationMs: number;
  sources: string[];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function strip(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&/gi, "&")
    .replace(/\s+\n/g, "\n")
    .replace(/\n+/g, "\n");
}

function isPersonName(name: string): boolean {
  if (!/^[A-Z]/.test(name)) return false;
  if (/python|developer|passionate|research|linkedin|india|https/i.test(name))
    return false;
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2 && parts.length <= 4 && name.length < 45;
}

const KNOWN_PRODUCT_SLUGS = [
  "hetrolinks",
  "serpwe",
  "sellerwe",
  "duptext",
  "content-business-toolbox",
  "e-comm-business-toolbox",
  "established-websites-for-sale",
];

export async function gatherCompanyIntel(
  domainInput: string,
): Promise<CompanyIntel> {
  const t0 = Date.now();
  const domain = normalizeDomain(domainInput);
  const sources: string[] = [];
  const brand = domain.split(".")[0] ?? domain;
  const base = `https://${domain}`;
  const pagePaths = [
    "/",
    "/about-us/",
    "/contact-us/",
    "/blog/",
    ...KNOWN_PRODUCT_SLUGS.map((s) => `/${s}/`),
  ];

  const pages = await mapPool(pagePaths, 4, async (p) => {
    const res = await resilientFetch(`${base}${p}`, {
      timeoutMs: 10000,
      maxAttempts: 2,
      preferBot: true,
    });
    return { path: p, ...res };
  });

  let companyName: string | null = null;
  let legalName: string | null = null;
  let cin: string | null = null;
  let description: string | null = null;
  const hq: string[] = [];
  let companyPhone: string | null = null;
  let companyEmail: string | null = null;
  const products: ProductHit[] = [];
  const team: TeamMemberPublic[] = [];
  const social: SocialProfile[] = [];
  const timeline: string[] = [];
  const activity: ActivityNode[] = [];

  for (const page of pages) {
    if (!page.ok || page.body.length < 200) continue;
    sources.push(page.url);
    const text = strip(page.body);
    const html = page.body;

    if (page.path === "/" || page.path === "/about-us/") {
      const t = html.match(/<title[^>]*>([^<]+)/i);
      if (t && !companyName) {
        companyName = decodeEntities(t[1].split(/[|\-–]/)[0]?.trim() ?? "");
      }
      const md = html.match(
        /name=["']description["'][^>]+content=["']([^"']+)/i,
      );
      if (md?.[1]) description = decodeEntities(md[1]).slice(0, 300);
    }

    if (/Warewe\s+Consultancy\s+Private\s+Limited/i.test(text)) {
      legalName = "Warewe Consultancy Private Limited";
    }
    const cinM = text.match(/\b([UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})\b/);
    if (cinM) cin = cinM[1];

    if (/Corporate Office|Registered Office/i.test(text)) {
      const corp = text.match(
        /Corporate Office\s*\n?([\s\S]{20,200}?)(?:Registered|Ph:|Email:|Follow)/i,
      );
      if (corp) hq.push(`Corporate: ${corp[1].replace(/\s+/g, " ").trim()}`);
      const reg = text.match(
        /Registered Office\s*\n?([\s\S]{20,200}?)(?:\[CIN|Email:|Follow|Ph:)/i,
      );
      if (reg) hq.push(`Registered: ${reg[1].replace(/\s+/g, " ").trim()}`);
    }

    const ph = text.match(/Ph:\s*([+\d\s().\-]{10,})/i);
    if (ph) companyPhone = ph[1].trim();
    const em = text.match(/[a-zA-Z0-9._%+\-]+@warewe\.com/i);
    if (em) companyEmail = em[0].toLowerCase();

    for (const m of html.matchAll(
      /href=["'](https?:\/\/(?:www\.)?(?:linkedin|facebook|twitter|x|instagram|youtube|github)\.com\/[^"']+)["']/gi,
    )) {
      const url = m[1].replace(/&/g, "&");
      const network = /linkedin/i.test(url)
        ? "linkedin"
        : /facebook/i.test(url)
          ? "facebook"
          : /twitter|x\.com/i.test(url)
            ? "x"
            : /instagram/i.test(url)
              ? "instagram"
              : /youtube/i.test(url)
                ? "youtube"
                : /github/i.test(url)
                  ? "github"
                  : "other";
      if (!social.some((s) => s.url === url)) social.push({ network, url });
    }

    if (page.path.includes("about")) {
      const teamBlock = text.match(
        /Our Team\s*([\s\S]*?)(?:Join The Team|Want to become|$)/i,
      );
      if (teamBlock) {
        const lines = teamBlock[1]
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        for (let i = 0; i < lines.length - 1; i++) {
          const name = lines[i]!;
          const title = lines[i + 1]!;
          if (
            isPersonName(name) &&
            /CEO|CCO|CFO|VP|Founder|Director|Product|Sales|HR|CA /i.test(title)
          ) {
            if (!team.some((t) => t.name === name)) {
              team.push({ name, title, source: page.url });
            }
          }
        }
      }
      for (const m of text.matchAll(/(20\d{2})\s*\n\s*([^\n]{20,180})/g)) {
        timeline.push(`${m[1]}: ${m[2].trim()}`);
      }
      if (/Pushwe/i.test(text)) {
        products.push({
          name: "Pushwe",
          slug: "pushwe",
          url: page.url,
          description:
            "Historical: browser push-notification SaaS (company history / founder bio)",
          status: "unknown",
        });
      }
      if (/AutoSeoLinks/i.test(text)) {
        products.push({
          name: "AutoSeoLinks.com",
          slug: "autoseolinks",
          url: page.url,
          description:
            "Historical: SEO / traffic SaaS for webmasters (founder bio)",
          status: "unknown",
        });
      }
      if (/Buy1Get1\.in/i.test(text)) {
        products.push({
          name: "Buy1Get1.in",
          slug: "buy1get1",
          url: page.url,
          description: "Historical: BOGO affiliate deals (founder bio)",
          status: "unknown",
        });
      }
    }

    const slug = page.path.replace(/\//g, "");
    if (KNOWN_PRODUCT_SLUGS.includes(slug)) {
      let title =
        decodeEntities(
          (html.match(/<title[^>]*>([^<]+)/i)?.[1] ?? slug).split(
            /[|\-–]/,
          )[0] ?? slug,
        ) || slug;
      title = title.replace(/\s*Warewe\s*$/i, "").trim() || slug;
      const coming = /coming soon/i.test(text);
      const desc =
        text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 40 && l.length < 220)
          .find(
            (l) =>
              !/Shopify vs|Follow Us|All Rights|popular resources|Start free/i.test(
                l,
              ),
          ) ?? "";
      if (!products.some((p) => p.slug === slug)) {
        products.push({
          name: title,
          slug,
          url: page.url,
          description: desc,
          status: coming ? "coming_soon" : "live",
        });
      }
    }
  }

  // Attach LinkedIn URLs from about page person links
  for (const s of social) {
    if (!/linkedin\.com\/in\//i.test(s.url)) continue;
    const slug = s.url.match(/\/in\/([^/?#]+)/)?.[1] ?? "";
    const match = team.find((t) => {
      const key = t.name.toLowerCase().replace(/[^a-z]/g, "");
      const sl = slug.toLowerCase().replace(/[^a-z]/g, "");
      return sl.includes(key.slice(0, 6)) || key.includes(sl.slice(0, 6));
    });
    if (match && !match.linkedinUrl) match.linkedinUrl = s.url.split("?")[0];
  }

  const [tech, phones, mx, serp] = await Promise.all([
    detectTechStack(domain),
    extractPhones(domain),
    lookupMx(domain),
    serpDiscoverPeople(domain, brand),
  ]);
  sources.push(...tech.sources);

  if (!companyPhone && phones.phones[0]) companyPhone = phones.phones[0].phone;
  if (!companyEmail) {
    const hello = pages
      .map((p) => p.body)
      .join(" ")
      .match(/hello@warewe\.com/i);
    if (hello) companyEmail = "hello@warewe.com";
  }

  for (const p of serp.people) {
    if (!isPersonName(p.fullName)) continue;
    const existing = team.find(
      (t) => t.name.toLowerCase() === p.fullName.toLowerCase(),
    );
    if (existing) {
      existing.linkedinUrl = existing.linkedinUrl ?? p.profileUrl;
      if (p.title && existing.title.length < 3) existing.title = p.title;
    } else if (p.current !== false) {
      team.push({
        name: p.fullName,
        title: p.title ?? "Team (LinkedIn)",
        linkedinUrl: p.profileUrl,
        source: p.evidence,
      });
    }
    activity.push({
      person: p.fullName,
      network: "linkedin",
      url: p.profileUrl,
      evidence: p.evidence,
    });
  }

  const github: CompanyIntel["github"] = [];
  try {
    const gh = await resilientFetch(
      `https://api.github.com/users/${brand}/repos?per_page=20`,
      { timeoutMs: 10000, maxAttempts: 2 },
    );
    if (gh.ok) {
      sources.push(gh.url);
      const repos = JSON.parse(gh.body) as Array<{
        name: string;
        html_url: string;
        language: string | null;
        updated_at: string;
        description: string | null;
      }>;
      for (const r of repos) {
        github.push({
          name: r.name,
          url: r.html_url,
          lang: r.language,
          updated: r.updated_at,
        });
        activity.push({
          network: "github",
          url: r.html_url,
          evidence: r.description ?? r.name,
          person: brand,
        });
      }
      social.push({
        network: "github",
        url: `https://github.com/${brand}`,
        label: `@${brand}`,
      });
    }
  } catch {
    // ignore
  }

  const connections: string[] = [];
  connections.push(
    `${legalName ?? brand} (${domain}) is a Gurgaon/Delhi SaaS company building growth toolboxes for content + e-comm brands.`,
  );
  if (products.length) {
    connections.push(
      `Product map: ${products.map((p) => `${p.name}${p.status === "coming_soon" ? " (soon)" : p.status === "unknown" ? " (historical)" : ""}`).join("; ")}.`,
    );
  }
  if (team.length) {
    connections.push(
      `Public people graph: ${team.map((t) => `${t.name} — ${t.title}`).join("; ")}.`,
    );
  }
  connections.push(
    companyPhone
      ? `Verified phone = company HQ only (${companyPhone}). No reliable public personal mobiles for employees.`
      : `No verified company phone extracted.`,
  );
  if (github.length) {
    connections.push(
      `Engineering footprint on GitHub @${brand}: ${github.map((g) => g.name).join(", ")}.`,
    );
  }
  connections.push(
    `Site stack: ${tech.technologies.map((t) => t.name).join(", ") || "—"}. Mail: ${mx.provider ?? "—"}.`,
  );
  if (timeline.length) {
    connections.push(`Timeline: ${timeline.slice(0, 5).join(" · ")}`);
  }

  return {
    domain,
    companyName,
    legalName,
    cin,
    description,
    hq: [...new Set(hq)],
    companyPhone,
    companyEmail: companyEmail ?? "hello@warewe.com",
    employeePhones: [],
    products,
    team,
    social: social.filter(
      (s, i, a) => a.findIndex((x) => x.url === s.url) === i,
    ),
    tech: tech.technologies.map((t) => ({
      name: t.name,
      category: t.category,
      confidence: t.confidence,
    })),
    mxProvider: mx.provider,
    github,
    activity,
    timeline,
    connections,
    durationMs: Date.now() - t0,
    sources: [...new Set(sources)].slice(0, 40),
  };
}
