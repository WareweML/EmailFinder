/** Funding from Wikipedia; lookalikes from live G2/LinkedIn/roundups. */

export type SimilarCompany = {
  name: string;
  domain?: string;
  reason?: string;
  description?: string;
  industry?: string;
  size?: string;
  type?: string;
  location?: string;
  country?: string;
  linkedinUrl?: string;
};

export type CompanyProfile = {
  fundingStage?: string;
  totalFunding?: string;
  latestFunding?: string;
  latestFundingDate?: string;
  revenue?: string;
  similar: SimilarCompany[];
};

async function wikiFinance(name: string): Promise<{
  revenue?: string;
  stage?: string;
}> {
  const titles = [name, `${name} Group`, `${name} Group Pty Ltd`];
  for (const title of titles) {
    try {
      const url =
        "https://en.wikipedia.org/w/api.php?" +
        new URLSearchParams({
          action: "query",
          prop: "revisions",
          rvprop: "content",
          rvslots: "main",
          titles: title,
          format: "json",
          redirects: "1",
        });
      const res = await fetch(url, {
        headers: { "User-Agent": "Mailgraph/1.0 (contact@warewe.com)" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as {
        query?: { pages?: Record<string, { missing?: string; revisions?: Array<{ slots?: { main?: { ["*"]?: string } } }> }> };
      };
      const page = Object.values(j.query?.pages ?? {})[0];
      const wikitext = page?.revisions?.[0]?.slots?.main?.["*"] ?? "";
      if (!wikitext || page?.missing !== undefined) continue;
      const rev = wikitext.match(/\|\s*revenue\s*=\s*([^\n]+)/i)?.[1];
      let revenue: string | undefined;
      if (rev) {
        const num = rev.match(/([\d.,]+\s*(?:billion|million))/i)?.[1];
        if (num) {
          const aud = /australian dollar|A\$|AUD/i.test(rev);
          revenue = `${aud ? "A$" : "$"}${num.replace(/^\$/, "")} (Wikipedia)`;
        }
      }
      const stage = /seed|series [a-f]|pre-seed|growth equity|ipo/i.test(wikitext)
        ? (wikitext.match(/\b(Series [A-F]|Seed|Pre-seed|IPO)\b/i)?.[0] ?? undefined)
        : undefined;
      if (revenue || stage) return { revenue, stage };
    } catch {
      /* next title */
    }
  }
  return {};
}

export async function enrichCompanyProfile(
  domain: string,
  companyName: string,
  seedSimilar: SimilarCompany[] = [],
  extra?: { description?: string; industry?: string; location?: string; country?: string },
): Promise<CompanyProfile> {
  const name =
    companyName.replace(/\([^)]*\)/g, "").trim() || domain.split(".")[0]!;
  const wiki = await wikiFinance(name);
  let similar: SimilarCompany[] = [];
  try {
    const { findLookalikes } = await import("./lookalikes");
    similar = await findLookalikes({
      domain,
      name,
      description: extra?.description,
      industry: extra?.industry,
      location: extra?.location,
      country: extra?.country,
    });
  } catch {
    similar = [];
  }
  for (const s of seedSimilar) {
    if (!similar.some((x) => x.name.toLowerCase() === s.name.toLowerCase())) {
      similar.push(s);
    }
  }
  return {
    fundingStage: wiki.stage,
    totalFunding: undefined,
    revenue: wiki.revenue,
    similar: similar.slice(0, 50),
  };
}
