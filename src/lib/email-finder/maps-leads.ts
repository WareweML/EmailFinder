import { UNIQUE_MAPS_TYPES } from "./maps-types";

export type MapsLead = {
  name: string;
  category: string;
  address: string;
  city?: string;
  phone?: string;
  website?: string;
  domain?: string;
  lat?: number;
  lng?: number;
  rating?: number;
  reviews?: number;
  mapsUrl?: string;
  importance?: number;
  distanceKm?: number;
  source: "osm" | "web" | "maps";
};

export type MapsSearchInput = {
  mode: "text" | "types";
  query?: string;
  location: string;
  includeTypes?: string[];
  excludeTypes?: string[];
  rank?: "popularity" | "distance";
  limit?: number;
};

type NomHit = {
  name?: string;
  display_name?: string;
  lat?: string;
  lon?: string;
  type?: string;
  class?: string;
  importance?: number;
  boundingbox?: string[];
  extratags?: Record<string, string>;
  address?: Record<string, string>;
};

const UA = "Mailgraph/1.0 contact@warewe.com";

function hostOf(url?: string): string | undefined {
  if (!url) return;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return;
  }
}

async function nominatim(params: Record<string, string>): Promise<NomHit[]> {
  const qs = new URLSearchParams({
    format: "jsonv2",
    addressdetails: "1",
    extratags: "1",
    namedetails: "1",
    limit: "50",
    ...params,
  });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${qs}`, {
    signal: AbortSignal.timeout(12_000),
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) return [];
  const j = (await res.json()) as NomHit[];
  return Array.isArray(j) ? j : [];
}

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function toLead(h: NomHit, origin?: { lat: number; lng: number }): MapsLead | null {
  const name = (h.name || h.display_name?.split(",")[0] || "").trim();
  if (!name || name.length < 2) return null;
  const tags = h.extratags ?? {};
  const website = tags.website || tags["contact:website"] || tags.url;
  const phone = tags.phone || tags["contact:phone"] || tags["contact:mobile"];
  const addr = h.address ?? {};
  const street = [addr.house_number, addr.road].filter(Boolean).join(" ");
  const city = addr.city || addr.town || addr.village || addr.suburb;
  const address =
    [street, city, addr.state, addr.postcode].filter(Boolean).join(", ") ||
    (h.display_name ?? "");
  const lat = h.lat ? Number(h.lat) : undefined;
  const lng = h.lon ? Number(h.lon) : undefined;
  const category = (h.type || h.class || "business").replace(/_/g, " ");
  return {
    name,
    category,
    address,
    city,
    phone,
    website,
    domain: hostOf(website),
    lat,
    lng,
    importance: h.importance,
    distanceKm:
      origin && lat != null && lng != null
        ? haversine(origin, { lat, lng })
        : undefined,
    source: "osm",
  };
}

function typeLabel(id: string): string {
  return UNIQUE_MAPS_TYPES.find((t) => t.id === id)?.label ?? id.replace(/_/g, " ");
}

const JUNK_WEB =
  /(wikipedia|facebook|instagram|yelp|tripadvisor|yellowpages|linkedin|reddit|youtube|tiktok|pinterest|timeout\.com|eater\.com|thrillist|opendata|foursquare)\./i;

function gridPoints(
  box: { s: number; n: number; w: number; e: number },
  cells: number,
): Array<{ lat: number; lng: number }> {
  const side = Math.max(2, Math.ceil(Math.sqrt(cells)));
  const out: Array<{ lat: number; lng: number }> = [];
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      out.push({
        lat: box.s + ((box.n - box.s) * (i + 0.5)) / side,
        lng: box.w + ((box.e - box.w) * (j + 0.5)) / side,
      });
    }
  }
  return out;
}

function organicToLead(
  row: { title?: string; link?: string; description?: string },
  category: string,
  locTokens: string[],
): MapsLead | null {
  const title = (row.title ?? "")
    .replace(/\s*[|\-–]\s*(Yelp|Tripadvisor|Facebook|LinkedIn|Wikipedia).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title || title.length < 3) return null;
  if (/^(the\s+)?\d+\s+best\b/i.test(title)) return null;
  if (/\b(locator|atm and branches|branch network|directory|list of)\b/i.test(title)) {
    return null;
  }
  const blob = `${title} ${row.description ?? ""} ${row.link ?? ""}`.toLowerCase();
  if (locTokens.length && !locTokens.some((t) => blob.includes(t))) return null;
  const host = hostOf(row.link);
  if (host && JUNK_WEB.test(host)) return null;
  if (host && /mapquest|yellowbook|superpages|bbb\.org/.test(host)) return null;
  const name = title
    .split(/\s+[-–|]\s+/)[0]!
    .replace(/\s+in\s+[A-Z].*$/, "")
    .trim()
    .slice(0, 80);
  if (!name || name.split(/\s+/).length > 8) return null;
  if (/^\d/.test(name)) return null;
  if (/^(atm|atms|banking|locations?|austin|branches?)$/i.test(name)) return null;
  const desc = row.description ?? "";
  const phone = desc.match(
    /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/,
  )?.[0];
  return {
    name,
    category,
    address: desc.split(/[.…]/)[0]?.slice(0, 140) || "",
    phone,
    website: row.link?.split("?")[0],
    domain: host,
    importance: locTokens.filter((t) => blob.includes(t)).length * 0.2,
    source: "web",
  };
}

export async function searchMapsLeads(input: MapsSearchInput): Promise<{
  leads: MapsLead[];
  total: number;
  location: string;
  ms: number;
  detail: string;
}> {
  const t0 = Date.now();
  const loc = input.location.trim();
  if (!loc) {
    return { leads: [], total: 0, location: "", ms: 0, detail: "Location required" };
  }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 2000);
  const include = (input.includeTypes ?? []).filter(Boolean);
  const exclude = new Set((input.excludeTypes ?? []).map((t) => t.toLowerCase()));

  const geoHits = await nominatim({ q: loc, limit: "1" });
  const origin =
    geoHits[0]?.lat && geoHits[0]?.lon
      ? { lat: Number(geoHits[0].lat), lng: Number(geoHits[0].lon) }
      : undefined;
  const bb = geoHits[0]?.boundingbox?.map(Number);
  const box =
    bb && bb.length === 4
      ? { s: bb[0]!, n: bb[1]!, w: bb[2]!, e: bb[3]! }
      : origin
        ? {
            s: origin.lat - 0.18,
            n: origin.lat + 0.18,
            w: origin.lng - 0.22,
            e: origin.lng + 0.22,
          }
        : null;

  const labels: string[] = [];
  if (input.mode === "text") {
    const q = (input.query ?? "").trim();
    if (q) labels.push(q);
    else if (input.includeTypes?.[0]) labels.push(`${typeLabel(input.includeTypes[0])} in ${loc}`);
  } else {
    if (!include.length) {
      return {
        leads: [],
        total: 0,
        location: loc,
        ms: Date.now() - t0,
        detail: "Select at least one business type",
      };
    }
    for (const id of include.slice(0, 3)) labels.push(`${typeLabel(id)} in ${loc}`);
  }
  if (!labels.length) labels.push(`businesses in ${loc}`);

  const bag = new Map<string, MapsLead>();
  const add = (lead: MapsLead | null) => {
    if (!lead) return;
    const key =
      lead.mapsUrl?.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i)?.[1]?.toLowerCase() ||
      lead.mapsUrl ||
      `${lead.name.toLowerCase()}|${lead.address.slice(0, 40)}`;
    if (!bag.has(key) && bag.size < limit) bag.set(key, lead);
  };

  try {
    const { scrapeGoogleMaps } = await import("./maps-scrape");
    const q = labels[0]!;
    const rows = await scrapeGoogleMaps(
      q,
      limit,
      origin
        ? { lat: origin.lat, lng: origin.lng, box: box ?? undefined }
        : undefined,
    );
    for (const r of rows) add(r);
  } catch {
    /* Chromium optional */
  }

  if (bag.size < Math.min(8, limit)) {
    const locTokens = loc
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !/^(the|and|near|usa|united|states)$/.test(w));
    const { decodoSearch } = await import("./decodo-serp");
    const rows = await decodoSearch(`${labels[0]} ${loc}`, 1);
    for (const row of rows) add(organicToLead(row, labels[0]!, locTokens));
    const nom = await nominatim({ q: `${labels[0]} ${loc}`, limit: "50" });
    for (const h of nom) add(toLead(h, origin));
  }

  let leads = [...bag.values()];
  if (input.rank === "distance" && origin) {
    leads.sort((a, b) => (a.distanceKm ?? 9e9) - (b.distanceKm ?? 9e9));
  } else {
    leads.sort(
      (a, b) =>
        (b.reviews ?? 0) * (b.rating ?? 0) - (a.reviews ?? 0) * (a.rating ?? 0) ||
        (b.rating ?? 0) - (a.rating ?? 0) ||
        a.name.localeCompare(b.name),
    );
  }
  leads = leads.slice(0, limit);
  return {
    leads,
    total: leads.length,
    location: loc,
    ms: Date.now() - t0,
    detail: `${leads.length} Google Maps places · ${loc}${leads.length >= limit ? " · cap hit" : ""}`,
  };
}
