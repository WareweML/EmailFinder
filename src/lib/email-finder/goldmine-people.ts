/**
 * Lead goldmines: org-chart / professional-graph sources
 * (TheOrg-class, not random directories). Query is whatever the user typed.
 */

import { isPlausibleName, type DecodoHit } from "./decodo-serp";

export type MineHit = DecodoHit & { source: string };

function slugify(name: string, url: string): string {
  const m = url.match(/https?:\/\/[^/]+\/([a-zA-Z0-9_\-/%]+)/);
  if (m) return m[1]!.replace(/\//g, "-").slice(0, 60);
  return name.toLowerCase().replace(/[^a-z]+/g, "-").slice(0, 48);
}

function fromSerpTitle(title: string, url: string, source: string, snippet?: string): MineHit | null {
  const stop =
    /^(meet|our|the|home|about|leadership|executive|chief|upcoming|definition|wikipedia|company|team|view|search|events|senior|position)$/i;
  const head = title
    .replace(/\s*[\|–-]\s*(Clutch|G2|Comparably|ZoomInfo|Crunchbase|LinkedIn|North Data|Xing).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const bits = head.split(/\s*[-–|•@]\s*/);
  const name = (bits[0] ?? "").trim();
  if (isPlausibleName(name) && !stop.test(name.split(/\s+/)[0] ?? "")) {
    return {
      name,
      title: bits.slice(1).join(" - ").trim() || undefined,
      slug: slugify(name, url),
      url: url.split("?")[0]!,
      source,
    };
  }
  const blob = `${title} ${snippet ?? ""}`;
  const m = blob.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3})\b(?:\s*[,–-]\s*|\s+is\s+|\s+as\s+)([A-Z][A-Za-z /&-]{3,40})/,
  );
  if (m && isPlausibleName(m[1]!) && !stop.test(m[1]!.split(/\s+/)[0] ?? "")) {
    return {
      name: m[1]!,
      title: m[2],
      slug: slugify(m[1]!, url),
      url: url.split("?")[0]!,
      source,
    };
  }
  return null;
}

async function xray(site: string, q: string, source: string, extra: string[] = []): Promise<MineHit[]> {
  if (!q && !extra.length) return [];
  try {
    const { decodoShards } = await import("./decodo-serp");
    const queries = [
      site ? `site:${site} "${q}"` : `"${q}"`,
      ...extra.map((e) => (site ? `site:${site} ${e}` : e)),
    ].filter((s) => s.length > 8);
    const pages = await decodoShards(queries.slice(0, 6));
    const out: MineHit[] = [];
    const seen = new Set<string>();
    for (const rows of pages) {
      for (const row of rows) {
        const url = row.link ?? "";
        if (site && !url.toLowerCase().includes(site.split("/")[0]!)) continue;
        const h = fromSerpTitle(row.title ?? "", url, source, row.description);
        if (!h || seen.has(h.slug)) continue;
        seen.add(h.slug);
        out.push(h);
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function wikidataPeople(q: string): Promise<MineHit[]> {
  if (q.length < 3) return [];
  try {
    const search = await fetch(
      "https://www.wikidata.org/w/api.php?action=wbsearchentities&language=en&type=item&limit=8&format=json&search=" +
        encodeURIComponent(q),
      {
        signal: AbortSignal.timeout(8_000),
        headers: { "User-Agent": "Mailgraph/1.0 (contact@mailgraph.local)" },
      },
    );
    if (!search.ok) return [];
    const sj = (await search.json()) as {
      search?: Array<{ id: string; label: string; description?: string }>;
    };
    const occ = (sj.search ?? []).find((x) =>
      /occupation|profession|position|executive|manager|officer|director/i.test(
        x.description ?? "",
      ),
    );
    const id = occ?.id ?? sj.search?.[0]?.id;
    if (!id) return [];
    const sparql = `SELECT ?person ?personLabel ?occLabel WHERE {
      ?person wdt:P31 wd:Q5.
      ?person wdt:P106 wd:${id}.
      OPTIONAL { wd:${id} rdfs:label ?occLabel. FILTER(LANG(?occLabel)="en") }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } LIMIT 80`;
    const res = await fetch(
      "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql),
      {
        signal: AbortSignal.timeout(12_000),
        headers: {
          Accept: "application/json",
          "User-Agent": "Mailgraph/1.0 (contact@mailgraph.local)",
        },
      },
    );
    if (!res.ok) return [];
    const j = (await res.json()) as {
      results?: {
        bindings?: Array<{
          person?: { value: string };
          personLabel?: { value: string };
          occLabel?: { value: string };
        }>;
      };
    };
    const out: MineHit[] = [];
    for (const b of j.results?.bindings ?? []) {
      const name = b.personLabel?.value ?? "";
      if (!isPlausibleName(name)) continue;
      const qid = (b.person?.value ?? "").split("/").pop() ?? name;
      out.push({
        name,
        title: b.occLabel?.value || occ?.label,
        slug: `wd-${qid}`,
        url: b.person?.value ?? `https://www.wikidata.org/wiki/${qid}`,
        source: "wikidata",
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function goldminePeople(opts: {
  keywords?: string;
  title?: string;
  geo?: string;
  industry?: string;
}): Promise<MineHit[]> {
  const q = (opts.title || opts.keywords || opts.industry || opts.geo || "").trim();
  if (q.length < 2) return [];
  const geo = opts.geo ?? "";
  const packs = await Promise.all([
    wikidataPeople(q),
    xray(
      "",
      q,
      "team-page",
      [
        `intitle:"meet the team" "${q}" ${geo}`.trim(),
        `intitle:"our team" "${q}" ${geo}`.trim(),
        `intitle:leadership "${q}" ${geo}`.trim(),
        `"our leadership" "${q}" ${geo}`.trim(),
      ],
    ),
    xray("clutch.co", q, "clutch"),
    xray("comparably.com", q, "comparably"),
    xray("g2.com", q, "g2"),
    xray("northdata.com", q, "northdata"),
    xray("xing.com/profile", q, "xing"),
    xray("zoominfo.com/pic", q, "zoominfo-org"),
    xray("rocketreach.co", `${q} org chart`, "rocketreach-org"),
    xray("openinsider.com", q, "openinsider"),
  ]);
  const seen = new Set<string>();
  const out: MineHit[] = [];
  for (const pack of packs) {
    for (const h of pack) {
      const key = h.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(h);
    }
  }
  return out;
}
