/**
 * employee_count_by_country from live LinkedIn SERP.
 * Unique current-employee profiles, mapped via snippet Location + li host.
 * Not a people-graph dump — observed coverage of this harvest.
 */

import { decodoSearch, isPlausibleName } from "./decodo-serp";

const LI_HOST: Record<string, string> = {
  ae: "united arab emirates",
  ar: "argentina",
  at: "austria",
  au: "australia",
  be: "belgium",
  bg: "bulgaria",
  br: "brazil",
  ca: "canada",
  ch: "switzerland",
  cl: "chile",
  cn: "china",
  co: "colombia",
  cz: "czech republic",
  de: "germany",
  dk: "denmark",
  es: "spain",
  fi: "finland",
  fr: "france",
  gr: "greece",
  hk: "hong kong",
  hu: "hungary",
  id: "indonesia",
  ie: "ireland",
  il: "israel",
  in: "india",
  it: "italy",
  jp: "japan",
  kr: "south korea",
  mx: "mexico",
  my: "malaysia",
  ng: "nigeria",
  nl: "netherlands",
  no: "norway",
  nz: "new zealand",
  pe: "peru",
  ph: "philippines",
  pk: "pakistan",
  pl: "poland",
  pt: "portugal",
  ro: "romania",
  sa: "saudi arabia",
  se: "sweden",
  sg: "singapore",
  th: "thailand",
  tr: "turkey",
  tw: "taiwan",
  ua: "ukraine",
  uk: "united kingdom",
  ve: "venezuela",
  vn: "vietnam",
  za: "south africa",
};

const US_STATES =
  /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|washington dc)\b/i;

const CA_PROV =
  /\b(ontario|quebec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|prince edward|yukon|nunavut|northwest territories)\b/i;

const CITY: Array<[RegExp, string]> = [
  [/\b(dubai|abu dhabi|sharjah)\b/i, "united arab emirates"],
  [/\b(london, england|manchester, england|edinburgh|glasgow, scotland)\b/i, "united kingdom"],
  [/\b(greater toronto|toronto|vancouver|montreal|calgary|ottawa|richmond hill|markham|mississauga|waterloo)\b/i, "canada"],
  [/\b(san francisco|new york|seattle|austin|chicago|boston|denver|atlanta|ashburn|bay area)\b/i, "united states"],
  [/\b(bengaluru|bangalore|hyderabad|mumbai|chennai|pune|delhi|gurgaon|noida)\b/i, "india"],
  [/\b(paris|lyon|marseille)\b/i, "france"],
  [/\b(madrid|barcelona)\b/i, "spain"],
  [/\b(sydney|melbourne|brisbane)\b/i, "australia"],
  [/\b(berlin|munich|hamburg|frankfurt)\b/i, "germany"],
  [/\b(singapore)\b/i, "singapore"],
];

const COUNTRY_PHRASE: Array<[RegExp, string]> = [
  [/united arab emirates|\buae\b/i, "united arab emirates"],
  [/united kingdom|\bengland\b|\bscotland\b|\bwales\b|\buk\b/i, "united kingdom"],
  [/united states|\busa\b|u\.s\.a?\.?|united stat/i, "united states"],
  [/\bcanada\b/i, "canada"],
  [/\bindia\b/i, "india"],
  [/\bfrance\b/i, "france"],
  [/\bspain\b/i, "spain"],
  [/\bgermany\b/i, "germany"],
  [/\baustralia\b/i, "australia"],
  [/\bireland\b/i, "ireland"],
  [/\bnetherlands\b|\bholland\b/i, "netherlands"],
  [/\bsingapore\b/i, "singapore"],
  [/\bbrazil\b/i, "brazil"],
  [/\bmexico\b/i, "mexico"],
  [/\bjapan\b/i, "japan"],
  [/\bchina\b/i, "china"],
  [/\bisrael\b/i, "israel"],
  [/\bsouth africa\b/i, "south africa"],
];

function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function countryFromPerson(url: string, blob: string): string | null {
  const t = blob.toLowerCase();
  for (const [re, c] of COUNTRY_PHRASE) if (re.test(t)) return c;
  if (US_STATES.test(t) || /,\s*(al|ak|az|ar|ca|co|ct|dc|de|fl|ga|hi|ia|id|il|in|ks|ky|la|ma|md|me|mi|mn|mo|ms|mt|nc|nd|ne|nh|nj|nm|nv|ny|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|va|vt|wa|wi|wv|wy)\b/i.test(blob))
    return "united states";
  if (CA_PROV.test(t)) return "canada";
  for (const [re, c] of CITY) if (re.test(t)) return c;
  const host = url.match(/https?:\/\/([a-z]{2})\.linkedin\.com/i)?.[1]?.toLowerCase();
  if (host && LI_HOST[host]) return LI_HOST[host];
  return null;
}

/** Current employer is this company, not a same-name other org. */
export function sameEmployer(blob: string, name: string, domain: string): boolean {
  const brand = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const n = compact(name);
  const d = domain.replace(/^www\./, "").toLowerCase();
  if (d && blob.toLowerCase().includes(d)) return true;
  if (
    new RegExp(
      `${brand}\\s+(computer|software|fitness|bathroom|solutions|digital|studio|consulting|pvt|private|maroc|holdings|ventures)\\b`,
      "i",
    ).test(blob)
  ) {
    return false;
  }
  const suf = "(?:\\s+(?:AI|Inc|LLC|Ltd|GmbH|PLC|Group|Labs|IO|Technologies|Tech))?";
  const bound = "(?=\\s*[|·,./]|\\s*$|\\s+(?:Location|Experience|Education|University|College|\\d))";
  const mention = new RegExp(`(?:\\bat\\s+|Experience:\\s+|[-–]\\s+)${brand}${suf}${bound}`, "i");
  if (mention.test(blob)) return true;
  const titleCo = (blob.split("|")[0] ?? "")
    .split(/\s*[-–]\s*/)
    .pop()
    ?.trim();
  if (titleCo) {
    const e = compact(titleCo);
    if (e === n || e === n + "ai") return true;
  }
  return false;
}

function hqHost(country?: string | null): string | null {
  const c = (country ?? "").toLowerCase();
  const rev = Object.entries(LI_HOST).find(([, v]) => v === c);
  return rev?.[0] ?? null;
}

export async function employeeCountByCountryLive(opts: {
  name: string;
  domain: string;
  hqCountry?: string | null;
  staff?: number | null;
}): Promise<Record<string, number> | null> {
  const name = opts.name.trim();
  if (name.length < 2) return null;
  const host = hqHost(opts.hqCountry);
  const queries: Array<{ q: string; page?: number }> = [
    { q: `site:linkedin.com/in "at ${name}"`, page: 1 },
    { q: `site:linkedin.com/in "at ${name}"`, page: 2 },
    { q: `site:linkedin.com/in "at ${name}"`, page: 3 },
    { q: `site:linkedin.com/in "${name}" "${opts.domain}"` },
    { q: `site:linkedin.com/in "${name}" (CEO OR CTO OR VP OR Director OR Engineer OR Manager)` },
  ];
  if (host) queries.push({ q: `site:${host}.linkedin.com/in "at ${name}"` });
  if (opts.hqCountry) queries.push({ q: `site:linkedin.com/in "at ${name}" "${opts.hqCountry}"` });

  const pages = await Promise.all(
    queries.map((x) => decodoSearch(x.q, x.page ?? 1).catch(() => [] as Array<{ link?: string; title?: string; description?: string }>)),
  );

  const seen = new Set<string>();
  const counts: Record<string, number> = {};
  for (const row of pages.flat()) {
    const url = (row.link ?? "").split("?")[0] ?? "";
    const slug = url.match(/linkedin\.com\/in\/([a-zA-Z0-9_%\-]+)/i)?.[1];
    if (!slug) continue;
    const key = decodeURIComponent(slug).toLowerCase();
    if (seen.has(key)) continue;
    const blob = `${row.title ?? ""} · ${row.description ?? ""}`;
    const head = (row.title ?? "").replace(/\s*\|\s*LinkedIn.*$/i, "").split(/\s*[-–|]\s*/)[0]?.trim() ?? "";
    if (head && !isPlausibleName(head)) continue;
    if (!sameEmployer(blob, name, opts.domain)) continue;
    seen.add(key);
    const country = countryFromPerson(url, blob) ?? (opts.hqCountry ? opts.hqCountry.toLowerCase() : null);
    if (!country) continue;
    counts[country] = (counts[country] ?? 0) + 1;
  }
  if (!Object.keys(counts).length) return null;
  return counts;
}
