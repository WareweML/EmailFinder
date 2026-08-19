/**
 * Decodo Fast Search — they rotate residential/ISP exits per request.
 * We never see their IPs. One POST = top 10 Google organic, ~1–2s.
 */

const ENDPOINT = "https://fastsearch.decodo.com/v0/search";

const AUTH = process.env.DECODO_BASIC_AUTH ?? "";

export type DecodoHit = {
  name: string;
  title?: string;
  slug: string;
  url: string;
};

type Organic = {
  link?: string;
  title?: string;
  description?: string;
};

export async function decodoSearch(query: string): Promise<Organic[]> {
  if (!AUTH) return [];
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(9000),
      headers: {
        Accept: "application/json",
        Authorization: AUTH,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { organic?: Organic[] };
    return Array.isArray(data.organic) ? data.organic : [];
  } catch {
    return [];
  }
}

export async function decodoShards(queries: string[]): Promise<Organic[][]> {
  return Promise.all(queries.map((q) => decodoSearch(q)));
}

export function peopleFromOrganic(
  rows: Organic[],
  companyName: string,
): DecodoHit[] {
  const out: DecodoHit[] = [];
  const seen = new Set<string>();
  const brand = companyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const brandRe = new RegExp(brand, "i");

  for (const row of rows) {
    const url = row.link ?? "";
    const slugM = url.match(/linkedin\.com\/in\/([a-zA-Z0-9_%\-]+)/i);
    if (!slugM) continue;
    const slug = decodeURIComponent(slugM[1]!);
    if (seen.has(slug)) continue;

    const head = (row.title ?? "")
      .replace(/\s*\|\s*LinkedIn.*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    const bits = head.split(/\s*[-–|]\s*/);
    const name = (bits[0] ?? "").trim();
    if (name.split(/\s+/).length < 2) continue;
    if (/\b(former|ex-|previously|alumni)\b/i.test(head)) continue;

    let title = bits.slice(1).join(" - ").replace(brandRe, "").trim();
    title = title.replace(/\s+at\s*$/i, "").replace(/\s*[-–]\s*$/, "").trim();
    if (!title && row.description) {
      const d = row.description.replace(/\s+/g, " ");
      const m =
        d.match(
          new RegExp(
            `([A-Z][^·|]{4,80}?)\\s+at\\s+${brand}`,
            "i",
          ),
        ) ?? d.match(/^([^·]{4,80}?)\s+·/);
      if (m) title = m[1]!.replace(brandRe, "").trim();
    }

    seen.add(slug);
    out.push({ name, title: title || undefined, slug, url });
  }
  return out;
}
