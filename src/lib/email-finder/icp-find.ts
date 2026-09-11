/**
 * ICP Finder — SparkToro-style audience report, revenue-weighted.
 * Not a generic persona. Hangouts, bios, podcasts, keywords, apps
 * inferred from paying customers + competitors + live public overlap.
 */

import { resilientFetch } from "./http";
import { detectTechStack } from "./tech-stack";
import { parseRss } from "./signals-sources";

export type IcpCustomerIn = { name?: string; domain: string; acv: number };

export type IcpInput = {
  website: string;
  brief?: string;
  customers?: IcpCustomerIn[];
  competitors?: string[];
};

export type AffinityRow = {
  name: string;
  url?: string;
  kind: string;
  pct: number;
  affinity: number;
  evidence: string;
  source: string;
};

export type IcpSegment = {
  name: string;
  shareOfRevenue: number;
  who: string;
  whereToShowUp: string[];
  evidence: string[];
};

export type IcpReport = {
  company: { domain: string; name: string; brief: string; products: string[] };
  spend: { totalAcv: number; weightedCustomers: number };
  demographics: {
    titles: AffinityRow[];
    seniority: AffinityRow[];
    industries: AffinityRow[];
    sizes: AffinityRow[];
    locations: AffinityRow[];
  };
  social: AffinityRow[];
  websites: AffinityRow[];
  youtube: AffinityRow[];
  podcasts: AffinityRow[];
  reddit: AffinityRow[];
  keywords: AffinityRow[];
  apps: AffinityRow[];
  bioPhrases: AffinityRow[];
  segments: IcpSegment[];
  takeAction: string[];
  sources: string[];
  durationMs: number;
};

function normDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/[^\w.-]/g, "");
}

function decode(s: string): string {
  return s
    .replace(/&/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/"/g, '"')
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";

async function getJson<T>(url: string, timeout = 9000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function getText(url: string, timeout = 9000): Promise<string> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { "User-Agent": BROWSER_UA, Accept: "*/*" },
    });
    if (!res.ok) return "";
    return res.text();
  } catch {
    return "";
  }
}

type SiteCard = {
  domain: string;
  name: string;
  description: string;
  social: Array<{ net: string; url: string }>;
  products: string[];
  tech: string[];
  titles: string[];
  locations: string[];
  industry?: string;
};

async function crawlCard(domain: string): Promise<SiteCard> {
  const card: SiteCard = { domain, name: domain.split(".")[0] ?? domain, description: "", social: [], products: [], tech: [], titles: [], locations: [] };
  const home = await resilientFetch(`https://${domain}`, { timeoutMs: 8000, maxAttempts: 2, preferBot: true });
  const html = home.ok ? home.body : "";
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const og = decode(html.match(/property="og:site_name"[^>]*content="([^"]+)"/i)?.[1] ?? html.match(/content="([^"]+)"[^>]*property="og:site_name"/i)?.[1] ?? "");
  const desc = decode(
    html.match(/property="og:description"[^>]*content="([^"]+)"/i)?.[1] ??
      html.match(/name="description"[^>]*content="([^"]+)"/i)?.[1] ??
      "",
  );
  if (og) card.name = og;
  else if (title) card.name = title.replace(/\s*[|\-–:].*$/, "").slice(0, 80);
  card.description = desc.slice(0, 280);
  const socialRe = /https?:\/\/(?:www\.)?(linkedin|twitter|x|youtube|github|facebook|instagram)\.com\/[^\s"'<>]+/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = socialRe.exec(html))) {
    const net = m[1]!.replace(/^x$/i, "twitter");
    const url = m[0].replace(/[.,;)]+$/, "");
    const key = net + url;
    if (seen.has(key)) continue;
    seen.add(key);
    card.social.push({ net, url });
  }
  for (const h of html.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi) ?? []) {
    const t = decode(h);
    if (t.length > 4 && t.length < 60) card.products.push(t);
  }
  const loc = html.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)*),\s*(?:[A-Z]{2}|[A-Z][a-z]+)(?:\s+\d{4,6})?/);
  if (loc) card.locations.push(loc[0]);
  try {
    const stack = await detectTechStack(domain, `${title} ${desc}`);
    card.tech = stack.technologies.slice(0, 18).map((t) => t.name);
  } catch {
    /* skip */
  }
  const jobsHtml = await getText(
    `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(card.name)}&start=0`,
    10000,
  );
  for (const c of jobsHtml.split(/base-card/i).slice(1, 16)) {
    const jt = decode((c.match(/base-search-card__title[^>]*>([\s\S]*?)</i)?.[1] ?? "").replace(/\s+/g, " "));
    const loc2 = decode((c.match(/job-search-card__location[^>]*>([\s\S]*?)</i)?.[1] ?? "").replace(/\s+/g, " "));
    if (jt) card.titles.push(jt);
    if (loc2) card.locations.push(loc2);
  }
  return card;
}

function bag(): Map<string, { w: number; n: number; url?: string; evidence: string[]; source: string; kind: string }> {
  return new Map();
}

function add(
  m: Map<string, { w: number; n: number; url?: string; evidence: string[]; source: string; kind: string }>,
  name: string,
  weight: number,
  meta: { url?: string; evidence?: string; source: string; kind: string },
) {
  const key = name.trim();
  if (!key || key.length < 2) return;
  const cur = m.get(key.toLowerCase()) ?? { w: 0, n: 0, url: meta.url, evidence: [], source: meta.source, kind: meta.kind };
  cur.w += weight;
  cur.n += 1;
  if (meta.url && !cur.url) cur.url = meta.url;
  if (meta.evidence) cur.evidence.push(meta.evidence);
  m.set(key.toLowerCase(), { ...cur, kind: meta.kind, source: meta.source });
}

function rank(
  m: Map<string, { w: number; n: number; url?: string; evidence: string[]; source: string; kind: string }>,
  totalW: number,
  limit = 12,
): AffinityRow[] {
  const rows = [...m.entries()].map(([k, v]) => {
    const pct = totalW > 0 ? Math.round((v.w / totalW) * 1000) / 10 : 0;
    const affinity = Math.min(100, Math.round(pct * 1.4 + Math.min(30, v.n * 6)));
    const display = k.includes(".") || k.startsWith("r/") ? k : k.replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      name: display,
      url: v.url,
      kind: v.kind,
      pct,
      affinity,
      evidence: v.evidence.slice(0, 3).join(" · ") || v.source,
      source: v.source,
    };
  });
  return rows.sort((a, b) => b.affinity - a.affinity || b.pct - a.pct).slice(0, limit);
}

const SENIORITY: Array<{ re: RegExp; label: string }> = [
  { re: /\b(chief|ceo|cto|cfo|cmo|coo|ciso|founder|co-founder|president)\b/i, label: "C-level / founder" },
  { re: /\b(vp|vice president|head of|director)\b/i, label: "VP / Director" },
  { re: /\b(manager|lead|principal|staff)\b/i, label: "Manager / Lead" },
  { re: /\b(engineer|developer|analyst|specialist|consultant)\b/i, label: "IC / Practitioner" },
];

async function itunesPodcasts(q: string): Promise<Array<{ name: string; url: string; artist: string }>> {
  const j = await getJson<{ results?: Array<{ collectionName?: string; collectionViewUrl?: string; artistName?: string }> }>(
    `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=podcast&limit=8`,
  );
  return (j?.results ?? []).map((r) => ({
    name: r.collectionName ?? "",
    url: r.collectionViewUrl ?? "",
    artist: r.artistName ?? "",
  })).filter((x) => x.name);
}

async function googleSuggest(q: string): Promise<string[]> {
  const raw = await getText(`https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`);
  try {
    const j = JSON.parse(raw) as [string, string[]];
    return Array.isArray(j[1]) ? j[1] : [];
  } catch {
    return [];
  }
}

async function hnHits(q: string) {
  const j = await getJson<{ hits?: Array<{ title?: string; url?: string; points?: number; author?: string }> }>(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&hitsPerPage=12`,
  );
  return j?.hits ?? [];
}

function extractReddit(urlsAndTitles: string[]): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = [];
  const seen = new Set<string>();
  for (const s of urlsAndTitles) {
    const m = s.match(/reddit\.com\/r\/([A-Za-z0-9_]+)/i) || s.match(/\br\/([A-Za-z0-9_]{3,30})\b/);
    if (!m) continue;
    const name = `r/${m[1]}`;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, url: `https://www.reddit.com/r/${m[1]}` });
  }
  return out;
}

function extractYt(title: string, url: string): { name: string; url: string } | null {
  const u = url || "";
  if (!/youtube\.com|youtu\.be/i.test(u + title)) return null;
  const name = title.replace(/\s*[-|].*(youtube|google).*$/i, "").slice(0, 90);
  return name ? { name, url: u } : null;
}

export async function findIcp(input: IcpInput): Promise<IcpReport> {
  const t0 = Date.now();
  const domain = normDomain(input.website || "");
  if (!domain.includes(".")) throw new Error("website domain required");

  const customers = (input.customers ?? [])
    .map((c) => ({ ...c, domain: normDomain(c.domain || c.name || "") }))
    .filter((c) => c.domain.includes("."));
  const competitors = (input.competitors ?? []).map(normDomain).filter((d) => d.includes("."));
  const brief = (input.brief ?? "").trim();

  const you = await crawlCard(domain);
  const products = [...new Set([...(brief ? [brief.slice(0, 80)] : []), ...you.products.slice(0, 6)])];
  const STOP = /^(that|with|from|your|their|about|using|which|while|these|those|company|teams|platform|cloud|spend|cuts)$/i;
  const topicWords = [...new Set(
    `${brief} ${you.description} ${you.name}`
      .match(/[A-Za-z][A-Za-z0-9+#-]{3,}/g)
      ?.filter((w) => !STOP.test(w)) ?? [],
  )];
  const q = (topicWords.slice(0, 3).join(" ") || you.name).slice(0, 40);

  const weighted: Array<{ card: SiteCard; acv: number; role: "customer" | "competitor" | "you" }> = [
    { card: you, acv: 0, role: "you" },
  ];
  const custAcv = customers.map((c) => Math.max(1, Number(c.acv) || 1));
  const totalAcv = custAcv.reduce((s, n) => s + n, 0) || 1;

  const [custCards, compCards] = await Promise.all([
    Promise.all(customers.slice(0, 8).map(async (c, i) => ({ card: await crawlCard(c.domain), acv: custAcv[i] ?? 1, role: "customer" as const }))),
    Promise.all(competitors.slice(0, 6).map(async (d) => ({ card: await crawlCard(d), acv: 0, role: "competitor" as const }))),
  ]);
  weighted.push(...custCards, ...compCards);

  const titles = bag();
  const seniority = bag();
  const industries = bag();
  const sizes = bag();
  const locations = bag();
  const social = bag();
  const websites = bag();
  const youtube = bag();
  const podcasts = bag();
  const reddit = bag();
  const keywords = bag();
  const apps = bag();
  const bios = bag();
  const sources = new Set<string>(["site-crawl", "linkedin-jobs", "tech-headers"]);

  for (const row of weighted) {
    const w = row.role === "customer" ? row.acv : row.role === "you" ? totalAcv * 0.15 : totalAcv * 0.08;
    for (const t of row.card.titles) {
      const buyer =
        /platform|devops|sre|finops|kubernetes|cloud|infra|architect|reliability|\bcto\b|vp |vice president|head of|director|product manager|engineering manager|staff engineer|principal|security|data platform/i.test(
          t,
        ) || topicWords.some((word) => word.length > 5 && t.toLowerCase().includes(word.toLowerCase()));
      if (!buyer && row.role === "customer") continue;
      add(titles, t, w, { source: "linkedin-jobs", kind: "title", evidence: `${row.card.name} hiring` });
      const sen = SENIORITY.find((s) => s.re.test(t));
      if (sen) add(seniority, sen.label, w, { source: "linkedin-jobs", kind: "seniority", evidence: t });
      for (const phrase of t.split(/[|,/–-]/).map((x) => x.trim()).filter((x) => x.length > 3 && x.length < 40)) {
        add(bios, phrase, w, { source: "job-title", kind: "bio", evidence: `${row.card.name}` });
      }
    }
    for (const loc of row.card.locations) add(locations, loc, w, { source: "jobs", kind: "location", evidence: row.card.name });
    for (const s of row.card.social) {
      add(social, `${s.net} · ${s.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}`, w, {
        url: s.url,
        source: "site",
        kind: s.net,
        evidence: row.card.domain,
      });
    }
    for (const tech of row.card.tech) add(apps, tech, w, { source: "tech-stack", kind: "app", evidence: row.card.domain });
    if (row.card.description) {
      const industryGuess = row.card.description.split(/[.|]/)[0]?.slice(0, 80);
      if (industryGuess) add(industries, industryGuess, w, { source: "about", kind: "industry", evidence: row.card.domain });
    }
    add(websites, row.card.domain, w, { url: `https://${row.card.domain}`, source: "customer-graph", kind: "site", evidence: row.card.name });
    add(sizes, row.card.titles.length >= 10 ? "Hiring at scale (10+ open roles)" : row.card.titles.length >= 3 ? "Actively hiring" : "Small / unknown headcount signal", w, {
      source: "jobs",
      kind: "size",
      evidence: `${row.card.titles.length} jobs`,
    });
  }

  const podQ = `${topicWords[0] ?? you.name} cost`;
  const [pods, pods2, suggest, suggest2, hn, ytRss, redditRss, g2Rss, pressRss] = await Promise.all([
    itunesPodcasts(podQ),
    itunesPodcasts(q),
    googleSuggest(podQ),
    googleSuggest(q),
    hnHits(podQ),
    getText(`https://news.google.com/rss/search?q=${encodeURIComponent(`site:youtube.com ${q}`)}&hl=en-US&gl=US&ceid=US:en`),
    getText(`https://news.google.com/rss/search?q=${encodeURIComponent(`site:reddit.com ${q}`)}&hl=en-US&gl=US&ceid=US:en`),
    getText(`https://news.google.com/rss/search?q=${encodeURIComponent(`site:g2.com OR site:capterra.com ${you.name}`)}&hl=en-US&gl=US&ceid=US:en`),
    getText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`),
  ]);
  sources.add("itunes");
  sources.add("google-suggest");
  sources.add("hacker-news");
  sources.add("google-news");

  const overlapW = totalAcv;
  for (const p of [...pods, ...pods2]) {
    add(podcasts, p.name, overlapW * 0.4, { url: p.url, source: "itunes", kind: "podcast", evidence: p.artist });
  }
  for (const [i, s] of [...suggest, ...suggest2].entries()) {
    add(keywords, s, overlapW * (1 - i * 0.08), { source: "google-suggest", kind: "keyword", evidence: `autocomplete #${i + 1}` });
  }
  for (const h of hn) {
    const host = h.url ? hostOf(h.url) : "news.ycombinator.com";
    if (!/google\.|gstatic|doubleclick/.test(host)) {
      add(websites, host, overlapW * 0.2, { url: h.url, source: "hacker-news", kind: "site", evidence: h.title ?? "" });
    }
    if (h.author) add(social, `HN · ${h.author}`, overlapW * 0.15, { url: `https://news.ycombinator.com/user?id=${h.author}`, source: "hacker-news", kind: "hn", evidence: h.title ?? "" });
    add(keywords, (h.title ?? "").slice(0, 80), overlapW * 0.1, { source: "hacker-news", kind: "topic", evidence: `${h.points ?? 0} pts` });
  }
  for (const it of parseRss(ytRss, "youtube")) {
    const yt = extractYt(it.title, it.url);
    if (yt) add(youtube, yt.name, overlapW * 0.25, { url: yt.url, source: "youtube", kind: "youtube", evidence: "news index" });
  }
  for (const it of parseRss(redditRss, "reddit")) {
    for (const r of extractReddit([it.url, it.title, it.snippet])) {
      add(reddit, r.name, overlapW * 0.3, { url: r.url, source: "reddit", kind: "subreddit", evidence: it.title });
    }
  }
  for (const it of parseRss(g2Rss, "g2")) {
    const host = hostOf(it.url);
    if (host && !/google\./.test(host)) {
      add(websites, host, overlapW * 0.35, { url: it.url, source: "g2", kind: "review", evidence: it.title });
    }
  }
  for (const it of parseRss(pressRss, "press")) {
    const host = hostOf(it.url);
    if (host && !/google\.|gstatic|doubleclick/.test(host)) {
      add(websites, host, overlapW * 0.12, { url: it.url, source: "press", kind: "media", evidence: it.title });
    }
  }

  const titleRows = rank(titles, totalAcv, 15);
  const topTitles = titleRows.slice(0, 4).map((t) => t.name);
  const topPods = rank(podcasts, overlapW, 6).map((p) => p.name);
  const topSites = rank(websites, overlapW, 8).map((s) => s.name);
  const topReddit = rank(reddit, overlapW, 5).map((s) => s.name);
  const topKw = rank(keywords, overlapW, 6).map((s) => s.name);

  const paying = custCards.sort((a, b) => b.acv - a.acv);
  const segments: IcpSegment[] = paying.slice(0, 3).map((c) => {
    const share = Math.round((c.acv / totalAcv) * 1000) / 10;
    const who = c.card.titles.slice(0, 4).join(" · ") || c.card.description.slice(0, 120) || c.card.name;
    return {
      name: `${c.card.name} cluster`,
      shareOfRevenue: share,
      who,
      whereToShowUp: [...topSites.slice(0, 2), ...topPods.slice(0, 1), ...topReddit.slice(0, 1)].filter(Boolean),
      evidence: [
        `ACV weight ${share}%`,
        c.card.tech.slice(0, 6).join(", ") || "tech unknown",
        `${c.card.titles.length} live jobs`,
      ],
    };
  });
  if (!segments.length) {
    segments.push({
      name: "Inferred from your site + category",
      shareOfRevenue: 100,
      who: topTitles.join(" · ") || "titles from category hiring",
      whereToShowUp: [...topSites.slice(0, 3), ...topPods.slice(0, 1)],
      evidence: ["No customer ACV provided — equal-weight category overlap only"],
    });
  }

  const takeAction: string[] = [];
  if (topPods[0]) takeAction.push(`Pitch or sponsor “${topPods[0]}” — iTunes ranks it for “${q}”.`);
  if (topReddit[0]) takeAction.push(`Show up in ${topReddit[0]} with proof, not ads — it already indexes this category.`);
  if (topKw[0]) takeAction.push(`SEO/content: Google autocomplete is pulling “${topKw[0]}” from your category.`);
  if (topSites[0]) takeAction.push(`Digital PR: ${topSites[0]} already appears next to this audience in public overlap.`);
  if (titleRows[0]) takeAction.push(`Outbound title: ${titleRows[0].name} (weighted by who actually pays, not a made-up persona).`);
  if (paying[0]) takeAction.push(`Clone ${paying[0].card.name} (${Math.round((paying[0].acv / totalAcv) * 100)}% of named ACV) — lookalikes with the same stack/jobs.`);

  return {
    company: { domain, name: you.name, brief: brief || you.description, products: products.slice(0, 8) },
    spend: { totalAcv: customers.length ? totalAcv : 0, weightedCustomers: customers.length },
    demographics: {
      titles: titleRows,
      seniority: rank(seniority, totalAcv, 6),
      industries: rank(industries, totalAcv, 8),
      sizes: rank(sizes, totalAcv, 5),
      locations: rank(locations, totalAcv, 8),
    },
    social: rank(social, totalAcv, 12),
    websites: rank(websites, overlapW, 14),
    youtube: rank(youtube, overlapW, 10),
    podcasts: rank(podcasts, overlapW, 10),
    reddit: rank(reddit, overlapW, 10),
    keywords: rank(keywords, overlapW, 14),
    apps: rank(apps, totalAcv, 14),
    bioPhrases: rank(bios, totalAcv, 16),
    segments,
    takeAction,
    sources: [...sources],
    durationMs: Date.now() - t0,
  };
}
