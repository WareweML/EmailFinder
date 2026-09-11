/**
 * Revenue, headcount growth, hiring — public sources, not PDL.
 * SEC (US public) → Wikipedia infobox → Growjo (validated vs LinkedIn count).
 */

export type CompanySignals = {
  headcount?: number;
  headcountSource?: string;
  publishedHeadcount?: number;
  headcountGrowthPct?: number;
  growthSource?: string;
  revenueUsd?: number;
  revenueLabel?: string;
  revenueSource?: string;
  jobsOpen?: number;
  sources: string[];
};

function parseMoney(raw: string): { usd: number; label: string } | null {
  const t = raw.replace(/\[\[.*?\|/g, "").replace(/[\[\]']/g, " ");
  const m = t.match(/\$?\s*([\d.,]+)\s*(billion|million|trillion|bn|m|b|k)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || "").toLowerCase();
  const mul =
    unit === "trillion"
      ? 1e12
      : unit === "billion" || unit === "bn" || unit === "b"
        ? 1e9
        : unit === "million" || unit === "m"
          ? 1e6
          : unit === "k"
            ? 1e3
            : n >= 1e6
              ? 1
              : 1e6;
  const usd = n * mul;
  const label =
    usd >= 1e9 ? `$${(usd / 1e9).toFixed(1)}B` : usd >= 1e6 ? `$${(usd / 1e6).toFixed(0)}M` : `$${usd.toFixed(0)}`;
  return { usd, label };
}

async function wikiSignals(name: string): Promise<Partial<CompanySignals>> {
  try {
    const search = await fetch(
      "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=" +
        encodeURIComponent(`${name} company`),
      {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mailgraph/1.0 (signals)" },
      },
    );
    if (!search.ok) return {};
    const sj = (await search.json()) as {
      query?: { search?: Array<{ title: string }> };
    };
    const title = sj.query?.search?.[0]?.title;
    if (!title) return {};
    const parse = await fetch(
      "https://en.wikipedia.org/w/api.php?action=parse&prop=wikitext&format=json&section=0&page=" +
        encodeURIComponent(title),
      {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mailgraph/1.0 (signals)" },
      },
    );
    if (!parse.ok) return {};
    const pj = (await parse.json()) as { parse?: { wikitext?: { "*": string } } };
    const wt = pj.parse?.wikitext?.["*"] ?? "";
    const out: Partial<CompanySignals> = { sources: ["wikipedia"] };
    const rev = wt.match(/\|\s*revenue\s*=\s*([^\n]+)/i);
    if (rev) {
      const money = parseMoney(rev[1]!);
      if (money) {
        out.revenueUsd = money.usd;
        out.revenueLabel = money.label;
        out.revenueSource = "Wikipedia";
      }
    }
    const emp = wt.match(/\|\s*num_employees\s*=\s*([\d,]+)/i);
    if (emp) {
      out.publishedHeadcount = parseInt(emp[1]!.replace(/,/g, ""), 10);
      out.headcountSource = "Wikipedia";
    }
    return out;
  } catch {
    return {};
  }
}

async function growjoSignals(name: string, liveHeadcount?: number): Promise<Partial<CompanySignals>> {
  const slug = name.trim().replace(/\s+/g, "_").replace(/[^\w]/g, "");
  if (!slug) return {};
  try {
    const res = await fetch(`https://growjo.com/company/${encodeURIComponent(slug)}`, {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) return {};
    const html = await res.text();
    const desc = html.match(/name="description" content="([^"]+)"/i)?.[1] ?? "";
    const emp = Number(desc.match(/([\d,]+)\s+employees/i)?.[1]?.replace(/,/g, ""));
    if (liveHeadcount && emp && Math.min(emp, liveHeadcount) / Math.max(emp, liveHeadcount) < 0.3) {
      return {};
    }
    const out: Partial<CompanySignals> = { sources: ["growjo"] };
    const money = desc.match(/revenue of (\$[\d.,]+\s*[MBK])/i);
    if (money) {
      const p = parseMoney(money[1]!);
      if (p) {
        out.revenueUsd = p.usd;
        out.revenueLabel = p.label;
        out.revenueSource = "Growjo";
      }
    }
    const grew = html.match(/grew their employee count by\s*(?:<!-- -->)?\s*([\d.]+)%/i);
    if (grew) {
      out.headcountGrowthPct = parseFloat(grew[1]!);
      out.growthSource = "Growjo";
    }
    if (emp) out.publishedHeadcount = emp;
    return out;
  } catch {
    return {};
  }
}

let tickerCache: Array<{ ticker: string; title: string; cik: string }> | null = null;

async function loadTickers() {
  if (tickerCache) return tickerCache;
  const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
    signal: AbortSignal.timeout(10000),
    headers: { "User-Agent": "Warewe Mailgraph contact@warewe.com" },
  });
  if (!res.ok) return [];
  const j = (await res.json()) as Record<string, { ticker: string; title: string; cik_str: number }>;
  tickerCache = Object.values(j).map((v) => ({
    ticker: v.ticker,
    title: v.title,
    cik: String(v.cik_str).padStart(10, "0"),
  }));
  return tickerCache;
}

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function secRevenue(name: string): Promise<Partial<CompanySignals>> {
  try {
    const tickers = await loadTickers();
    const n = norm(name);
    const hit =
      tickers.find((t) => norm(t.title) === n) ||
      tickers.find((t) => norm(t.title).startsWith(n + " ")) ||
      tickers.find((t) => n.startsWith(norm(t.title))) ||
      tickers.find((t) => norm(t.title).includes(n) && n.length > 4);
    if (!hit) return {};
    const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${hit.cik}.json`, {
      signal: AbortSignal.timeout(12000),
      headers: { "User-Agent": "Warewe Mailgraph contact@warewe.com" },
    });
    if (!res.ok) return {};
    const cf = (await res.json()) as {
      facts?: { "us-gaap"?: Record<string, { units?: { USD?: Array<{ val: number; fy?: number; fp?: string; form?: string }> } }> };
    };
    const gaap = cf.facts?.["us-gaap"] ?? {};
    const keys = [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
      "SalesRevenueNet",
    ];
    for (const k of keys) {
      const usd = gaap[k]?.units?.USD;
      if (!usd?.length) continue;
      const annual = [...usd].reverse().find((x) => x.form === "10-K" || x.fp === "FY") ?? usd[usd.length - 1]!;
      const money = parseMoney(String(annual.val));
      if (!money) continue;
      return {
        revenueUsd: annual.val,
        revenueLabel: money.label,
        revenueSource: `SEC ${hit.ticker}`,
        sources: ["sec"],
      };
    }
  } catch {
    /* none */
  }
  return {};
}

async function jobsOpen(companyId?: string): Promise<number | undefined> {
  if (!companyId || !/^\d+$/.test(companyId)) return undefined;
  try {
    const res = await fetch(
      `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?f_C=${companyId}&start=0`,
      { signal: AbortSignal.timeout(6000), headers: { "User-Agent": "Mozilla/5.0 Chrome/131" } },
    );
    if (!res.ok) return undefined;
    const html = await res.text();
    const n = [...html.matchAll(/base-search-card__title/gi)].length;
    return n || undefined;
  } catch {
    return undefined;
  }
}

export async function companySignals(opts: {
  name: string;
  companyId?: string;
  liveHeadcount?: number;
}): Promise<CompanySignals> {
  const [wiki, growjo, sec, jobs] = await Promise.all([
    wikiSignals(opts.name),
    growjoSignals(opts.name, opts.liveHeadcount),
    secRevenue(opts.name),
    jobsOpen(opts.companyId),
  ]);
  const out: CompanySignals = { sources: [] };
  if (opts.liveHeadcount) {
    out.headcount = opts.liveHeadcount;
    out.headcountSource = "LinkedIn";
  }
  if (wiki.publishedHeadcount && !out.headcount) {
    out.headcount = wiki.publishedHeadcount;
    out.headcountSource = wiki.headcountSource;
  }
  if (wiki.publishedHeadcount) out.publishedHeadcount = wiki.publishedHeadcount;
  if (growjo.publishedHeadcount && !out.publishedHeadcount) {
    out.publishedHeadcount = growjo.publishedHeadcount;
  }

  if (sec.revenueUsd) {
    out.revenueUsd = sec.revenueUsd;
    out.revenueLabel = sec.revenueLabel;
    out.revenueSource = sec.revenueSource;
  } else if (wiki.revenueUsd) {
    out.revenueUsd = wiki.revenueUsd;
    out.revenueLabel = wiki.revenueLabel;
    out.revenueSource = wiki.revenueSource;
  } else if (growjo.revenueUsd) {
    out.revenueUsd = growjo.revenueUsd;
    out.revenueLabel = growjo.revenueLabel;
    out.revenueSource = growjo.revenueSource;
  }

  if (growjo.headcountGrowthPct != null) {
    out.headcountGrowthPct = growjo.headcountGrowthPct;
    out.growthSource = growjo.growthSource;
  } else if (out.headcount && out.publishedHeadcount && out.publishedHeadcount > 50) {
    const pct = ((out.headcount - out.publishedHeadcount) / out.publishedHeadcount) * 100;
    if (Math.abs(pct) < 200) {
      out.headcountGrowthPct = Math.round(pct * 10) / 10;
      out.growthSource = "LinkedIn vs Wikipedia";
    }
  }

  if (jobs) out.jobsOpen = jobs;
  out.sources = [
    ...new Set(
      [out.revenueSource, out.growthSource, out.headcountSource, jobs ? "LinkedIn jobs" : "", ...(wiki.sources ?? []), ...(growjo.sources ?? []), ...(sec.sources ?? [])].filter(
        Boolean,
      ) as string[],
    ),
  ];
  return out;
}

export function revenueBand(usd?: number): string {
  if (usd == null) return "";
  if (usd < 1e7) return "lt10m";
  if (usd < 5e7) return "10m50m";
  if (usd < 2.5e8) return "50m250m";
  if (usd < 1e9) return "250m1b";
  return "1bplus";
}

export function growthBand(pct?: number): string {
  if (pct == null) return "";
  if (pct < 0) return "declining";
  if (pct < 10) return "0to10";
  if (pct < 25) return "10to25";
  return "25plus";
}
