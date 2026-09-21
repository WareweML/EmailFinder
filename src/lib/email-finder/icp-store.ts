import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IcpBuyer, IcpReport } from "./icp-find";
import { sparkToroFullReport, stToAffinity } from "./sparktoro";

const DIR = join(process.cwd(), "data", "icp-reports");
const LAST = join(DIR, "last.json");

function ensureDir() {
  mkdirSync(DIR, { recursive: true });
}

export function saveIcpReport(report: IcpReport) {
  try {
    ensureDir();
    writeFileSync(LAST, JSON.stringify(report));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `${(report.company.domain || "report").replace(/[^\w.-]/g, "_")}-${stamp}.json`;
    writeFileSync(join(DIR, name), JSON.stringify(report));
  } catch {
    /* */
  }
}

export function loadLastIcp(): IcpReport | null {
  try {
    if (!existsSync(LAST)) return null;
    return JSON.parse(readFileSync(LAST, "utf8")) as IcpReport;
  } catch {
    return null;
  }
}

const DEFAULT_BUYERS: IcpBuyer[] = [
  { email: "ayrton@curaeducation.com", name: "Ayrton", title: null, role: null, seniority: null, company: "Cura Education", domain: "curaeducation.com", industry: "E-Learning", size: null, location: null, linkedin: null, twitter: null, acv: 120000, sharePct: 43.3, sources: ["customer-list"] },
  { email: "baki@lookfor.ai", name: "Baki", title: null, role: null, seniority: null, company: "lookfor", domain: "lookfor.ai", industry: "Internet Software", size: null, location: null, linkedin: null, twitter: null, acv: 80000, sharePct: 28.9, sources: ["customer-list"] },
  { email: "marketing@kubex.ai", name: null, title: null, role: "marketing", seniority: null, company: "Kubex", domain: "kubex.ai", industry: "Internet Software", size: null, location: null, linkedin: null, twitter: null, acv: 40000, sharePct: 14.4, sources: ["customer-list"] },
  { email: "ray@lendpilot.com", name: "Ray", title: null, role: null, seniority: null, company: "LendPilot", domain: "lendpilot.com", industry: "Financial Services", size: null, location: null, linkedin: null, twitter: null, acv: 25000, sharePct: 9.0, sources: ["customer-list"] },
  { email: "chris@qualityhealth.io", name: "Chris", title: null, role: null, seniority: null, company: "QualityHealth", domain: "qualityhealth.io", industry: "Health", size: null, location: null, linkedin: null, twitter: null, acv: 12000, sharePct: 4.3, sources: ["customer-list"] },
];

export async function restorePaidSparkToroReport(): Promise<IcpReport> {
  const existing = loadLastIcp();
  if (
    existing?.sparkToro?.reportId &&
    existing.websites.length &&
    existing.demographics.locations.length &&
    existing.demographics.audienceTitles.length
  ) {
    return existing;
  }

  const st = await sparkToroFullReport(
    "Marketing working in E-Learning Providers, Internet Software & Services, Financial Services at companies such as Cura Education, lookfor, Kubex, LendPilot, QualityHealth who buy Email Verification, Find Emails, Search Leads SaaS Tool.",
    "us",
    {
      audienceKey: DEFAULT_BUYERS.map((b) => b.email).join(","),
      domains: DEFAULT_BUYERS.map((b) => b.domain),
      allowCreate: false,
    },
  );

  const report: IcpReport = {
    company: {
      domain: "emailverifier.io",
      name: "emailverifier.io",
      brief: "Email Verification, Find Emails, Search Leads SaaS Tool",
      products: [],
    },
    spend: { totalAcv: 277000, weightedCustomers: DEFAULT_BUYERS.length },
    buyers: DEFAULT_BUYERS,
    demographics: {
      titles: [],
      seniority: [],
      industries: stToAffinity(st.demographics.industry ?? [], "sparktoro", "industry"),
      sizes: stToAffinity(st.demographics.company_employee_count ?? [], "sparktoro", "size"),
      locations: stToAffinity(
        [...(st.demographics.country ?? []), ...(st.demographics.state ?? [])],
        "sparktoro",
        "location",
      ),
      functions: [],
      age: stToAffinity(st.demographics.age ?? [], "sparktoro", "age"),
      gender: stToAffinity(st.demographics.gender ?? [], "sparktoro", "gender"),
      salary: stToAffinity(st.demographics.salary ?? [], "sparktoro", "salary"),
      audienceTitles: stToAffinity(st.demographics.title_role ?? [], "sparktoro", "title"),
    },
    social: stToAffinity(st.social, "sparktoro", "social"),
    websites: stToAffinity(st.websites, "sparktoro", "site"),
    youtube: stToAffinity(st.youtube, "sparktoro", "youtube"),
    podcasts: stToAffinity(st.podcasts, "sparktoro", "podcast"),
    reddit: stToAffinity(st.reddit, "sparktoro", "subreddit"),
    keywords: stToAffinity(st.keywords, "sparktoro", "keyword"),
    apps: stToAffinity(st.apps, "sparktoro", "app"),
    bioPhrases: stToAffinity(st.bios, "sparktoro", "bio"),
    lookalikes: DEFAULT_BUYERS.map((b) => ({
      name: b.company || b.domain,
      kind: "lookalike",
      pct: b.sharePct,
      affinity: Math.round(b.sharePct),
      evidence: b.email || b.domain,
      source: "paying-logo",
    })),
    press: stToAffinity(st.press, "sparktoro", "press"),
    networks: stToAffinity(st.networks, "sparktoro", "network"),
    prompts: stToAffinity(st.prompts, "sparktoro", "prompt"),
    tam: st.tam,
    sparkToro: st.reportId ? { reportId: st.reportId, prompt: st.prompt, creditsRemaining: st.creditsRemaining } : null,
    segments: DEFAULT_BUYERS.map((b) => ({
      name: [b.company, b.industry].filter(Boolean).join(" · "),
      shareOfRevenue: b.sharePct,
      who: [b.name, b.email].filter(Boolean).join(" · "),
      whereToShowUp: st.websites.slice(0, 2).map((w) => w.name),
      evidence: [`ACV ${b.sharePct}%`, b.industry || ""],
    })),
    takeAction: [
      st.tam?.estimated_population ? `TAM ${st.tam.estimated_population.toLocaleString()} people (SparkToro ${st.reportId}, 0 new credits).` : "",
      st.websites[0] ? `Sites: ${st.websites.slice(0, 5).map((w) => w.name).join(", ")}` : "",
      st.podcasts[0] ? `Podcasts: ${st.podcasts.slice(0, 3).map((w) => w.name).join(", ")}` : "",
      st.keywords[0] ? `Keywords: ${st.keywords.slice(0, 5).map((w) => w.name).join(", ")}` : "",
    ].filter(Boolean),
    sources: st.sources,
    durationMs: 0,
  };
  saveIcpReport(report);
  return report;
}
