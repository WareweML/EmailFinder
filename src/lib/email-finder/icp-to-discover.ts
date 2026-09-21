/**
 * Turn an ICP / SparkToro report into LinkedIn Discover filters.
 * IDs are the same COMPANY_SIZES / INDUSTRIES / GEO_COUNTRIES the Discover UI uses.
 */

import {
  COMPANY_SIZES,
  COMPANY_TYPES,
  GEO_COUNTRIES,
  INDUSTRIES,
  LINKEDIN_FUNCTIONS,
  YEARS_EXPERIENCE,
} from "./linkedin-facets";
import type { AffinityRow, IcpReport } from "./icp-find";

export type DiscoverFilterState = {
  keywords: string;
  firstName: string;
  lastName: string;
  title: string;
  pastTitle: string;
  skills: string;
  school: string;
  language: string;
  yearsExp: string;
  tenure: string;
  companyName: string;
  companyId: string;
  pastCompanyName: string;
  pastCompanyId: string;
  companyKeywords: string;
  domain: string;
  geoId: string;
  hqGeoId: string;
  industryId: string;
  sizeId: string;
  companyType: string;
  revenueBand: string;
  growthBand: string;
  hiringOnly: boolean;
};

export type IcpDiscoverQuery = {
  kind: "people" | "companies";
  autoSearch: boolean;
  source: string;
  rationale: Record<string, string>;
  filters: DiscoverFilterState;
};

const emptyFilters = (): DiscoverFilterState => ({
  keywords: "",
  firstName: "",
  lastName: "",
  title: "",
  pastTitle: "",
  skills: "",
  school: "",
  language: "",
  yearsExp: "",
  tenure: "",
  companyName: "",
  companyId: "",
  pastCompanyName: "",
  pastCompanyId: "",
  companyKeywords: "",
  domain: "",
  geoId: "",
  hqGeoId: "",
  industryId: "",
  sizeId: "",
  companyType: "",
  revenueBand: "",
  growthBand: "",
  hiringOnly: false,
});

function compact(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function topNames(rows: AffinityRow[] | undefined, n = 5): string[] {
  return (rows ?? [])
    .map((r) => r.name.trim())
    .filter((s) => s.length > 1 && s.length < 80)
    .slice(0, n);
}

const INDUSTRY_HINTS: Array<[RegExp, string]> = [
  [/e-?learn|edtech|education|school|university|higher.?ed/, "52"],
  [/computer software|saas|kubernet|k8s|application software/, "4"],
  [/internet software|internet services|information technology|\bit services\b/, "96"],
  [/\binternet\b/, "8"],
  [/financial|fintech|lend(ing)?|credit|bank/, "43"],
  [/hospitality|hotel|lodging|travel/, "28"],
  [/health|pharma|medtech|\bcare\b|\bhospital\b/, "14"],
  [/market(ing)?|advertis|demand.?gen/, "24"],
  [/real estate|property/, "31"],
  [/consult/, "11"],
  [/staffing|recruit/, "34"],
  [/legal|law/, "53"],
  [/manufactur/, "116"],
  [/construct/, "48"],
  [/engineer/, "3249"],
];

export function matchIndustry(raw: string): (typeof INDUSTRIES)[number] | null {
  const blob = compact(raw);
  if (!blob) return null;
  for (const [re, id] of INDUSTRY_HINTS) {
    if (re.test(blob)) return INDUSTRIES.find((i) => i.id === id) ?? null;
  }
  const hit = INDUSTRIES.find((i) => {
    const lab = compact(i.label);
    return blob.includes(lab) || lab.includes(blob) || blob.split(" ").some((w) => w.length > 4 && lab.includes(w));
  });
  return hit ?? null;
}

export function matchGeo(raw: string): (typeof GEO_COUNTRIES)[number] | null {
  const blob = compact(raw);
  if (!blob) return null;
  const aliases: Array<[RegExp, string]> = [
    [/\bunited states\b|\busa\b|\bu s\b|\bamerica\b|\bus\b/, "103644278"],
    [/\bunited kingdom\b|\bengland\b|\blondon\b|\buk\b/, "101165590"],
    [/\bcanada\b|\bontario\b|\btoronto\b|\bvancouver\b/, "101174742"],
    [/\baustralia\b|\bsydney\b|\bmelbourne\b/, "101452733"],
    [/\bindia\b|\bdelhi\b|\bbangalore\b|\bmumbai\b/, "102713980"],
    [/\bgermany\b/, "101282230"],
    [/\bfrance\b/, "105015875"],
    [/\bsingapore\b/, "102454443"],
    [/\buae\b|\bdubai\b/, "104305776"],
    [/\bnetherlands\b/, "102890719"],
  ];
  for (const [re, id] of aliases) {
    if (re.test(blob)) return GEO_COUNTRIES.find((g) => g.id === id) ?? null;
  }
  return GEO_COUNTRIES.find((g) => blob.includes(compact(g.label))) ?? null;
}

export function matchSize(raw: string): (typeof COMPANY_SIZES)[number] | null {
  const n = Number((raw.match(/(\d[\d,]*)/) || [])[1]?.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) {
    const blob = compact(raw);
    return COMPANY_SIZES.find((s) => blob.includes(s.label.replace(/[^\d]+/g, " ").trim())) ?? null;
  }
  if (n <= 10) return COMPANY_SIZES[0];
  if (n <= 50) return COMPANY_SIZES[1];
  if (n <= 200) return COMPANY_SIZES[2];
  if (n <= 500) return COMPANY_SIZES[3];
  if (n <= 1000) return COMPANY_SIZES[4];
  if (n <= 5000) return COMPANY_SIZES[5];
  if (n <= 10000) return COMPANY_SIZES[6];
  return COMPANY_SIZES[7];
}

function isJobTitle(s: string) {
  return /\b(head|chief|director|vp|vice president|manager|lead|founder|owner|principal|officer|cmo|ceo|cto|cfo|cro|growth|marketing|sales|revenue|demand)\b/i.test(
    s,
  );
}

function yearsFromSeniority(raw: string): (typeof YEARS_EXPERIENCE)[number] | null {
  const b = compact(raw);
  if (/\b(chief|c-suite|vp|vice president|head|founder|owner|president)\b/.test(b)) return YEARS_EXPERIENCE[4];
  if (/\b(director|principal|partner)\b/.test(b)) return YEARS_EXPERIENCE[3];
  if (/\b(senior|manager|lead)\b/.test(b)) return YEARS_EXPERIENCE[2];
  if (/\b(mid|specialist|associate)\b/.test(b)) return YEARS_EXPERIENCE[1];
  if (/\b(junior|intern|entry)\b/.test(b)) return YEARS_EXPERIENCE[0];
  return null;
}

function functionKeyword(report: IcpReport): string {
  const fromFn = topNames(report.demographics.functions, 3).find((n) =>
    LINKEDIN_FUNCTIONS.some((f) => compact(f) === compact(n) || compact(n).includes(compact(f))),
  );
  if (fromFn) return fromFn;
  const fromTitle = [...topNames(report.demographics.titles, 8), ...report.buyers.map((b) => b.title || b.role || "")]
    .join(" ")
    .toLowerCase();
  const hit = LINKEDIN_FUNCTIONS.find((f) => fromTitle.includes(f.toLowerCase()));
  return hit || "";
}

export function icpToDiscover(report: IcpReport, kind: "people" | "companies"): IcpDiscoverQuery {
  const rationale: Record<string, string> = {};
  const filters = emptyFilters();

  const buyerTitles = report.buyers
    .map((b) => (b.title || "").replace(/\s*\(role inbox\)/i, "").trim())
    .filter((t) => t.length > 2);
  const demoTitles = topNames(report.demographics.titles, 8).filter(isJobTitle);
  const audienceTitles = topNames(report.demographics.audienceTitles, 8).filter(isJobTitle);
  const titles = [...new Set([...buyerTitles.filter(isJobTitle), ...demoTitles, ...audienceTitles])];
  const specific = titles.filter((t) => t.split(/\s+/).length >= 2 && !/^(marketing|sales|software)$/i.test(t));
  const bestTitle = specific.sort((a, b) => b.length - a.length)[0] || titles.find((t) => t.split(/\s+/).length >= 2) || "";
  if (bestTitle) {
    filters.title = bestTitle;
    rationale.title = `Paying / SparkToro title: ${bestTitle}`;
  }

  const fn = functionKeyword(report);
  const extraTitles = titles.filter((t) => compact(t) !== compact(bestTitle)).slice(0, 3);
  if (kind === "people") {
    const seen = new Set<string>();
    const kwParts = [...(fn ? [fn] : []), ...extraTitles].filter((t) => {
      const k = compact(t);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return compact(t) !== compact(bestTitle);
    });
    filters.keywords = kwParts.join(" OR ");
    if (filters.keywords) rationale.keywords = `Function + sibling titles from ICP`;
  } else {
    const intent = topNames(report.keywords, 6)
      .filter((k) => !/http|www\./i.test(k))
      .slice(0, 4);
    filters.keywords = intent.join(" OR ");
    if (filters.keywords) rationale.keywords = `SparkToro search terms this audience types`;
  }

  const industryText =
    topNames(report.demographics.industries, 5).join(" ") ||
    report.buyers.map((b) => b.industry || "").join(" ");
  const industry = matchIndustry(industryText);
  if (industry) {
    filters.industryId = industry.id;
    rationale.industryId = `${industry.label} ← ${industryText.split(/[,/]/)[0]}`;
  }

  const locBlob = [
    ...topNames(report.demographics.locations, 6),
    ...report.buyers.map((b) => b.location || ""),
    report.tam?.rationale || "",
  ].join(" ");
  const geo = matchGeo(locBlob) || matchGeo(report.company.brief) || matchGeo(report.sparkToro?.prompt || "");
  if (geo) {
    filters.geoId = geo.id;
    filters.hqGeoId = geo.id;
    rationale.geoId = `Person + HQ: ${geo.label}`;
    rationale.hqGeoId = geo.label;
  }

  const buyerSizeHits = report.buyers.map((b) => matchSize(b.size || "")).filter((s): s is NonNullable<typeof s> => Boolean(s));
  const sizeText = topNames(report.demographics.sizes, 5).join(" ") || report.buyers.map((b) => b.size || "").join(" ");
  let size = buyerSizeHits[0] || matchSize(sizeText);
  if (size?.id === "B" && (report.tam?.estimated_population ?? 0) > 2000) {
    size = COMPANY_SIZES[2];
  }
  if (size) {
    filters.sizeId = size.id;
    rationale.sizeId = `${size.label} employees`;
  }

  const years =
    yearsFromSeniority(topNames(report.demographics.seniority, 3).join(" ")) ||
    yearsFromSeniority(bestTitle) ||
    yearsFromSeniority(fn);
  if (years) {
    filters.yearsExp = years.id;
    rationale.yearsExp = years.label;
  }

  const skillish = topNames(report.bioPhrases, 12).filter((s) => {
    const c = compact(s);
    return c.length >= 3 && c.length <= 28 && !/http|www|podcast|youtube/.test(c);
  });
  filters.skills = skillish.slice(0, 4).join(", ");
  if (filters.skills) rationale.skills = `Bio phrases this audience uses`;

  if (kind === "people") {
    const coKw = [
      industry?.label,
      ...topNames(report.demographics.industries, 3),
    ]
      .filter(Boolean)
      .map((s) => String(s).split(/[,/]/)[0]!.trim())
      .filter((s, i, a) => s.length > 2 && a.indexOf(s) === i)
      .slice(0, 4)
      .join(" OR ");
    filters.companyKeywords = coKw;
    if (coKw) rationale.companyKeywords = `Industries of logos that paid`;
  } else {
    const logos = report.lookalikes.map((l) => l.name).filter(Boolean).slice(0, 5);
    filters.companyKeywords = logos.join(" OR ");
    if (filters.companyKeywords) rationale.companyKeywords = `Lookalikes of paying logos`;
  }

  if (geo && ["103644278", "101165590", "101452733", "101174742", "102713980"].includes(geo.id)) {
    filters.language = "en";
    rationale.language = "English (geo)";
  }

  if (kind === "companies" && report.tam?.year_over_year_growth_pct != null) {
    const g = report.tam.year_over_year_growth_pct;
    filters.growthBand = g < 0 ? "declining" : g < 10 ? "0to10" : g < 25 ? "10to25" : "25plus";
    rationale.growthBand = `SparkToro TAM YoY ${g}%`;
  }

  filters.companyType = "Privately Held";
  rationale.companyType = "Default private — ICP logos are private SaaS";

  return {
    kind,
    autoSearch: true,
    source: report.sparkToro?.reportId ? `icp:${report.sparkToro.reportId}` : `icp:${report.company.domain}`,
    rationale,
    filters,
  };
}

export type CompanyIcpSeed = {
  name: string;
  domain: string;
  industry?: string | null;
  description?: string | null;
  hq?: string | null;
  country?: string | null;
  size?: string | null;
  staffCount?: number | null;
  tags?: string[];
  titles?: string[];
  companyType?: string | null;
};

const STOP_KW =
  /^(the|and|with|for|our|from|that|this|their|your|are|was|not|all|into|over|also|have|been|made|will|just|company|group|pvt|ltd|llc|inc|limited)$/i;

function nicheKeywords(seed: CompanyIcpSeed): string[] {
  const blob = `${seed.description ?? ""} ${(seed.tags ?? []).join(" ")} ${seed.industry ?? ""}`;
  const words = blob
    .toLowerCase()
    .replace(/[^a-z0-9+ ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !STOP_KW.test(w));
  const preferred = [
    "loyalty",
    "membership",
    "subscription",
    "hospitality",
    "engagement",
    "monetisation",
    "monetization",
    "kubernetes",
    "finops",
    "dental",
    "realestate",
  ].filter((w) => blob.toLowerCase().includes(w));
  const out = [...preferred];
  for (const w of words) {
    if (out.length >= 6) break;
    if (!out.includes(w) && w !== compact(seed.domain.split(".")[0] ?? "")) out.push(w);
  }
  return [...new Set(out)].slice(0, 6);
}

export function companyToDiscover(seed: CompanyIcpSeed, kind: "people" | "companies" = "companies"): IcpDiscoverQuery {
  const rationale: Record<string, string> = {};
  const filters = emptyFilters();
  const desc = seed.description ?? "";
  const tech =
    /software|digital|saas|data |loyalty|subscription|tech|cloud|ai /i.test(desc) ||
    /software|internet|information technology|it services/i.test(seed.industry ?? "");
  const industry =
    (tech ? matchIndustry("computer software") : null) ||
    matchIndustry(`${seed.industry ?? ""} ${desc}`) ||
    matchIndustry(seed.industry ?? "");
  if (industry) {
    filters.industryId = industry.id;
    rationale.industryId = `${industry.label} ← ${seed.industry || "company copy"}`;
  }
  const geo = matchGeo(`${seed.hq ?? ""} ${seed.country ?? ""}`);
  if (geo) {
    filters.hqGeoId = geo.id;
    if (kind === "people") filters.geoId = geo.id;
    rationale.hqGeoId = geo.label;
    if (kind === "people") rationale.geoId = geo.label;
  }
  const size = matchSize(String(seed.staffCount || seed.size || ""));
  if (size) {
    filters.sizeId = size.id;
    rationale.sizeId = `${size.label} employees`;
  }
  const kws = nicheKeywords(seed);
  filters.companyKeywords = kws.join(" OR ");
  if (filters.companyKeywords) rationale.companyKeywords = `From ${seed.name} copy, not the brand name`;
  const dmTitle = (seed.titles ?? []).filter(isJobTitle).sort((a, b) => b.length - a.length)[0];
  if (kind === "people" && dmTitle) {
    filters.title = dmTitle;
    rationale.title = `Decision-maker title at ${seed.name}`;
  }
  if (seed.companyType && COMPANY_TYPES.some((t) => t.id === seed.companyType)) {
    filters.companyType = seed.companyType;
    rationale.companyType = seed.companyType;
  } else {
    filters.companyType = "Privately Held";
    rationale.companyType = "Default private";
  }
  if (geo && ["103644278", "101165590", "101452733", "101174742", "102713980"].includes(geo.id)) {
    filters.language = "en";
    rationale.language = "English (geo)";
  }
  return {
    kind,
    autoSearch: true,
    source: `company:${seed.domain}`,
    rationale,
    filters,
  };
}

export function companyIcpLines(seed: CompanyIcpSeed): Array<{ k: string; v: string }> {
  const q = companyToDiscover(seed, "companies");
  const industry = INDUSTRIES.find((i) => i.id === q.filters.industryId);
  const geo = GEO_COUNTRIES.find((g) => g.id === q.filters.hqGeoId);
  const size = COMPANY_SIZES.find((s) => s.id === q.filters.sizeId);
  const lines: Array<{ k: string; v: string }> = [];
  if (industry) lines.push({ k: "Industry", v: industry.label });
  if (geo) lines.push({ k: "HQ", v: geo.label });
  if (size) lines.push({ k: "Size", v: `${size.label} employees` });
  if (q.filters.companyKeywords) lines.push({ k: "Keywords", v: q.filters.companyKeywords.replace(/ OR /g, " · ") });
  if (q.filters.companyType) lines.push({ k: "Type", v: q.filters.companyType });
  return lines;
}
