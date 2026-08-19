/**
 * Resilient public-web fetch for research hops.
 * Failures are normal (403/429/auth walls) — rotate UA, retry, try www/http,
 * never soft-quit after one Chrome UA and a shrug.
 */

export const BROWSER_UAS = [
  // Current desktop Chrome/Firefox/Safari
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  // Mobile
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
  // Indexer-style UAs — many public CMS/registry pages serve fuller HTML to crawlers
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "Mozilla/5.0 (compatible; MailgraphResearch/2.0; +https://mailgraph.app)",
];

export interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
  url: string;
  ua: string;
  attempts: number;
}

function pickUa(seed?: number): string {
  const i =
    typeof seed === "number"
      ? Math.abs(seed) % BROWSER_UAS.length
      : Math.floor(Math.random() * BROWSER_UAS.length);
  return BROWSER_UAS[i]!;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Single attempt with explicit UA. */
async function attemptOnce(
  url: string,
  ua: string,
  timeoutMs: number,
): Promise<FetchResult> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: c.signal,
      redirect: "follow",
      headers: {
        "User-Agent": ua,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "Upgrade-Insecure-Requests": "1",
        // Look like a real navigation when not a bot UA
        ...(ua.includes("bot") || ua.includes("Googlebot")
          ? {}
          : {
              "Sec-Fetch-Dest": "document",
              "Sec-Fetch-Mode": "navigate",
              "Sec-Fetch-Site": "none",
              "Sec-Fetch-User": "?1",
            }),
      },
    });
    const body = await res.text();
    return {
      ok: res.ok && body.length > 80,
      status: res.status,
      body: body.slice(0, 1_200_000),
      url: res.url || url,
      ua,
      attempts: 1,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      body: "",
      url,
      ua,
      attempts: 1,
    };
  } finally {
    clearTimeout(t);
  }
}

function isBlocked(res: FetchResult): boolean {
  if (res.status === 403 || res.status === 429 || res.status === 503)
    return true;
  if (!res.body) return true;
  const head = res.body.slice(0, 2500).toLowerCase();
  return (
    /captcha|access denied|cf-browser-verification|just a moment|enable javascript|bot detection|unusual traffic|authwall|sign in to continue|login to continue/i.test(
      head,
    ) && res.body.length < 80_000
  );
}

/**
 * Resilient fetch: rotate UA, retry, optional URL variants.
 */
export async function resilientFetch(
  url: string,
  opts: {
    timeoutMs?: number;
    maxAttempts?: number;
    preferBot?: boolean;
    maxBody?: number;
  } = {},
): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 12000;
  const maxAttempts = opts.maxAttempts ?? 4;
  let last: FetchResult = {
    ok: false,
    status: 0,
    body: "",
    url,
    ua: "",
    attempts: 0,
  };

  // Prefer bot UA first for registries/CMS that cloak to browsers
  const order = opts.preferBot
    ? [
        ...BROWSER_UAS.filter((u) => /bot|Googlebot|Mailgraph/i.test(u)),
        ...BROWSER_UAS.filter((u) => !/bot|Googlebot|Mailgraph/i.test(u)),
      ]
    : [...BROWSER_UAS].sort(() => Math.random() - 0.5);

  for (let i = 0; i < maxAttempts; i++) {
    const ua = order[i % order.length]!;
    const res = await attemptOnce(url, ua, timeoutMs);
    res.attempts = i + 1;
    last = res;
    if (res.ok && !isBlocked(res)) {
      if (opts.maxBody && res.body.length > opts.maxBody) {
        res.body = res.body.slice(0, opts.maxBody);
      }
      return res;
    }
    // backoff + jitter
    await sleep(120 + i * 180 + Math.floor(Math.random() * 120));
  }

  // URL variants: www / non-www / http
  const variants: string[] = [];
  try {
    const u = new URL(url);
    if (u.protocol === "https:") {
      variants.push(url.replace("https://", "http://"));
    }
    if (u.hostname.startsWith("www.")) {
      const bare = `${u.protocol}//${u.hostname.slice(4)}${u.pathname}${u.search}`;
      variants.push(bare);
    } else {
      variants.push(
        `${u.protocol}//www.${u.hostname}${u.pathname}${u.search}`,
      );
    }
  } catch {
    // ignore
  }

  for (const v of variants.slice(0, 2)) {
    if (v === url) continue;
    const ua = pickUa(v.length);
    const res = await attemptOnce(v, ua, timeoutMs);
    res.attempts = last.attempts + 1;
    last = res;
    if (res.ok && !isBlocked(res)) return res;
  }

  return last;
}

/** Parallel map with concurrency limit. */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}
