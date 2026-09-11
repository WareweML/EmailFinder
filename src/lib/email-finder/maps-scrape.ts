/**
 * Live Google Maps cards. One query ~120 max — we grid the viewport and
 * search each cell until `limit` unique places or the area is empty.
 */
import type { MapsLead } from "./maps-leads";
import type { Page, Browser } from "playwright";

function hostOf(url?: string): string | undefined {
  if (!url) return;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return;
  }
}

function placeId(href: string): string {
  return (
    href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i)?.[1]?.toLowerCase() ||
    href.split("?")[0] ||
    href
  );
}

function parseCard(raw: {
  name: string;
  href: string;
  text: string;
  website?: string;
}): MapsLead | null {
  const name = raw.name.split("|")[0]!.replace(/\s+/g, " ").trim();
  if (!name || name.length < 2) return null;
  const t = raw.text.replace(/\s+/g, " ");
  const rr = t.match(
    /\b([1-5]\.\d)\b(?:\s*\(|\s+)([0-9]{1,3}(?:,[0-9]{3})*|[0-9]{2,5})\b/,
  );
  const rating = rr ? Number(rr[1]) : Number(t.match(/\b([1-5]\.\d)\b/)?.[1] ?? "") || undefined;
  const reviews = rr ? Number(rr[2]!.replace(/,/g, "")) : undefined;
  const phone = t.match(/\+91[\s-]?\d[\d\s-]{8,14}\d/)?.[0]?.replace(/\s+/g, " ");
  const bits = t.split("·").map((s) => s.trim()).filter(Boolean);
  let address =
    bits.find((b) =>
      /\d/.test(b) && /sector|road|rd|floor|block|near|plot|mall|gurgaon|gurugram/i.test(b),
    ) ||
    bits.find(
      (b) =>
        b.length > 18 &&
        /\d/.test(b) &&
        !/open|closes|website|directions|book|dental clinic/i.test(b),
    ) ||
    "";
  if (address.toLowerCase().startsWith(name.toLowerCase().slice(0, 12))) address = "";
  const website = raw.website && /instagram|facebook|youtube|wa\.me/.test(raw.website)
    ? undefined
    : raw.website?.split("?")[0];
  const category =
    bits.find((b) => /clinic|dentist|hospital|restaurant|bank|store|school/i.test(b)) ||
    "business";
  const lat = Number(raw.href.match(/!3d(-?\d+\.\d+)/)?.[1] ?? "") || undefined;
  const lng = Number(raw.href.match(/!4d(-?\d+\.\d+)/)?.[1] ?? "") || undefined;
  return {
    name,
    category: category.replace(/[^\w\s&-]/g, " ").replace(/\s+/g, " ").trim(),
    address: address.slice(0, 160),
    phone,
    website,
    domain: hostOf(website),
    lat,
    lng,
    rating,
    reviews,
    mapsUrl: raw.href.split("?")[0],
    importance: rating ? rating / 5 : 0.3,
    source: "maps",
  };
}

type Geo = {
  lat: number;
  lng: number;
  box?: { s: number; n: number; w: number; e: number };
};

function grid(geo: Geo, cells: number): Array<{ lat: number; lng: number; z: number }> {
  const box = geo.box ?? {
    s: geo.lat - 0.08,
    n: geo.lat + 0.08,
    w: geo.lng - 0.1,
    e: geo.lng + 0.1,
  };
  const side = Math.max(3, Math.ceil(Math.sqrt(cells)));
  const out: Array<{ lat: number; lng: number; z: number }> = [];
  const dLat = box.n - box.s;
  const dLng = box.e - box.w;
  const z = dLat < 0.05 ? 17 : dLat < 0.15 ? 16 : 15;
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      out.push({
        lat: box.s + (dLat * (i + 0.5)) / side,
        lng: box.w + (dLng * (j + 0.5)) / side,
        z,
      });
    }
  }
  return out;
}

async function extract(page: Page): Promise<MapsLead[]> {
  const raw = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("a[href*='/maps/place/']")];
    const seen = new Set<string>();
    const out: Array<{ name: string; href: string; text: string; website?: string }> = [];
    for (const a of cards) {
      const href = (a as HTMLAnchorElement).href;
      const key = href.split("?")[0]!;
      if (seen.has(key) || !/\/maps\/place\//.test(key)) continue;
      seen.add(key);
      const card = a.closest(".Nv2PK") || a.parentElement;
      const nameEl = card?.querySelector(".qBF1Pd, .fontHeadlineSmall");
      const name =
        (nameEl as HTMLElement | null)?.innerText?.trim() ||
        decodeURIComponent(key.split("/maps/place/")[1]?.split("/")[0] || "").replace(/\+/g, " ");
      const site = (
        card?.querySelector(
          "a[data-value='Website'], a[aria-label*='Website' i], a[href^='http']:not([href*='google.'])",
        ) as HTMLAnchorElement | null
      )?.href;
      out.push({
        name,
        href: key,
        text: (card as HTMLElement | null)?.innerText || "",
        website: site || undefined,
      });
    }
    return out;
  });
  return raw.map(parseCard).filter((x): x is MapsLead => !!x);
}

async function scrollFeed(page: Page, want: number) {
  const feed = page.locator('[role="feed"]');
  let last = 0;
  let stagnant = 0;
  for (let i = 0; i < 18 && stagnant < 2; i++) {
    const n = await page.locator("a[href*='/maps/place/']").count();
    if (n >= want) break;
    if (n === last) stagnant++;
    else stagnant = 0;
    last = n;
    await feed.evaluate((el) => el.scrollBy(0, el.scrollHeight)).catch(async () => {
      await page.mouse.wheel(0, 2200);
    });
    await page.waitForTimeout(400);
  }
}

async function harvestAt(
  page: Page,
  url: string,
  want: number,
): Promise<MapsLead[]> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 28_000 });
  try {
    await page.waitForSelector("a[href*='/maps/place/']", { timeout: 12_000 });
  } catch {
    return [];
  }
  const searchArea = page.getByRole("button", { name: /search this area/i });
  if (await searchArea.isVisible().catch(() => false)) {
    await searchArea.click().catch(() => {});
    await page.waitForTimeout(1200);
  }
  await scrollFeed(page, Math.min(want, 120));
  return extract(page);
}

export async function scrapeGoogleMaps(
  query: string,
  limit: number,
  geo?: Geo,
): Promise<MapsLead[]> {
  const { chromium } = await import("playwright");
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const bag = new Map<string, MapsLead>();
  const addAll = (rows: MapsLead[]) => {
    for (const r of rows) {
      const id = placeId(r.mapsUrl || r.name);
      if (!bag.has(id)) bag.set(id, r);
      if (bag.size >= limit) break;
    }
  };

  const ctx = async () =>
    browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-IN",
    });

  try {
    const q = encodeURIComponent(query);
    const first = await ctx();
    const seed = await harvestAt(
      first,
      `https://www.google.com/maps/search/${q}`,
      Math.min(limit, 120),
    );
    addAll(seed);

    let center = geo;
    const here = first.url();
    const at = here.match(/@(-?\d+\.\d+),(-?\d+\.\d+),(\d+)/);
    if (at) {
      const lat = Number(at[1]);
      const lng = Number(at[2]);
      center = center ?? { lat, lng };
      if (!center.box) {
        const span = 0.09;
        center.box = { s: lat - span, n: lat + span, w: lng - span * 1.2, e: lng + span * 1.2 };
      }
    }
    await first.close().catch(() => {});

    if (bag.size >= limit || !center || limit <= 20) {
      return [...bag.values()].slice(0, limit);
    }

    const cells = Math.min(81, Math.max(9, Math.ceil(limit / 18)));
    const points = grid(center, cells);
    let i = 0;
    const width = Math.min(4, points.length);
    await Promise.all(
      Array.from({ length: width }, async () => {
        const page = await ctx();
        try {
          while (i < points.length && bag.size < limit) {
            const idx = i++;
            const p = points[idx]!;
            const url = `https://www.google.com/maps/search/${q}/@${p.lat.toFixed(5)},${p.lng.toFixed(5)},${p.z}z`;
            try {
              const rows = await harvestAt(page, url, 80);
              addAll(rows);
            } catch {
              /* cell empty / timeout */
            }
          }
        } finally {
          await page.close().catch(() => {});
        }
      }),
    );
    return [...bag.values()].slice(0, limit);
  } finally {
    await browser.close().catch(() => {});
  }
}
