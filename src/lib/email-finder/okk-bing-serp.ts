/**
 * Okk residential → Chromium → Bing.
 * Curl/HTTP through the same proxy gets a soft-block SERP. A real browser does not.
 * Decode Bing ck/a `u=a1` + base64 to the LinkedIn URL.
 */

const CONFIG_URL = process.env.OKK_PROXY_CONFIG_URL_BING ?? process.env.OKK_PROXY_CONFIG_URL ?? "";

type ProxyAuth = {
  server: string;
  username: string;
  password: string;
};

let cached: { at: number; proxy: ProxyAuth; session: string } | null = null;

/** 30 min sticky — captcha solve and the search GET must share one exit IP. */
const STICKY_MIN = Number(process.env.OKK_STICKY_MINUTES ?? 30);

function stickyUser(baseUser: string, session: string): string {
  const clean = baseUser
    .replace(/-session-[a-zA-Z0-9]+/g, "")
    .replace(/-sessiontime-\d+/g, "")
    .replace(/-sessionduration-\d+/g, "");
  return `${clean}-session-${session}-sessiontime-${STICKY_MIN}`;
}

function parseConfig(text: string): Omit<ProxyAuth, "username"> & { username: string } | null {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.includes(":") && !l.startsWith("#"));
  if (!line) return null;
  const parts = line.split(":");
  if (parts.length < 4) return null;
  const [host, port, username, ...rest] = parts;
  if (!host || !port || !username) return null;
  return {
    server: `http://${host}:${port}`,
    username,
    password: rest.join(":"),
  };
}

export async function loadOkkProxy(): Promise<ProxyAuth | null> {
  if (!CONFIG_URL) return cached?.proxy ?? null;
  const ttl = (STICKY_MIN - 2) * 60_000;
  if (cached && Date.now() - cached.at < ttl) return cached.proxy;
  try {
    const res = await fetch(CONFIG_URL, {
      signal: AbortSignal.timeout(4000),
      headers: { Accept: "text/plain" },
    });
    if (!res.ok) return cached?.proxy ?? null;
    const parsed = parseConfig(await res.text());
    if (!parsed) return cached?.proxy ?? null;
    const session = cached?.session ?? `mg${Date.now().toString(36)}`;
    const proxy: ProxyAuth = {
      ...parsed,
      username: stickyUser(parsed.username, session),
    };
    cached = { at: Date.now(), proxy, session };
    return proxy;
  } catch {
    return cached?.proxy ?? null;
  }
}

export function decodeBingTarget(href: string): string | null {
  const m = href.match(/[?&]u=a1([^&]+)/i);
  if (!m) {
    if (/linkedin\.com\/in\//i.test(href)) return href;
    return null;
  }
  try {
    return Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return null;
  }
}

export type BingHit = {
  name: string;
  title?: string;
  slug: string;
  url: string;
};

function hitFromTitle(text: string, target: string, company: string): BingHit | null {
  const slugM = target.match(/linkedin\.com\/in\/([a-zA-Z0-9_%\-]+)/i);
  if (!slugM) return null;
  const slug = decodeURIComponent(slugM[1]!);
  const head = text
    .replace(/\s*[|\-–]\s*LinkedIn.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const bits = head.split(/\s*[-–|]\s*/);
  const name = (bits[0] ?? "").trim();
  if (name.split(/\s+/).length < 2) return null;
  const brand = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let title = bits.slice(1).join(" - ").replace(new RegExp(brand, "ig"), "").trim();
  title = title.replace(/\s+at\s*$/i, "").replace(/\s*[-–]\s*$/, "").trim();
  return {
    name,
    title: title || undefined,
    slug,
    url: `https://www.linkedin.com/in/${slug}/`,
  };
}

export async function okkBingShards(
  queries: string[],
  company: string,
): Promise<BingHit[]> {
  const proxy = await loadOkkProxy();
  if (!proxy) return [];
  const { chromium } = await import("playwright");
  const farm = process.env.BROWSERLESS_WS?.trim();
  const browser = farm
    ? await chromium.connect(farm, { timeout: 20_000 })
    : await chromium.launch({
        headless: true,
        proxy: {
          server: proxy.server,
          username: proxy.username,
          password: proxy.password,
        },
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
      });

  const width = Math.max(
    1,
    Math.min(
      queries.length,
      Number(process.env.BROWSER_FARM_CONCURRENCY ?? (farm ? 20 : 1)) || 1,
    ),
  );
  const out: BingHit[] = [];
  const seen = new Set<string>();
  let i = 0;
  try {
    await Promise.all(
      Array.from({ length: width }, async () => {
        while (i < queries.length) {
          const q = queries[i++]!;
          try {
            const ctx = await browser.newContext({
              userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
              locale: "en-US",
              ...(farm
                ? {
                    proxy: {
                      server: proxy.server,
                      username: proxy.username,
                      password: proxy.password,
                    },
                  }
                : {}),
            });
            const page = await ctx.newPage();
            await page.goto(
              "https://www.bing.com/search?count=10&q=" +
                encodeURIComponent(q),
              { waitUntil: "domcontentloaded", timeout: 25000 },
            );
            await page.waitForTimeout(600);
            const rows = await page.evaluate(() =>
              [...document.querySelectorAll("li.b_algo, .b_algo")].map((el) => {
                const a = el.querySelector("h2 a");
                return {
                  text: a?.textContent ?? "",
                  href: (a as HTMLAnchorElement | null)?.href ?? "",
                };
              }),
            );
            await ctx.close();
            for (const row of rows) {
              const target = decodeBingTarget(row.href);
              if (!target) continue;
              const hit = hitFromTitle(row.text, target, company);
              if (!hit || seen.has(hit.slug)) continue;
              seen.add(hit.slug);
              out.push(hit);
            }
          } catch {
            /* next shard */
          }
        }
      }),
    );
  } finally {
    await browser.close();
  }
  return out;
}
