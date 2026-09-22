/**
 * Fast tech fingerprint:
 *   1. BuiltWith public profile (builtwith.com/{domain}) — free, detailed
 *   2. W3Techs named stack
 *   3. Live headers + MX
 *   4. Job/careers evidence
 *   5. BuiltWith Domain API if BUILTWITH_API_KEY is set
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TechHit {
  name: string;
  category: string;
  evidence: string;
  confidence: number;
}

export interface TechStackResult {
  domain: string;
  technologies: TechHit[];
  durationMs: number;
  sources: string[];
}

export const JOB_TECH: Array<{ name: string; category: string; re: RegExp; need?: RegExp }> = [
  { name: "SAP", category: "Accounting & Finance", re: /\bSAP\b/, need: /S\/4|HANA|FICO|ABAP|SuccessFactors|Basis|\bERP\b/i },
  { name: "Salesforce", category: "CRM", re: /\bSalesforce\b/, need: /Sales Cloud|Service Cloud|Apex|Administrator|Pardot/i },
  { name: "Pardot", category: "Marketing Automation", re: /\bPardot\b/ },
  { name: "Microsoft 365", category: "Productivity", re: /Microsoft 365|Office 365/i },
  { name: "Python", category: "Programming Language", re: /\bPython\b/ },
  { name: "JavaScript", category: "Programming Language", re: /\bJavaScript\b/ },
  { name: "Node.js", category: "Programming Framework", re: /\bNode\.?js\b/ },
  { name: "Kubernetes", category: "Cloud Computing Services", re: /\bKubernetes\b|\bK8s\b/ },
  { name: "Azure DevOps", category: "Cloud Computing Services", re: /Azure DevOps/i },
  { name: "GitHub Actions", category: "Cloud Computing Services", re: /GitHub Actions/i },
  { name: "Pyspark", category: "Data Processing", re: /\bPySpark\b/ },
  { name: "SQL", category: "Database", re: /\bSQL Server\b|\bPostgreSQL\b|\bT-SQL\b/ },
  { name: "git", category: "Programming Framework", re: /\bGitHub\b|\bgit\b/ },
];

const SKIP_W3 =
  /site elements|character encoding|document type|image file|markup|default protocol|structured data|social widgets|compression|cookies|top level domain|server location|content language|default subdomain|ipv6|http\/2|http\/3|strict transport|generic rdfa|json-ld|open graph|twitter\/x cards/i;

const CAT_MAP: Record<string, string> = {
  "content management system": "Content Management System",
  "server-side programming language": "Programming Framework",
  "client-side programming language": "Programming Language",
  "javascript library": "Programming Framework",
  "web server": "Web Server",
  "operating system": "Operating System",
  "email server provider": "Productivity",
  "tag manager": "Tag Management",
  "advertising network": "Advertising",
  "ssl certificate authority": "Security",
  "web hosting provider": "Infrastructure",
  "dns server provider": "Infrastructure",
  "data center provider": "Cloud Computing Services",
  "traffic analysis tools": "Analytics",
  "javascript content delivery networks": "Infrastructure",
};

const BW_CAT: Record<string, string> = {
  operations: "Operational Stack",
  cms: "Content Management System",
  analytics: "Analytics",
  framework: "Frameworks",
  javascript: "JavaScript",
  ads: "Advertising",
  hosting: "Cloud Computing Services",
  mx: "Email",
  ssl: "Security",
  widgets: "Widgets",
  cdn: "CDN",
  cdns: "CDN",
  "web-server": "Web Server",
  media: "Media",
};

const BW_SKIP_CAT = /^(link|language|mobile|registrar|server|web-master|feeds|encoding|docinfo|copyright|ns)$/i;

const BW_SKIP_NAME =
  /^(about cookies|apple whitelist|crux|cloudflare radar|common.?crawl|viewport meta|iphone|ipv6|hsts|ssl by default|dmarc|spf|english -|ai generated|multilingual|font awesome|google font|us privacy|getty|technical job|wikipedia|all about cookies|careers|sustainability|events page|artificial intelligence|modern slavery|verified|google webmaster|synergy wholesale|australian corporate|australian server|u\.s\. server|bootstrapcdn|cdn js|ajax libraries|content delivery network|intersection observer|javascript modules|google hosted|globalsign domain|pre year|facebook$|linkedin$|twitter$|youtube|do not sell|accessibility|login or signup|^x$)/i;

function env(key: string): string {
  if (process.env[key]) return process.env[key]!;
  try {
    const m = readFileSync("/workspace/.env", "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
    return m?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

export async function detectTechStack(
  domainInput: string,
  extraText = "",
): Promise<TechStackResult> {
  const t0 = Date.now();
  const domain = domainInput
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  const sources: string[] = [];
  const technologies: TechHit[] = [];
  const seen = new Set<string>();

  const add = (name: string, category: string, evidence: string, confidence: number) => {
    const key = name.replace(/\s+CMS$/i, "").replace(/\s+\d+(\.\d+)+$/, "").trim();
    if (!key || seen.has(key.toLowerCase())) return;
    if (
      /^(hsts|http\/2|http\/3|ipv6|open graph|json-ld|strict transport|microsoft (excel|word|office|powerpoint))$/i.test(
        key,
      )
    )
      return;
    if (BW_SKIP_NAME.test(key)) return;
    seen.add(key.toLowerCase());
    technologies.push({ name: key, category, evidence, confidence });
  };

  const [bwPublic, w3, bw, live, jobs] = await Promise.all([
    builtwithPublic(domain),
    w3techs(domain),
    builtwithDomain(domain),
    liveHeaders(domain),
    jobEvidence(domain, extraText),
  ]);
  sources.push(...bwPublic.sources, ...w3.sources, ...bw.sources, ...live.sources, ...jobs.sources);
  for (const t of [...bwPublic.hits, ...bw.hits, ...w3.hits, ...live.hits]) {
    add(t.name, t.category, t.evidence, t.confidence);
  }
  const cheapHost = technologies.some((t) =>
    /hostinger|hpanel|wix|squarespace|shopify|wordpress\.com|bluehost|godaddy/i.test(t.name),
  );
  for (const t of jobs.hits) {
    if (cheapHost && /^(SAP|Salesforce|Pardot|Kubernetes|Azure DevOps|Pyspark)$/i.test(t.name)) continue;
    add(t.name, t.category, t.evidence, t.confidence);
  }
  if (extraText) {
    for (const r of JOB_TECH) {
      if (!r.re.test(extraText)) continue;
      if (r.need && !r.need.test(extraText)) continue;
      if (cheapHost && /^(SAP|Salesforce|Pardot|Kubernetes)$/i.test(r.name)) continue;
      add(r.name, r.category, "jobs / company copy", 70);
    }
  }
  technologies.sort((a, b) => b.confidence - a.confidence);
  return { domain, technologies: technologies.slice(0, 40), durationMs: Date.now() - t0, sources };
}

export function parseBuiltWithHtml(html: string): TechHit[] {
  const hits: TechHit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /<h2 class="widget-title"><a href="\/\/trends\.builtwith\.com\/([^"/]+)\/[^"]+"[^>]*>([^<]{2,90})<\/a><\/h2>/gi,
  )) {
    const catKey = m[1]!.toLowerCase();
    const name = m[2]!.replace(/\s+/g, " ").trim();
    if (BW_SKIP_CAT.test(catKey) || BW_SKIP_NAME.test(name)) continue;
    if (/jquery \d/i.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      name,
      category: BW_CAT[catKey] ?? m[1]!,
      evidence: "BuiltWith",
      confidence: catKey === "operations" || catKey === "cms" ? 94 : 90,
    });
  }
  return hits;
}

async function builtwithPublic(domain: string): Promise<{ hits: TechHit[]; sources: string[] }> {
  const html = await fetchBuiltWithPage(domain);
  if (!html || /human-test|Select both images/i.test(html)) return { hits: [], sources: [] };
  const hits = parseBuiltWithHtml(html);
  return hits.length
    ? { hits, sources: [`https://builtwith.com/${domain}`] }
    : { hits: [], sources: [] };
}

async function fetchBuiltWithPage(domain: string): Promise<string | null> {
  const url = `https://builtwith.com/${domain}`;
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const line = env("OKK_PROXY");
  if (line) {
    const parts = line.split(":");
    if (parts.length >= 4) {
      const [host, port, user, ...rest] = parts;
      const pass = rest.join(":");
      const sid = randomBytes(6).toString("hex");
      const user2 = (user ?? "").replace(/sessid-[A-Za-z0-9]+/i, `sessid-${sid}`);
      try {
        const { stdout } = await execFileAsync(
          "curl",
          ["-sS", "-m", "18", "-L", "--max-redirs", "2", "--compressed", "-A", ua, "-x", `http://${user2}:${pass}@${host}:${port}`, url],
          { maxBuffer: 2_500_000, timeout: 22_000 },
        );
        if (stdout.length > 20_000 && /widget-title/i.test(stdout)) return stdout;
      } catch {
        /* proxy optional */
      }
    }
  }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": ua, Accept: "text/html" },
    });
    const html = await res.text();
    if (html.length > 20_000 && /widget-title/i.test(html)) return html;
  } catch {
    /* */
  }
  return null;
}

async function w3techs(domain: string): Promise<{ hits: TechHit[]; sources: string[] }> {
  const hits: TechHit[] = [];
  const url = `https://w3techs.com/sites/info/${domain}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
    });
    if (!res.ok) return { hits, sources: [] };
    const html = await res.text();
    let cat = "Technology";
    for (const m of html.matchAll(
      /w3techs\.com\/technologies\/(overview|details)\/[^"]+"[^>]*>([^<]{2,48})<\/a>/gi,
    )) {
      const kind = m[1]!.toLowerCase();
      const label = m[2]!.trim();
      if (kind === "overview") {
        cat = label;
        continue;
      }
      if (SKIP_W3.test(cat)) continue;
      if (/^(yes|no|none)$/i.test(label)) continue;
      let category = CAT_MAP[cat.toLowerCase()] ?? cat;
      let name = label.replace(/ CMS$/i, "");
      if (/email server/i.test(cat) && /microsoft/i.test(name)) {
        name = "Microsoft 365";
        category = "Productivity";
      }
      hits.push({ name, category, evidence: "W3Techs", confidence: 88 });
    }
    return { hits, sources: [url] };
  } catch {
    return { hits, sources: [] };
  }
}

async function builtwithDomain(domain: string): Promise<{ hits: TechHit[]; sources: string[] }> {
  const key = process.env.BUILTWITH_API_KEY;
  if (!key) return { hits: [], sources: [] };
  const url = `https://api.builtwith.com/v21/api.json?KEY=${encodeURIComponent(key)}&LOOKUP=${encodeURIComponent(domain)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { hits: [], sources: [] };
    const j = (await res.json()) as {
      Results?: Array<{
        Result?: {
          Paths?: Array<{
            Technologies?: Array<{ Name?: string; Tag?: string; Categories?: string[] }>;
          }>;
        };
      }>;
    };
    const hits: TechHit[] = [];
    for (const path of j.Results?.[0]?.Result?.Paths ?? []) {
      for (const t of path.Technologies ?? []) {
        if (!t.Name) continue;
        hits.push({
          name: t.Name,
          category: t.Categories?.[0] || t.Tag || "Technology",
          evidence: "BuiltWith Domain API",
          confidence: 95,
        });
      }
    }
    return { hits, sources: ["builtwith-domain-api"] };
  } catch {
    return { hits: [], sources: [] };
  }
}

async function liveHeaders(domain: string): Promise<{ hits: TechHit[]; sources: string[] }> {
  const hits: TechHit[] = [];
  const add = (name: string, category: string, evidence: string, confidence: number) => {
    hits.push({ name, category, evidence, confidence });
  };
  try {
    const dns = await import("node:dns/promises");
    const mx = await dns.resolveMx(domain).catch(() => []);
    const mxLine = mx.map((m) => m.exchange).join(" ");
    if (/outlook|protection\.outlook|microsoft/i.test(mxLine)) {
      add("Microsoft 365", "Productivity", "MX Outlook", 92);
    }
  } catch {
    /* dns optional */
  }
  try {
    const res = await fetch(`https://www.${domain}/`, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
    });
    const hdr = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    const html = (await res.text()).slice(0, 80_000);
    if (/x-azure-ref|azurefd\.net/i.test(hdr)) {
      add("Azure", "Cloud Computing Services", "x-azure-ref", 92);
      add("Azure Front Door", "Cloud Computing Services", "x-azure-ref", 90);
    }
    if (/sitecore|SC_ANALYTICS/i.test(hdr))
      add("Sitecore", "Content Management System", "Sitecore cookie/CSP", 95);
    if (/ASP\.NET_SessionId|x-aspnet/i.test(hdr)) {
      add("ASP.NET", "Programming Framework", "session cookie", 92);
      add(".NET", "Programming Framework", "ASP.NET stack", 80);
    }
    if (/snap\.licdn\.com|lintrk\(|px\.ads\.linkedin\.com/i.test(html))
      add("LinkedIn Ads", "Advertising", "LinkedIn Insight tag", 90);
    if (/googletagmanager\.com\/gtm\.js/i.test(html))
      add("Google Tag Manager", "Tag Management", "GTM script", 95);
    const gtmIds = [...html.matchAll(/GTM-[A-Z0-9]+/g)].map((m) => m[0]!);
    const unique = [...new Set(gtmIds)].slice(0, 3);
    await Promise.all(
      unique.map(async (id) => {
        try {
          const gtm = await fetch(`https://www.googletagmanager.com/gtm.js?id=${id}`, {
            signal: AbortSignal.timeout(8000),
            headers: { "User-Agent": "Mozilla/5.0" },
          });
          if (!gtm.ok) return;
          const body = await gtm.text();
          if (/snap\.licdn\.com|lintrk\(|px\.ads\.linkedin\.com|_linkedin_data_partner/i.test(body)) {
            add("LinkedIn Ads", "Advertising", `GTM ${id} LinkedIn pixel`, 92);
          }
          if (/googleads\.g\.doubleclick|gtag\/js\?id=AW-/i.test(body))
            add("Google Ads", "Advertising", `GTM ${id}`, 85);
          if (/connect\.facebook\.net|fbevents\.js/i.test(body))
            add("Facebook Ads", "Advertising", `GTM ${id}`, 85);
        } catch {
          /* gtm optional */
        }
      }),
    );
    return { hits, sources: [res.url] };
  } catch {
    return { hits, sources: [] };
  }
}

async function jobEvidence(
  domain: string,
  extraText: string,
): Promise<{ hits: TechHit[]; sources: string[] }> {
  const brand = domain.split(".")[0] ?? domain;
  const hits: TechHit[] = [];
  let blob = extraText;
  try {
    const { decodoSearch } = await import("./decodo-serp");
    const [rows, rows2] = await Promise.all([
      decodoSearch(`site:${domain} (SAP OR Salesforce OR Kubernetes OR Pardot OR "Azure DevOps")`),
      decodoSearch(
        `"${brand}" ("SAP FICO" OR "SAP ABAP" OR "S/4HANA" OR "SAP consultant" OR "Salesforce Administrator") (hiring OR careers OR jobs)`,
      ),
    ]);
    blob +=
      "\n" +
      [...rows, ...rows2]
        .map((r) => `${r.title ?? ""} ${r.description ?? ""}`)
        .join("\n");
  } catch {
    /* optional */
  }
  const lines = blob.split(/\n+/);
  for (const t of JOB_TECH) {
    const ok = lines.some((line) => {
      if (/SAP OR Salesforce|OR Kubernetes/i.test(line)) return false;
      if (!t.re.test(line)) return false;
      if (t.need && !t.need.test(line)) return false;
      const onSite = new RegExp(domain.replace(/\./g, "\\."), "i").test(line);
      const employer = new RegExp(`\\b${brand}\\b`, "i").test(line);
      if (!onSite && !employer) return false;
      if (/immigration|hair|straightener|wella/i.test(line)) return false;
      return true;
    });
    if (ok) {
      hits.push({
        name: t.name,
        category: t.category,
        evidence: "job / careers mention",
        confidence: 82,
      });
    }
  }
  return { hits, sources: hits.length ? ["jobs-serp"] : [] };
}
