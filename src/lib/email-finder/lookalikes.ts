/**
 * Company lookalikes — Clay "Find lookalikes" quality.
 * Niche SERP + G2/roundup lists + LinkedIn company graph, then guest cards.
 */

import { resilientFetch, mapPool } from "./http";

export type Lookalike = {
  name: string;
  domain?: string;
  description?: string;
  industry?: string;
  size?: string;
  type?: string;
  location?: string;
  country?: string;
  linkedinUrl?: string;
  reason?: string;
};

const SKIP_NAME =
  /^(table of contents|alternatives?|competitors?|overview|pricing|kubernetes|tools?|amazon|google|microsoft|aws|azure|oracle|salesforce|datadog|opencost|goldilocks|gke|home|blog|careers|faq|blogs?|contact|partners|conclusion|tldr|methodology|features|pros|cons|strengths|reviews?|sitemap|sign in|faculty)$/i;

const SKIP_HEAD =
  /table of contents|why |what |how we|how to|key |pricing|limitation|consideration|landscape|evaluat|best practice|stop paying|what.?s new|features to look|multi-cloud vs|frequently asked|customer ratings|related blogs?|bottom line|choose if|side-by-side|the \d+ tools|the bottom line|proactive budget|engineer-centric|automated commitment|migration planning|budget alerts|cost drivers|it.?s free|best (cloud|kubernetes)/i;

function decode(s: string): string {
  return s
    .replace(/&#8217;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCompanyName(raw: string, self: string): string | null {
  let n = decode(raw)
    .replace(/^\d+[\).:\s]+/, "")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s*[|\-–—]\s*(LinkedIn|G2|Capterra|202\d).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (n.length < 2 || n.length > 40) return null;
  if (n.split(/\s+/).length > 5) return null;
  if (/[:?]/.test(n)) return null;
  if (/\b(podcast|user experience|might also|also like)\b/i.test(n)) return null;
  if (SKIP_NAME.test(n)) return null;
  if (SKIP_HEAD.test(n)) return null;
  if (/^(best|the|how|why|what|choose|related|frequently|customer|strengths|pros|cons|bottom|faq|blogs?|contact|partners|conclusion|tldr|methodology)\b/i.test(n))
    return null;
  if (!/^[A-Za-z0-9]/.test(n)) return null;
  if (n.toLowerCase() === self.toLowerCase()) return null;
  if (new RegExp(`\\b${self.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(n) && n.length > self.length + 8)
    return null;
  return n;
}

function nicheOf(name: string, description?: string, industry?: string): string {
  const blob = `${name} ${description ?? ""} ${industry ?? ""}`.toLowerCase();
  if (/kubernetes|k8s|kubecost|container cost|finops/.test(blob))
    return "Kubernetes cost optimization";
  if (/payment|fintech|billing/.test(blob)) return "payment processing";
  if (/engineer|construction|civil/.test(blob)) return "engineering consulting";
  const words = (description ?? industry ?? name)
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 4)
    .join(" ");
  return words || name;
}

function namesClose(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nb = b.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = a.toLowerCase().split(/\s+/);
  const wb = b.toLowerCase().split(/\s+/);
  if (wa[0] !== wb[0]) return false;
  const extra = (wa.length >= wb.length ? wa : wb).slice(1).join(" ");
  if (wa.length === 1 && /^(ai|io)$/i.test(extra) && na.length <= 5) return false;
  return /^(inc\.?|ltd\.?|llc|io|ai|software|by .+|an ibm company|a flexera company)?$/i.test(extra);
}

function countryOf(loc?: string): string | undefined {
  if (!loc) return;
  const t = loc.toLowerCase();
  if (/united states|usa|\bus\b/.test(t) || /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i.test(loc))
    return "United States";
  if (/united kingdom|england|\buk\b/.test(t) || /\blondon\b/.test(t)) return "United Kingdom";
  if (/\bcanada\b|\bontario\b|\bquebec\b|\bbritish columbia\b|\balberta\b/.test(t)) return "Canada";
  if (/\baustralia\b|\bnew south wales\b|\bvictoria\b|\bqueensland\b|\bsydney\b|\bmelbourne\b/.test(t)) return "Australia";
  if (/\bfrance\b|\bparis\b/.test(t)) return "France";
  if (/\bgermany\b|\bberlin\b|\bmunich\b/.test(t)) return "Germany";
  if (/\bdubai\b|\buae\b|united arab/.test(t)) return "United Arab Emirates";
  if (/\bsingapore\b/.test(t)) return "Singapore";
  if (/\bindia\b/.test(t)) return "India";
  if (/\bnetherlands\b|\bamsterdam\b/.test(t)) return "Netherlands";
  const last = loc.split(",").slice(-1)[0]?.trim() ?? "";
  const map: Record<string, string> = {
    US: "United States",
    USA: "United States",
    UK: "United Kingdom",
    CA: "Canada",
    AU: "Australia",
    IN: "India",
    IL: "Israel",
    DE: "Germany",
    NL: "Netherlands",
    FR: "France",
    AE: "United Arab Emirates",
  };
  return map[last];
}

function industryBucket(s?: string): "software" | "engineering" | "finance" | "other" {
  const t = (s ?? "").toLowerCase();
  if (/engineer|construction|civil|architect|environmental consulting/.test(t) && !/software|saas/.test(t))
    return "engineering";
  if (/payment|fintech|bank|billing/.test(t)) return "finance";
  if (/software|saas|internet|cloud|information|computer|kubernetes/.test(t)) return "software";
  return "other";
}

function namesFromSnippet(text: string, self: string): string[] {
  const out: string[] = [];
  const lists = text.matchAll(
    /(?:alternatives?(?: include| are)?|competitors?(?: include)?|tools?(?: include)?|vs\.?)[:\s]+([^\n.]{8,280})/gi,
  );
  for (const m of lists) {
    for (const part of m[1]!.split(/\s*(?:,|;| and |\||\/|·)\s*/)) {
      const n = cleanCompanyName(part, self);
      if (n) out.push(n);
    }
  }
  return out;
}

function namesFromArticle(html: string, self: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<h[23][^>]*>([\s\S]{0,120}?)<\/h[23]>/gi)) {
    const n = cleanCompanyName(m[1]!, self);
    if (n) out.push(n);
  }
  for (const m of html.matchAll(/<li[^>]*>\s*(?:<[^>]+>){0,3}\s*(\d+\.\s*)?([A-Z][^<]{2,40})/g)) {
    const n = cleanCompanyName(m[2]!, self);
    if (n) out.push(n);
  }
  return out;
}

type Seed = Lookalike & { score: number };

export async function findLookalikes(opts: {
  domain: string;
  name: string;
  description?: string;
  industry?: string;
}): Promise<Lookalike[]> {
  const self = opts.name.replace(/\([^)]*\)/g, "").trim() || opts.domain.split(".")[0]!;
  const niche = nicheOf(self, opts.description, opts.industry);
  const { decodoShards } = await import("./decodo-serp");
  const queries = [
    `"${self}" alternatives OR competitors ${niche}`,
    `best ${niche} companies 2026`,
    `site:g2.com/products ${self} alternatives`,
    `site:linkedin.com/company "${niche}"`,
  ];
  if (/kubernetes|k8s|finops/i.test(niche)) {
    queries.push(`site:linkedin.com/company "cost optimization" Kubernetes`);
    queries.push(`"${niche}" (ScaleOps OR "Cast AI" OR StormForge OR Kubecost OR nOps)`);
  } else if (/engineer|civil|construction/i.test(niche)) {
    queries.push(`"${self}" competitors (Jacobs OR AECOM OR WSP OR Stantec OR Arcadis OR Aurecon)`);
    queries.push(`site:linkedin.com/company "engineering consulting"`);
  }
  const pages = await decodoShards(queries).catch(() => [] as Array<Array<{ title?: string; description?: string; link?: string }>>);
  const seeds = new Map<string, Seed>();
  const add = (row: Partial<Lookalike> & { name: string }, pts: number) => {
    const name = cleanCompanyName(row.name, self);
    if (!name) return;
    const key = name.toLowerCase();
    const prev = seeds.get(key);
    const next: Seed = {
      name,
      domain: row.domain ?? prev?.domain,
      description: row.description ?? prev?.description,
      industry: row.industry ?? prev?.industry,
      size: row.size ?? prev?.size,
      type: row.type ?? prev?.type,
      location: row.location ?? prev?.location,
      country: row.country ?? prev?.country ?? countryOf(row.location),
      linkedinUrl: row.linkedinUrl ?? prev?.linkedinUrl,
      reason: row.reason ?? prev?.reason ?? niche,
      score: (prev?.score ?? 0) + pts,
    };
    seeds.set(key, next);
  };

  const articleUrls: string[] = [];
  for (const rows of pages) {
    for (const row of rows) {
      const title = row.title ?? "";
      const link = row.link ?? "";
      const desc = row.description ?? "";
      const blob = `${title} ${desc}`;
      for (const n of namesFromSnippet(blob, self)) add({ name: n, reason: "listicle" }, 2);
      const li = link.match(/linkedin\.com\/company\/([a-z0-9\-_%]+)/i);
      if (li) {
        const name = cleanCompanyName(title.replace(/\s*[\-|]\s*LinkedIn.*$/i, ""), self);
        if (name) {
          add(
            {
              name,
              linkedinUrl: `https://www.linkedin.com/company/${decodeURIComponent(li[1]!)}/`,
              description: desc.slice(0, 180) || undefined,
              reason: "linkedin",
            },
            5,
          );
        }
      }
      const g2 = link.match(/g2\.com\/(?:products|compare)\/([a-z0-9\-]+)/i);
      if (g2 && !/kubex|densify/i.test(g2[1]!)) {
        const slug = g2[1]!.replace(/-vs-.*$/, "").replace(/-/g, " ");
        const pretty = slug.replace(/\b\w/g, (c) => c.toUpperCase());
        add({ name: pretty, reason: "g2" }, 3);
      }
      if (
        /alternatives|best .+tools|vs\./i.test(title) &&
        /^https?:/i.test(link) &&
        !/linkedin|g2\.com|reddit|youtube/i.test(link)
      ) {
        articleUrls.push(link.split("#")[0]!);
      }
    }
  }

  const uniqueArticles = [...new Set(articleUrls)].slice(0, 6);
  const articles = await mapPool(uniqueArticles, 4, (url) =>
    resilientFetch(url, { timeoutMs: 8000, maxAttempts: 1 }).catch(() => ({ ok: false, body: "" })),
  );
  for (const page of articles) {
    if (!page.ok || page.body.length < 800) continue;
    for (const n of namesFromArticle(page.body, self)) add({ name: n, reason: "roundup" }, 4);
  }

  const ranked = [...seeds.values()]
    .filter((s) => !SKIP_NAME.test(s.name) && !SKIP_HEAD.test(s.name) && !/[:?]/.test(s.name))
    .sort((a, b) => b.score - a.score)
    .slice(0, 80);

  const unresolved = ranked.filter((s) => !s.linkedinUrl).slice(0, 36);
  if (unresolved.length) {
    const chunks: string[] = [];
    for (let i = 0; i < unresolved.length; i += 6) {
      const part = unresolved
        .slice(i, i + 6)
        .map((s) => (s.name.includes(" ") ? `"${s.name}"` : s.name))
        .join(" OR ");
      chunks.push(`site:linkedin.com/company (${part})`);
    }
    const liPages = await decodoShards(chunks).catch(() => [] as typeof pages);
    for (const rows of liPages) {
      for (const row of rows) {
        const link = row.link ?? "";
        const li = link.match(/linkedin\.com\/company\/([a-z0-9\-_%]+)/i);
        if (!li) continue;
        const name = cleanCompanyName((row.title ?? "").replace(/\s*[\-|]\s*LinkedIn.*$/i, ""), self);
        if (!name) continue;
        const slug = decodeURIComponent(li[1]!);
        const match = unresolved.find(
          (s) => namesClose(s.name, name) || namesClose(s.name, slug.replace(/-/g, " ")),
        );
        if (!match) continue;
        add(
          {
            name: match.name,
            linkedinUrl: `https://www.linkedin.com/company/${slug}/`,
            description: (row.description ?? "").slice(0, 180) || match.description,
            reason: "linkedin",
          },
          6,
        );
      }
    }
  }

  const reranked = [...seeds.values()]
    .filter((s) => !SKIP_NAME.test(s.name) && !SKIP_HEAD.test(s.name))
    .sort((a, b) => b.score - a.score)
    .slice(0, 80);
  const enrichTargets = reranked.filter((s) => s.linkedinUrl || s.score >= 4);
  const enriched = await mapPool(enrichTargets, 8, async (s) => {
    if (!s.linkedinUrl) return s;
    if (s.linkedinUrl && s.size && s.location) return s;
    const card = await guestCard(s.linkedinUrl, s.name);
    if (!card) return s;
    if (card.name && !namesClose(card.name, s.name)) return s;
    return {
      ...s,
      name: card.name && namesClose(card.name, s.name) ? card.name : s.name,
      linkedinUrl: card.linkedinUrl || s.linkedinUrl,
      description: card.description || s.description,
      industry: card.industry || s.industry,
      size: card.size || s.size,
      type: card.type || s.type || "Privately held",
      location: card.location || s.location,
      country: card.country || s.country || countryOf(card.location),
    };
  });

  const selfBucket = industryBucket(`${opts.industry ?? ""} ${opts.description ?? ""} ${niche}`);
  const seen = new Set<string>();
  const out: Lookalike[] = [];
  for (const s of enriched) {
    const k = s.name.toLowerCase();
    if (seen.has(k)) continue;
    if (!s.linkedinUrl) continue;
    if (/education|entertainment|nonprofit|government|higher education|media production|advertising services|hospitals and health care|marketing services|book and periodical/i.test(s.industry ?? ""))
      continue;
    if (/densify/i.test(`${s.name} ${s.linkedinUrl ?? ""}`)) continue;
    if (namesClose(s.name, self)) continue;
    if (/^full control|^sitemap|^sign in|^venture capital|^login$|^media$/i.test(s.name)) continue;
    if (/^spotio$/i.test(s.name)) continue;
    const other = industryBucket(`${s.industry ?? ""} ${s.description ?? ""}`);
    const blob = `${s.name} ${s.industry ?? ""} ${s.description ?? ""}`;
    if (selfBucket === "software") {
      if (other === "engineering" || other === "finance") continue;
      if (other === "other" && !/software|cloud|k8s|kubernetes|infra|optim|saas|finops/i.test(blob)) continue;
    }
    if (selfBucket === "engineering") {
      if (other === "software" || other === "finance") continue;
      if (other === "other" && !/engineer|consult|civil|construction|architect|infrastructure/i.test(blob)) continue;
      if (!s.industry) continue;
      if (/engineering & consulting|consulting engineers|business consultant|business and engineering/i.test(s.name) && !s.size)
        continue;
    }
    seen.add(k);
    const { score: _s, ...rest } = s;
    out.push({
      ...rest,
      country: countryOf(s.location) || countryOf(s.country) || undefined,
    });
    if (out.length >= 50) break;
  }
  return out;
}

async function guestCard(
  url: string | undefined,
  name: string,
): Promise<Partial<Lookalike> | null> {
  const slug =
    url?.match(/linkedin\.com\/company\/([^/?#]+)/i)?.[1] ??
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) return null;
  try {
    const page = await resilientFetch(
      `https://www.linkedin.com/organization-guest/company/${slug}`,
      { timeoutMs: 4500, maxAttempts: 1 },
    );
    if (!page.ok || page.body.length < 1500) return null;
    const html = page.body;
    if (/uas\/login|sign in to linkedin/i.test(html.slice(0, 3000)) && html.length < 80_000)
      return null;
    const title = html
      .match(/<title>([^<|]+)\s*\|?\s*LinkedIn/i)?.[1]
      ?.replace(/\s*[-–—]\s*Employees,?\s*Jobs.*$/i, "")
      .trim();
    const about = (label: string) =>
      html
        .match(new RegExp(`${label}\\s*</dt>\\s*<dd[^>]*>\\s*([^<]{2,80})`, "i"))?.[1]
        ?.replace(/\s+/g, " ")
        .trim();
    const emp = html.match(/([\d,]+)\+?\s*employees/i)?.[1];
    const desc = html
      .match(/top-card-layout__headline[^>]*>([\s\S]*?)<\//i)?.[1]
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
    const hq = about("Headquarters");
    return {
      name: title && title.length < 48 ? title : name,
      linkedinUrl: `https://www.linkedin.com/company/${slug}/`,
      description: desc || undefined,
      industry: about("Industry") || undefined,
      size: emp ? `${emp} employees` : about("Company size"),
      type: about("Type") || undefined,
      location: hq,
      country: countryOf(hq),
    };
  } catch {
    return null;
  }
}
