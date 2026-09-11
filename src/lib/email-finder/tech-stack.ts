/**
 * Fast tech fingerprint:
 *   1. W3Techs named stack (open, ~1s)
 *   2. Live headers + MX
 *   3. Job/careers evidence for backend tools Hunter shows via BuiltWith
 *   4. BuiltWith Domain API if BUILTWITH_API_KEY is set
 */

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

export const JOB_TECH: Array<{ name: string; category: string; re: RegExp }> = [
  { name: "SAP", category: "Accounting & Finance", re: /\bSAP\b/ },
  { name: "Salesforce", category: "CRM", re: /\bSalesforce\b/ },
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
    const key = name.replace(/\s+CMS$/i, "").trim();
    if (!key || seen.has(key.toLowerCase())) return;
    seen.add(key.toLowerCase());
    technologies.push({ name: key, category, evidence, confidence });
  };

  const [w3, bw, live, jobs] = await Promise.all([
    w3techs(domain),
    builtwithDomain(domain),
    liveHeaders(domain),
    jobEvidence(domain, extraText),
  ]);
  sources.push(...w3.sources, ...bw.sources, ...live.sources, ...jobs.sources);
  for (const t of [...bw.hits, ...w3.hits, ...live.hits, ...jobs.hits]) {
    add(t.name, t.category, t.evidence, t.confidence);
  }
  if (extraText) {
    for (const r of JOB_TECH) {
      if (r.re.test(extraText)) add(r.name, r.category, "jobs / company copy", 70);
    }
  }
  technologies.sort((a, b) => b.confidence - a.confidence);
  return { domain, technologies, durationMs: Date.now() - t0, sources };
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
      add("Microsoft Excel", "Productivity", "Microsoft 365 suite", 70);
      add("Microsoft Office", "Productivity", "Microsoft 365 suite", 70);
      add("Microsoft Word", "Productivity", "Microsoft 365 suite", 68);
      add("Microsoft PowerPoint", "Productivity", "Microsoft 365 suite", 68);
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
    if (/strict-transport-security/i.test(hdr)) add("HSTS", "Security", "HSTS header", 95);
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
      decodoSearch(
        `"${brand}" (SAP OR Salesforce OR Kubernetes OR "Azure DevOps" OR Pardot OR PySpark OR "GitHub Actions" OR Python) (engineer OR developer OR "job description" OR careers) -hair -straightener -immigration`,
      ),
      decodoSearch(
        `"${brand}" (Salesforce OR SAP) (Administrator OR Developer OR Engineer) -immigration -hair`,
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
      if (!t.re.test(line)) return false;
      if (!new RegExp(`\\b${brand}\\b`, "i").test(line)) return false;
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
