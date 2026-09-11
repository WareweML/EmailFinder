/**
 * Free signal sources that actually returned data in 2026.
 * Paid intent graphs sit on these same public feeds.
 */

export type SourceHit = {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  source: string;
  score?: number;
  spike?: boolean;
};

const UA = "MailgraphSignals/1.0 (research@warewe.com)";

function slugOf(entity: string): string {
  return entity
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\.(com|io|ai|co|org|net|au|uk|ca|in).*$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 40);
}

function tokens(entity: string): string[] {
  return entity
    .toLowerCase()
    .replace(/\.(com|io|ai|co|org|net|au|uk).*$/i, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !/^(the|and|inc|ltd|llc|pty|group|company)$/.test(t));
}

export function nameLock(blob: string, entity: string): boolean {
  const hay = blob.toLowerCase();
  const t = tokens(entity);
  if (!t.length) return hay.includes(entity.toLowerCase());
  return t.every((x) => hay.includes(x));
}

async function getText(url: string, timeout = 9000): Promise<string> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { "User-Agent": UA, Accept: "application/json, application/rss+xml, text/xml, */*" },
    });
    if (!res.ok) return "";
    return res.text();
  } catch {
    return "";
  }
}

async function getJson<T = unknown>(url: string, timeout = 9000): Promise<T | null> {
  const raw = await getText(url, timeout);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function decode(s: string): string {
  return s.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">").replace(/"/g, '"').replace(/&#39;/g, "'");
}

function tag(xml: string, name: string): string {
  const m =
    xml.match(new RegExp(`<${name}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${name}>`, "i")) ??
    xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return (m?.[1] ?? "").trim();
}

export function parseRss(xml: string, source: string): SourceHit[] {
  const items: SourceHit[] = [];
  for (const b of xml.split(/<item[\s>]/i).slice(1, 41)) {
    const title = decode(tag(b, "title"));
    const url = tag(b, "link") || (b.match(/href="([^"]+)"/i)?.[1] ?? "");
    const snippet = decode(tag(b, "description")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 280);
    const date = tag(b, "pubDate") || tag(b, "published") || undefined;
    if (title) items.push({ title, url: url.trim(), snippet, date, source });
  }
  return items;
}

async function settled<T>(ps: Array<Promise<T[]>>): Promise<T[]> {
  const rows = await Promise.allSettled(ps);
  return rows.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

export async function googleNews(q: string): Promise<SourceHit[]> {
  const xml = await getText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`);
  return parseRss(xml, "google-news");
}

export async function bingNews(q: string): Promise<SourceHit[]> {
  const xml = await getText(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`);
  return parseRss(xml, "bing-news");
}

export async function hnSearch(q: string): Promise<SourceHit[]> {
  const j = await getJson<{ hits?: Array<{ title?: string; url?: string; story_text?: string; created_at?: string; objectID?: string }> }>(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&hitsPerPage=12`,
  );
  return (j?.hits ?? []).map((h) => ({
    title: h.title ?? "",
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    snippet: (h.story_text ?? "").slice(0, 220),
    date: h.created_at,
    source: "hacker-news",
  })).filter((x) => x.title);
}

export async function redditSearch(q: string): Promise<SourceHit[]> {
  const j = await getJson<{ data?: { children?: Array<{ data?: { title?: string; url?: string; selftext?: string; created_utc?: number; permalink?: string } }> } }>(
    `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&t=month&limit=12`,
  );
  return (j?.data?.children ?? []).map((c) => {
    const d = c.data ?? {};
    return {
      title: d.title ?? "",
      url: d.url?.startsWith("http") ? d.url : `https://www.reddit.com${d.permalink ?? ""}`,
      snippet: (d.selftext ?? "").slice(0, 220),
      date: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : undefined,
      source: "reddit",
    };
  }).filter((x) => x.title);
}

export async function serp(q: string): Promise<SourceHit[]> {
  try {
    const { decodoSearch } = await import("./decodo-serp");
    const rows = await decodoSearch(q);
    return rows.slice(0, 12).map((r) => ({
      title: r.title ?? "",
      url: r.link ?? "",
      snippet: (r.description ?? "").slice(0, 240),
      source: "google",
    })).filter((x) => x.title);
  } catch {
    return [];
  }
}

export async function gdeltArt(q: string): Promise<SourceHit[]> {
  const j = await getJson<{ articles?: Array<{ title?: string; url?: string; seendate?: string; domain?: string; socialimage?: string }> }>(
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=ArtList&maxrecords=20&timespan=14d&format=json&sort=DateDesc`,
    12000,
  );
  return (j?.articles ?? []).map((a) => ({
    title: a.title ?? "",
    url: a.url ?? "",
    snippet: a.domain ?? "",
    date: a.seendate,
    source: "gdelt",
  })).filter((x) => x.title);
}

export async function wikiViews(entity: string): Promise<SourceHit[]> {
  try {
    const search = await getJson<{ query?: { search?: Array<{ title: string }> } }>(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=${encodeURIComponent(entity + " company")}`,
    );
    const title = search?.query?.search?.[0]?.title;
    if (!title) return [];
    const slug = title.replace(/ /g, "_");
    const end = new Date();
    const start = new Date(end.getTime() - 28 * 86400000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
    const pv = await getJson<{ items?: Array<{ views: number; timestamp: string }> }>(
      `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encodeURIComponent(slug)}/daily/${fmt(start)}/${fmt(end)}00`,
    );
    const items = pv?.items ?? [];
    if (items.length < 10) return [];
    const last = items.slice(-7).reduce((s, x) => s + x.views, 0);
    const prev = items.slice(-14, -7).reduce((s, x) => s + x.views, 0) || 1;
    const ratio = last / prev;
    const spike = ratio >= 1.5 && last >= 200;
    return [{
      title: `${title} Wikipedia ${spike ? "traffic spike" : "pageviews"} ${(ratio).toFixed(1)}× vs prior week`,
      url: `https://en.wikipedia.org/wiki/${slug}`,
      snippet: `Last 7d ${last} views · prior 7d ${prev}`,
      source: "wikipedia-pageviews",
      score: Math.round(ratio * 100) / 100,
      spike,
    }];
  } catch {
    return [];
  }
}

export async function openAlex(q: string): Promise<SourceHit[]> {
  const j = await getJson<{ results?: Array<{ display_name?: string; id?: string; publication_date?: string; doi?: string }> }>(
    `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=8`,
  );
  return (j?.results ?? []).map((w) => ({
    title: w.display_name ?? "",
    url: w.id ?? (w.doi ? `https://doi.org/${w.doi}` : ""),
    snippet: w.publication_date ?? "research paper",
    date: w.publication_date,
    source: "openalex",
  })).filter((x) => x.title);
}

export async function crossrefWorks(q: string): Promise<SourceHit[]> {
  const j = await getJson<{ message?: { items?: Array<{ title?: string[]; URL?: string; created?: { date_time?: string } }> } }>(
    `https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=6`,
  );
  return (j?.message?.items ?? []).map((w) => ({
    title: w.title?.[0] ?? "",
    url: w.URL ?? "",
    snippet: "scholarly work",
    date: w.created?.date_time,
    source: "crossref",
  })).filter((x) => x.title);
}

export async function githubSearch(q: string): Promise<SourceHit[]> {
  const j = await getJson<{ items?: Array<{ full_name?: string; html_url?: string; description?: string; stargazers_count?: number; updated_at?: string }> }>(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=6`,
  );
  return (j?.items ?? []).map((r) => ({
    title: `${r.full_name} ★${r.stargazers_count ?? 0}`,
    url: r.html_url ?? "",
    snippet: r.description ?? "",
    date: r.updated_at,
    source: "github",
  }));
}

export async function linkedInJobs(company: string): Promise<SourceHit[]> {
  const html = await getText(
    `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(company)}&start=0`,
    12000,
  );
  const out: SourceHit[] = [];
  for (const c of html.split(/base-card/i).slice(1, 26)) {
    const title = decode((c.match(/base-search-card__title[^>]*>([\s\S]*?)</i)?.[1] ?? "").replace(/\s+/g, " ").trim());
    const companyName = decode((c.match(/base-search-card__subtitle[^>]*>([\s\S]*?)</i)?.[1] ?? "").replace(/\s+/g, " ").trim());
    const loc = decode((c.match(/job-search-card__location[^>]*>([\s\S]*?)</i)?.[1] ?? "").replace(/\s+/g, " ").trim());
    const href = c.match(/href="(https:\/\/[^\"]+jobs[^\"]+)"/i)?.[1] ?? "";
    const date = c.match(/datetime="([^"]+)"/i)?.[1];
    if (!title) continue;
    if (companyName && !nameLock(`${title} ${companyName}`, company) && !nameLock(companyName, company)) continue;
    out.push({ title: `${title} · ${companyName || company}`, url: href, snippet: loc, date, source: "linkedin-jobs" });
  }
  return out;
}

export async function jobsApi(company: string): Promise<SourceHit[]> {
  const slug = slugOf(company);
  const urls = [
    `https://api.jobopportunitiesapi.org/public/jobs?company=${encodeURIComponent(company)}&limit=25`,
    `https://api.jobopportunitiesapi.org/public/jobs?company_slug=${encodeURIComponent(slug)}&limit=25`,
  ];
  const out: SourceHit[] = [];
  for (const u of urls) {
    const j = await getJson<{ data?: Array<{ title?: string; company?: string; apply_url?: string; city?: string; country?: string; posted_at?: string; source?: string }> }>(u);
    for (const row of j?.data ?? []) {
      if (!nameLock(`${row.company} ${row.title}`, company) && !nameLock(row.company ?? "", company)) continue;
      out.push({
        title: `${row.title} · ${row.company}`,
        url: row.apply_url ?? "",
        snippet: [row.city, row.country, row.source].filter(Boolean).join(" · "),
        date: row.posted_at,
        source: `jobs-api:${row.source ?? "ats"}`,
      });
    }
    if (out.length) break;
  }
  return out;
}

async function atsOne(url: string, source: string, pick: (j: unknown) => SourceHit[]): Promise<SourceHit[]> {
  const j = await getJson(url, 8000);
  if (!j) return [];
  try {
    return pick(j).filter((x) => x.title);
  } catch {
    return [];
  }
}

export async function atsJobs(entity: string): Promise<SourceHit[]> {
  const slug = slugOf(entity);
  const slugs = [...new Set([slug, `${slug}group`, slug.replace(/group$/, "")])].filter((s) => s.length > 2);
  const hits = await settled(
    slugs.flatMap((s) => [
      atsOne(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, "greenhouse", (j) => {
        const jobs = (j as { jobs?: Array<{ title?: string; absolute_url?: string; location?: { name?: string }; updated_at?: string }> }).jobs ?? [];
        return jobs.slice(0, 30).map((x) => ({
          title: x.title ?? "",
          url: x.absolute_url ?? "",
          snippet: x.location?.name ?? "",
          date: x.updated_at,
          source: "greenhouse",
        }));
      }),
      atsOne(`https://api.lever.co/v0/postings/${s}?mode=json`, "lever", (j) => {
        const jobs = Array.isArray(j) ? (j as Array<{ text?: string; hostedUrl?: string; categories?: { location?: string }; createdAt?: number }>) : [];
        return jobs.slice(0, 30).map((x) => ({
          title: x.text ?? "",
          url: x.hostedUrl ?? "",
          snippet: x.categories?.location ?? "",
          date: x.createdAt ? new Date(x.createdAt).toISOString() : undefined,
          source: "lever",
        }));
      }),
      atsOne(`https://api.ashbyhq.com/posting-api/job-board/${s}`, "ashby", (j) => {
        const jobs = (j as { jobs?: Array<{ title?: string; jobUrl?: string; location?: string; publishedDate?: string }> }).jobs ?? [];
        return jobs.slice(0, 30).map((x) => ({
          title: x.title ?? "",
          url: x.jobUrl ?? "",
          snippet: x.location ?? "",
          date: x.publishedDate,
          source: "ashby",
        }));
      }),
      atsOne(`https://api.smartrecruiters.com/v1/companies/${s}/postings`, "smartrecruiters", (j) => {
        const jobs = (j as { content?: Array<{ name?: string; releasedDate?: string; ref?: string; location?: { city?: string } }> }).content ?? [];
        return jobs.slice(0, 30).map((x) => ({
          title: x.name ?? "",
          url: x.ref ? `https://jobs.smartrecruiters.com/${s}/${x.ref}` : "",
          snippet: x.location?.city ?? "",
          date: x.releasedDate,
          source: "smartrecruiters",
        }));
      }),
    ]),
  );
  return hits;
}

export async function remoteOk(company: string): Promise<SourceHit[]> {
  const j = await getJson<Array<Record<string, unknown>>>("https://remoteok.com/api", 10000);
  if (!Array.isArray(j)) return [];
  const t = tokens(company);
  return j.slice(1, 80).filter((row) => {
    const blob = `${row.company ?? ""} ${row.position ?? ""}`.toLowerCase();
    return t.some((x) => blob.includes(x));
  }).slice(0, 15).map((row) => ({
    title: `${row.position} · ${row.company}`,
    url: String(row.url ?? row.apply_url ?? ""),
    snippet: String(row.location ?? "remote"),
    date: row.date ? String(row.date) : undefined,
    source: "remoteok",
  }));
}

export async function secSearch(entity: string, forms: string, q?: string): Promise<SourceHit[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 180 * 86400000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const query = q ? `${q} AND "${entity}"` : `"${entity}"`;
  const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}&forms=${encodeURIComponent(forms)}&dateRange=custom&startdt=${iso(start)}&enddt=${iso(end)}`;
  const j = await getJson<{ hits?: { hits?: Array<{ _id?: string; _source?: { display_names?: string[]; form?: string; file_date?: string; adsh?: string; file_description?: string; items?: string[] } }> } }>(url);
  const out: SourceHit[] = [];
  for (const h of j?.hits?.hits ?? []) {
    const s = h._source ?? {};
    const names = (s.display_names ?? []).join(" ");
    if (!nameLock(names, entity) && !nameLock(`${names} ${s.file_description}`, entity)) continue;
    const adsh = (s.adsh ?? "").replace(/-/g, "");
    out.push({
      title: `${names.split(" (")[0]} · ${s.form} ${s.file_description ?? ""}`.trim(),
      url: s.adsh ? `https://www.sec.gov/Archives/edgar/data/${(s as { ciks?: string[] }).ciks?.[0]?.replace(/^0+/, "")}/${adsh}/${s.adsh}-index.html` : "https://www.sec.gov/edgar/search/",
      snippet: `filed ${s.file_date ?? ""} items ${(s.items ?? []).join(", ")}`,
      date: s.file_date,
      source: "sec-edgar",
    });
  }
  return out;
}

function lockHits(entity: string, rows: SourceHit[]): SourceHit[] {
  return rows.filter((r) => {
    if (r.source === "wikipedia-pageviews" || r.source === "intent-score") return true;
    return nameLock(`${r.title} ${r.snippet} ${r.url}`, entity);
  });
}

/** Topic intent: volume spike across news, research, wiki, HN, GitHub — not a paid intent pixel. */
export async function intentHits(entity: string, topic: string): Promise<SourceHit[]> {
  const q = `"${entity}" ${topic}`;
  const rows = lockHits(
    entity,
    await settled([
      googleNews(q),
      bingNews(q),
      hnSearch(q),
      redditSearch(q),
      gdeltArt(q),
      openAlex(q),
      crossrefWorks(q),
      githubSearch(`${entity} ${topic}`),
      wikiViews(entity),
      serp(q),
      googleNews(`site:prnewswire.com OR site:globenewswire.com ${q}`),
    ]),
  );
  const newsN = rows.filter((r) => /news|gdelt|hacker-news|reddit/.test(r.source)).length;
  const researchN = rows.filter((r) => /openalex|crossref|github/.test(r.source)).length;
  const wikiSpike = rows.some((r) => r.source === "wikipedia-pageviews" && r.spike);
  const spike = wikiSpike || newsN >= 8 || (newsN >= 3 && researchN >= 3);
  const scored = rows.map((r) => ({
    ...r,
    score: newsN + researchN,
    spike: r.source === "wikipedia-pageviews" ? !!r.spike : false,
  }));
  if (spike) {
    scored.unshift({
      title: `Intent ${wikiSpike ? "spike" : "heat"}: ${entity} × ${topic} · ${newsN} news + ${researchN} research`,
      url: "",
      snippet: wikiSpike ? "Wikipedia traffic jumped vs prior week" : "Multi-source volume above baseline",
      source: "intent-score",
      score: newsN + researchN,
      spike: true,
    });
  }
  return scored;
}

export async function peopleMoveHits(entity: string, extra: string): Promise<SourceHit[]> {
  const q = `"${entity}" (${extra})`;
  return lockHits(
    entity,
    await settled([
      googleNews(q),
      bingNews(q),
      hnSearch(q),
      serp(q),
      gdeltArt(q),
      secSearch(entity, "8-K", extra.split(" OR ")[0]?.replace(/"/g, "") || "appointed"),
      googleNews(`site:prnewswire.com ${q}`),
    ]),
  );
}

export async function jobHits(entity: string): Promise<SourceHit[]> {
  return lockHits(
    entity,
    await settled([
      linkedInJobs(entity),
      jobsApi(entity),
      atsJobs(entity),
      remoteOk(entity),
      googleNews(`"${entity}" (hiring OR "we're hiring" OR "open roles")`),
    ]),
  );
}

export async function fundingHits(entity: string): Promise<SourceHit[]> {
  const q = `"${entity}" (raised OR funding OR "series A" OR "series B" OR acquisition OR IPO OR valuation OR "closes round")`;
  return lockHits(
    entity,
    await settled([
      googleNews(q),
      bingNews(q),
      hnSearch(q),
      gdeltArt(q),
      serp(q),
      secSearch(entity, "D,S-1,424B4,8-K", "offering OR raised OR underwritten"),
      googleNews(`site:techcrunch.com OR site:crunchbase.com ${q}`),
    ]),
  );
}

