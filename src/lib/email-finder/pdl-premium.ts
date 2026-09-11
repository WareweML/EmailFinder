/**
 * PDL Company Premium–shaped fields from live public sources.
 * Tenure/churn/monthly headcount need a people graph — those stay null
 * unless Wayback LinkedIn snapshots actually parse.
 */

import { resilientFetch } from "./http";

export type PdlAffiliate = {
  id: string | null;
  name: string;
  domain: string | null;
  linkedinId: string | null;
  linkedinUrl: string | null;
  relation: "parent" | "subsidiary" | "affiliate";
};

export type NaicsRow = {
  naicsCode: string;
  sector: string;
  subSector: string;
  industryGroup: string;
  naicsIndustry: string;
  nationalIndustry: string;
};

export type SicRow = {
  sicCode: string;
  majorGroup: string;
  industryGroup: string;
  industrySector: string;
};

export type HqLocation = {
  name: string | null;
  streetAddress: string | null;
  addressLine2: string | null;
  locality: string | null;
  region: string | null;
  metro: string | null;
  postalCode: string | null;
  country: string | null;
  continent: string | null;
  geo: string | null;
};

const UA = { "User-Agent": "Mailgraph/1.0 (contact@warewe.com)" };

/** Census-style revenue per employee (USD) by NAICS 2-digit. */
const RPE: Record<string, number> = {
  "11": 80_000,
  "21": 400_000,
  "22": 350_000,
  "23": 180_000,
  "31": 220_000,
  "32": 220_000,
  "33": 250_000,
  "42": 400_000,
  "44": 180_000,
  "45": 180_000,
  "48": 200_000,
  "49": 180_000,
  "51": 200_000, // information / software
  "52": 350_000,
  "53": 250_000,
  "54": 170_000, // professional / engineering
  "55": 300_000,
  "56": 120_000,
  "61": 90_000,
  "62": 110_000,
  "71": 90_000,
  "72": 70_000,
  "81": 90_000,
};

const NAICS_LABEL: Record<string, NaicsRow> = {
  "519290": {
    naicsCode: "519290",
    sector: "Information",
    subSector: "Other Information Services",
    industryGroup: "Other Information Services",
    naicsIndustry: "Web Search Portals, Libraries, Archives, and Other Information Services",
    nationalIndustry: "Web Search Portals and All Other Information Services",
  },
  "511210": {
    naicsCode: "511210",
    sector: "Information",
    subSector: "Publishing Industries",
    industryGroup: "Software Publishers",
    naicsIndustry: "Software Publishers",
    nationalIndustry: "Software Publishers",
  },
  "541511": {
    naicsCode: "541511",
    sector: "Professional, Scientific, and Technical Services",
    subSector: "Professional, Scientific, and Technical Services",
    industryGroup: "Computer Systems Design and Related Services",
    naicsIndustry: "Custom Computer Programming Services",
    nationalIndustry: "Custom Computer Programming Services",
  },
  "541512": {
    naicsCode: "541512",
    sector: "Professional, Scientific, and Technical Services",
    subSector: "Professional, Scientific, and Technical Services",
    industryGroup: "Computer Systems Design and Related Services",
    naicsIndustry: "Computer Systems Design Services",
    nationalIndustry: "Computer Systems Design Services",
  },
  "541330": {
    naicsCode: "541330",
    sector: "Professional, Scientific, and Technical Services",
    subSector: "Professional, Scientific, and Technical Services",
    industryGroup: "Architectural, Engineering, and Related Services",
    naicsIndustry: "Engineering Services",
    nationalIndustry: "Engineering Services",
  },
  "522320": {
    naicsCode: "522320",
    sector: "Finance and Insurance",
    subSector: "Credit Intermediation and Related Activities",
    industryGroup: "Activities Related to Credit Intermediation",
    naicsIndustry: "Financial Transactions Processing, Reserve, and Clearinghouse Activities",
    nationalIndustry: "Financial Transactions Processing, Reserve, and Clearinghouse Activities",
  },
};

const SIC_LABEL: Record<string, SicRow> = {
  "7372": {
    sicCode: "7372",
    majorGroup: "Business Services",
    industryGroup: "Computer Programming, Data Processing, and Other Computer Related Services",
    industrySector: "Prepackaged Software",
  },
  "7371": {
    sicCode: "7371",
    majorGroup: "Business Services",
    industryGroup: "Computer Programming, Data Processing, and Other Computer Related Services",
    industrySector: "Computer Programming Services",
  },
  "8711": {
    sicCode: "8711",
    majorGroup: "Engineering, Accounting, Research, Management, and Related Services",
    industryGroup: "Engineering, Architectural, and Surveying",
    industrySector: "Engineering Services",
  },
  "7389": {
    sicCode: "7389",
    majorGroup: "Business Services",
    industryGroup: "Miscellaneous Business Services",
    industrySector: "Business Services, Not Elsewhere Classified",
  },
  "6141": {
    sicCode: "6141",
    majorGroup: "Finance, Insurance, and Real Estate",
    industryGroup: "Non-depository Credit Institutions",
    industrySector: "Personal Credit Institutions",
  },
};

const REVENUE_BUCKETS = [
  [1_000_000, "$0-$1M"],
  [10_000_000, "$1M-$10M"],
  [25_000_000, "$10M-$25M"],
  [50_000_000, "$25M-$50M"],
  [100_000_000, "$50M-$100M"],
  [250_000_000, "$100M-$250M"],
  [500_000_000, "$250M-$500M"],
  [1_000_000_000, "$500M-$1B"],
  [10_000_000_000, "$1B-$10B"],
] as const;

export function naicsFor(code: string | null | undefined, industry?: string | null): NaicsRow[] {
  if (code && NAICS_LABEL[code]) return [NAICS_LABEL[code]!];
  const t = (industry ?? "").toLowerCase();
  if (/software|saas|internet|kubernetes|cloud/.test(t)) return [NAICS_LABEL["511210"]!];
  if (/engineer|construction|civil/.test(t)) return [NAICS_LABEL["541330"]!];
  if (/payment|fintech|bank/.test(t)) return [NAICS_LABEL["522320"]!];
  if (code) {
    return [
      {
        naicsCode: code,
        sector: "",
        subSector: "",
        industryGroup: "",
        naicsIndustry: "",
        nationalIndustry: "",
      },
    ];
  }
  return [];
}

export function sicFor(code: string | null | undefined, industry?: string | null): SicRow[] {
  const t = (industry ?? "").toLowerCase();
  if (/software|saas|kubernetes|cloud/.test(t)) return [SIC_LABEL["7372"]!];
  if (/engineer|construction|civil/.test(t)) return [SIC_LABEL["8711"]!];
  if (/payment|fintech/.test(t)) return [SIC_LABEL["6141"]!];
  if (code && SIC_LABEL[code]) return [SIC_LABEL[code]!];
  if (code) {
    return [
      {
        sicCode: code.padStart(4, "0").slice(0, 4),
        majorGroup: "",
        industryGroup: "",
        industrySector: "",
      },
    ];
  }
  return [];
}

export function inferredRevenueRange(employees: number | null, naicsCode?: string | null): string | null {
  if (!employees || employees < 1) return null;
  const two = (naicsCode ?? "51").slice(0, 2);
  const rpe = RPE[two] ?? 150_000;
  const rev = employees * rpe;
  for (const [cap, label] of REVENUE_BUCKETS) {
    if (rev < cap) return label;
  }
  return "$10B+";
}

export function buildHqLocation(opts: {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  postal?: string | null;
  country?: string | null;
  continent?: string | null;
  geo?: string | null;
  addressLine2?: string | null;
}): HqLocation {
  const locality = opts.city ?? null;
  const region = opts.state ?? null;
  const country = opts.country ?? null;
  const name = [locality, region, country].filter(Boolean).join(", ").toLowerCase() || null;
  return {
    name,
    streetAddress: opts.street ?? null,
    addressLine2: opts.addressLine2 ?? null,
    locality,
    region,
    metro: null,
    postalCode: opts.postal ?? null,
    country: country ? country.toLowerCase() : null,
    continent: opts.continent ? opts.continent.toLowerCase() : null,
    geo: opts.geo ?? null,
  };
}

export async function wikiHierarchy(domain: string): Promise<{
  parent?: string;
  subsidiaries: string[];
  ticker?: string;
  mic?: string;
}> {
  const variants = [`https://${domain}/`, `https://www.${domain}/`, `https://${domain}`];
  const values = variants.map((u) => `<${u}>`).join(" ");
  const sparql = `SELECT ?parentLabel ?subLabel ?ticker ?exLabel WHERE {
    VALUES ?site { ${values} }
    ?item wdt:P856 ?site .
    OPTIONAL { ?item wdt:P749 ?parent . }
    OPTIONAL { ?item wdt:P355 ?sub . }
    OPTIONAL { ?item wdt:P249 ?ticker . }
    OPTIONAL { ?item wdt:P414 ?ex . }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  } LIMIT 20`;
  try {
    const res = await fetch(
      "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql),
      { headers: UA, signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return { subsidiaries: [] };
    const j = (await res.json()) as {
      results?: { bindings?: Array<Record<string, { value?: string }>> };
    };
    const rows = j.results?.bindings ?? [];
    const subsidiaries = [
      ...new Set(
        rows
          .map((r) => r.subLabel?.value)
          .filter((x): x is string => Boolean(x && !/^Q\d+$/.test(x))),
      ),
    ];
    const parent = rows.find((r) => r.parentLabel?.value && !/^Q\d+$/.test(r.parentLabel.value))
      ?.parentLabel?.value;
    const ticker = rows.find((r) => r.ticker?.value)?.ticker?.value;
    const mic = rows.find((r) => r.exLabel?.value && !/^Q\d+$/.test(r.exLabel.value))?.exLabel?.value;
    return { parent, subsidiaries, ticker, mic };
  } catch {
    return { subsidiaries: [] };
  }
}

export async function linkedinCompanyId(name: string): Promise<{ id: string; name: string } | null> {
  const q = name.trim();
  if (q.length < 2) return null;
  try {
    const res = await resilientFetch(
      `https://www.linkedin.com/jobs-guest/api/typeaheadHits?typeaheadType=COMPANY&query=${encodeURIComponent(q)}`,
      { timeoutMs: 4000, maxAttempts: 1 },
    );
    if (!res.ok) return null;
    const j = JSON.parse(res.body) as Array<{ id?: string; displayName?: string }>;
    const hit = j.find((x) => x.displayName && new RegExp(`^${q}$`, "i").test(x.displayName)) ?? j[0];
    if (!hit?.id) return null;
    return { id: hit.id, name: hit.displayName ?? q };
  } catch {
    return null;
  }
}

/** Wayback CDX → sparse employee_count_by_month + 12-month growth. */
export async function archiveHeadcount(slug: string): Promise<{
  byMonth: Array<{ month: string; count: number }>;
  growth12: number | null;
}> {
  if (!slug) return { byMonth: [], growth12: null };
  try {
    const url =
      "https://web.archive.org/cdx/search/cdx?" +
      new URLSearchParams({
        url: `linkedin.com/company/${slug}`,
        output: "json",
        fl: "timestamp,original",
        filter: "statuscode:200",
        collapse: "timestamp:6",
        limit: "8",
      });
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { byMonth: [], growth12: null };
    const rows = (await res.json()) as string[][];
    const stamps = rows.slice(1).map((r) => r[0]).filter(Boolean);
    const pick = [stamps[0], stamps[Math.floor(stamps.length / 2)], stamps[stamps.length - 1]].filter(
      (x, i, a): x is string => Boolean(x) && a.indexOf(x) === i,
    );
    const byMonth: Array<{ month: string; count: number }> = [];
    await Promise.all(
      pick.map(async (ts) => {
        try {
          const snap = await fetch(`https://web.archive.org/web/${ts}/https://www.linkedin.com/company/${slug}/`, {
            headers: UA,
            signal: AbortSignal.timeout(5000),
          });
          if (!snap.ok) return;
          const html = await snap.text();
          const emp = html.match(/([\d,]+)\+?\s*employees/i)?.[1]?.replace(/,/g, "");
          const n = emp ? Number(emp) : NaN;
          if (!Number.isFinite(n) || n < 1) return;
          byMonth.push({ month: `${ts.slice(0, 4)}-${ts.slice(4, 6)}`, count: n });
        } catch {
          /* skip snapshot */
        }
      }),
    );
    byMonth.sort((a, b) => a.month.localeCompare(b.month));
    let growth12: number | null = null;
    if (byMonth.length >= 2) {
      const first = byMonth[0]!;
      const last = byMonth[byMonth.length - 1]!;
      if (first.count > 0) growth12 = Math.round(((last.count - first.count) / first.count) * 1000) / 10;
    }
    return { byMonth, growth12 };
  } catch {
    return { byMonth: [], growth12: null };
  }
}

export function affiliatesFromSocial(opts: {
  selfSlug?: string | null;
  parentName?: string | null;
  parentDomain?: string | null;
  parentLiId?: string | null;
  linkedinHandles: Array<{ handle?: string; url: string }>;
  subsidiaries: string[];
}): PdlAffiliate[] {
  const out: PdlAffiliate[] = [];
  const self = (opts.selfSlug ?? "").replace(/^company\//, "").toLowerCase();
  if (opts.parentName) {
    out.push({
      id: opts.parentLiId ?? null,
      name: opts.parentName,
      domain: opts.parentDomain ?? null,
      linkedinId: opts.parentLiId ?? null,
      linkedinUrl: opts.parentLiId
        ? `https://www.linkedin.com/company/${opts.parentLiId}`
        : null,
      relation: "parent",
    });
  }
  for (const s of opts.linkedinHandles) {
    const slug = (s.handle ?? s.url).replace(/^.*company\//, "").replace(/\/.*$/, "").toLowerCase();
    if (!slug || slug === self || /^\d+$/.test(slug)) continue;
    if (out.some((a) => a.name.toLowerCase() === slug)) continue;
    const pretty = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    if (opts.parentName && pretty.toLowerCase() === opts.parentName.toLowerCase()) {
      const p = out.find((a) => a.relation === "parent");
      if (p && !p.linkedinUrl) {
        p.linkedinUrl = s.url;
        p.id = slug;
      }
      continue;
    }
    out.push({
      id: slug,
      name: pretty,
      domain: null,
      linkedinId: null,
      linkedinUrl: s.url,
      relation: "affiliate",
    });
  }
  for (const name of opts.subsidiaries) {
    if (out.some((a) => a.name.toLowerCase() === name.toLowerCase())) continue;
    out.push({
      id: null,
      name,
      domain: null,
      linkedinId: null,
      linkedinUrl: null,
      relation: "subsidiary",
    });
  }
  return out;
}
