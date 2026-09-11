/**
 * Extra live people sources (no personal LinkedIn cookie).
 * Each adapter is independent; failures are swallowed.
 */

import { isPlausibleName, type DecodoHit } from "./decodo-serp";

export type ExtraHit = DecodoHit & { source: string };

function slugFrom(name: string, url: string): string {
  const m = url.match(/\/(in|person|p|u|people)\/([a-zA-Z0-9_\-%]+)/i);
  if (m) return decodeURIComponent(m[2]!);
  return name
    .toLowerCase()
    .replace(/[^a-z]+/g, "-")
    .slice(0, 48);
}

function parseTitleName(title: string, url: string): ExtraHit | null {
  const head = title
    .replace(/\s*[\|–-]\s*(LinkedIn|Crunchbase|RocketReach|ZoomInfo|SignalHire|Wellfound|AngelList|About\.me|Craft).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const bits = head.split(/\s*[-–|•]\s*/);
  const name = (bits[0] ?? "").trim();
  if (!isPlausibleName(name)) return null;
  const rest = bits.slice(1).join(" - ").trim() || undefined;
  return {
    name,
    title: rest,
    slug: slugFrom(name, url),
    url: url.split("?")[0]!,
    source: "web",
  };
}

async function directoryXray(
  site: string,
  q: string,
  source: string,
): Promise<ExtraHit[]> {
  if (!q) return [];
  try {
    const { decodoShards } = await import("./decodo-serp");
    const queries = [
      `site:${site} "${q}"`,
      `site:${site} "${q}" director`,
      `site:${site} "${q}" manager`,
      `site:${site} "${q}" "united states"`,
    ];
    const pages = await decodoShards(queries);
    const out: ExtraHit[] = [];
    const seen = new Set<string>();
    for (const rows of pages) {
      for (const row of rows) {
        const url = row.link ?? "";
        if (!url.toLowerCase().includes(site.split("/")[0]!)) continue;
        const h = parseTitleName(row.title ?? "", url);
        if (!h || seen.has(h.slug)) continue;
        seen.add(h.slug);
        out.push({ ...h, source, url });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function orcidPeople(q: string): Promise<ExtraHit[]> {
  if (!q) return [];
  try {
    const url =
      "https://pub.orcid.org/v3.0/expanded-search/?q=" +
      encodeURIComponent(`keyword:${q}`) +
      "&rows=50";
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      "expanded-result"?: Array<{
        "given-names"?: string;
        "family-names"?: string;
        "orcid-id"?: string;
        "institution-name"?: string[];
      }>;
    };
    const out: ExtraHit[] = [];
    for (const r of j["expanded-result"] ?? []) {
      const name = `${r["given-names"] ?? ""} ${r["family-names"] ?? ""}`.trim();
      if (!isPlausibleName(name)) continue;
      const id = r["orcid-id"] ?? name;
      out.push({
        name,
        title: (r["institution-name"] ?? [])[0],
        slug: `orcid-${id}`,
        url: `https://orcid.org/${id}`,
        source: "orcid",
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function githubPeople(q: string): Promise<ExtraHit[]> {
  if (!q) return [];
  try {
    const res = await fetch(
      `https://api.github.com/search/users?q=${encodeURIComponent(q + " type:user")}&per_page=20`,
      {
        signal: AbortSignal.timeout(8_000),
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Mailgraph",
        },
      },
    );
    if (!res.ok) return [];
    const j = (await res.json()) as { items?: Array<{ login: string; html_url: string; url: string }> };
    const out: ExtraHit[] = [];
    for (const u of (j.items ?? []).slice(0, 12)) {
      try {
        const r = await fetch(u.url, {
          signal: AbortSignal.timeout(5_000),
          headers: { Accept: "application/vnd.github+json", "User-Agent": "Mailgraph" },
        });
        if (!r.ok) continue;
        const p = (await r.json()) as { name?: string; login: string; html_url: string; bio?: string; location?: string };
        const name = (p.name ?? "").trim();
        if (!isPlausibleName(name)) continue;
        out.push({
          name,
          title: p.bio?.slice(0, 80),
          location: p.location,
          slug: `gh-${p.login}`,
          url: p.html_url,
          source: "github",
        });
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function bingLinkedIn(q: string, geo?: string): Promise<ExtraHit[]> {
  if (!q) return [];
  try {
    const { okkBingShards } = await import("./okk-bing-serp");
    const queries = [
      `site:linkedin.com/in "${q}" ${geo ? `"${geo}"` : ""}`,
      `site:linkedin.com/in "${q}" director`,
      `site:linkedin.com/in "${q}" manager`,
      `site:linkedin.com/in "${q}" "vice president"`,
    ];
    const hits = await okkBingShards(queries, q);
    return hits.map((h) => ({ ...h, source: "bing" }));
  } catch {
    return [];
  }
}

async function newsAppointments(q: string, geo?: string): Promise<ExtraHit[]> {
  if (!q) return [];
  try {
    const { decodoShards } = await import("./decodo-serp");
    const pages = await decodoShards([
      `"${q}" (appointed OR named OR "joins as") (director OR VP OR "vice president" OR CMO) ${geo ?? ""}`,
    ]);
    const out: ExtraHit[] = [];
    const seen = new Set<string>();
    for (const rows of pages) {
      for (const row of rows) {
        const h = parseTitleName(row.title ?? "", row.link ?? "");
        if (!h || seen.has(h.slug)) continue;
        seen.add(h.slug);
        out.push({ ...h, source: "news", url: (row.link ?? h.url).split("?")[0]! });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function extraPeople(opts: {
  keywords?: string;
  title?: string;
  geo?: string;
  industry?: string;
}): Promise<ExtraHit[]> {
  const q = (opts.title || opts.keywords || opts.industry || opts.geo || "").trim();
  if (q.length < 2) return [];
  const geo = opts.geo;
  const packs = await Promise.all([
    directoryXray("crunchbase.com/person", q, "crunchbase"),
    directoryXray("rocketreach.co", q, "rocketreach"),
    directoryXray("zoominfo.com/p", q, "zoominfo"),
    directoryXray("signalhire.com", q, "signalhire"),
    directoryXray("wellfound.com/u", q, "wellfound"),
    directoryXray("about.me", q, "aboutme"),
    directoryXray("craft.co", q, "craft"),
    directoryXray("contactout.com", q, "contactout"),
    orcidPeople(q),
    githubPeople(q),
    bingLinkedIn(q, geo),
    newsAppointments(q, geo),
    (await import("./goldmine-people")).goldminePeople({
      keywords: opts.keywords,
      title: opts.title,
      geo: opts.geo,
      industry: opts.industry,
    }),
  ]);
  const seen = new Set<string>();
  const out: ExtraHit[] = [];
  for (const pack of packs) {
    for (const h of pack) {
      const key = h.slug || h.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(h);
    }
  }
  return out;
}
