/**
 * OkkProxy rotating residential SOCKS5 → Brave Search.
 * New IP per request: -sid-{8 hex} on the username.
 * Brave returns real /in/ slugs. Google through this pool is a JS wall / 429.
 * No Jina.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);

const CONFIG_URL = process.env.OKK_PROXY_CONFIG_URL ?? "";

type ProxyAuth = {
  host: string;
  port: string;
  user: string;
  pass: string;
};

let cached: { at: number; proxy: ProxyAuth } | null = null;

function parseConfig(text: string): ProxyAuth | null {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.includes(":") && !l.startsWith("#"));
  if (!line) return null;
  const parts = line.split(":");
  if (parts.length < 4) return null;
  const [host, port, user, ...rest] = parts;
  const pass = rest.join(":");
  if (!host || !port || !user || !pass) return null;
  return { host, port, user, pass };
}

function withNewIp(p: ProxyAuth): ProxyAuth {
  const sid = randomBytes(4).toString("hex");
  const user = p.user.replace(/-sid-[a-z0-9]+$/i, "") + `-sid-${sid}`;
  return { ...p, user };
}

export async function loadOkkProxy(): Promise<ProxyAuth | null> {
  if (!CONFIG_URL) return cached?.proxy ?? null;
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.proxy;
  try {
    const res = await fetch(CONFIG_URL, {
      signal: AbortSignal.timeout(4000),
      headers: { Accept: "text/plain" },
    });
    if (!res.ok) return cached?.proxy ?? null;
    const proxy = parseConfig(await res.text());
    if (!proxy) return cached?.proxy ?? null;
    cached = { at: Date.now(), proxy };
    return proxy;
  } catch {
    return cached?.proxy ?? null;
  }
}

function socksArg(p: ProxyAuth): string {
  return `${p.user}:${p.pass}@${p.host}:${p.port}`;
}

async function curlViaSocks(
  url: string,
  proxy: ProxyAuth,
): Promise<string | null> {
  const exit = withNewIp(proxy);
  try {
    const { stdout } = await execFileAsync(
      "curl",
      [
        "-sS",
        "-m",
        "12",
        "-L",
        "--max-redirs",
        "2",
        "--socks5-hostname",
        socksArg(exit),
        "-A",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "-H",
        "Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "-H",
        "Accept-Language: en-US,en;q=0.9",
        "--compressed",
        url,
      ],
      { maxBuffer: 600_000, timeout: 13000 },
    );
    if (!stdout || stdout.length < 800) return null;
    if (/\/sorry\/|unusual traffic|enablejs/i.test(stdout.slice(0, 2000)))
      return null;
    return stdout;
  } catch {
    return null;
  }
}

export function parseBravePeople(
  html: string,
  companyName: string,
): Array<{ name: string; title?: string; slug: string }> {
  const out: Array<{ name: string; title?: string; slug: string }> = [];
  const seen = new Set<string>();
  const brand = companyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const brandRe = new RegExp(brand, "i");

  for (const m of html.matchAll(
    />([A-Z][^<]{5,90}?)\s+at\s+([^<]{2,40})</g,
  )) {
    const left = m[1].replace(/\s+/g, " ").trim();
    const co = m[2].replace(/\s+/g, " ").trim();
    if (!brandRe.test(co) && !brandRe.test(left)) continue;
    const [name, ...rest] = left.split(/\s*[-–|]\s*/);
    if (!name || name.split(/\s+/).length < 2) continue;
    if (/^(former|ex-|previously)/i.test(left)) continue;
    const win = html.slice(Math.max(0, (m.index ?? 0) - 400), (m.index ?? 0) + 500);
    const slug = win.match(/linkedin\.com\/in\/([a-zA-Z0-9_%\-]+)/i)?.[1];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      name,
      title: rest.join(" - ").trim() || undefined,
      slug: decodeURIComponent(slug),
    });
  }

  for (const m of html.matchAll(/linkedin\.com\/in\/([a-zA-Z0-9_%\-]+)/gi)) {
    const slug = decodeURIComponent(m[1]);
    if (seen.has(slug) || slug.length < 4) continue;
    seen.add(slug);
    out.push({ name: slug, slug });
  }
  return out;
}

/** @deprecated alias — Brave is the working engine */
export const parseGooglePeople = parseBravePeople;

export async function braveShards(
  queries: string[],
): Promise<Array<{ query: string; html: string | null }>> {
  const proxy = await loadOkkProxy();
  if (!proxy) return queries.map((query) => ({ query, html: null }));

  const out: Array<{ query: string; html: string | null }> = new Array(
    queries.length,
  );
  let i = 0;
  // Brave 429s at 6-wide. 2-wide holds.
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (i < queries.length) {
        const idx = i++;
        const q = queries[idx]!;
        const url =
          "https://search.brave.com/search?" +
          new URLSearchParams({ q, source: "web" }).toString();
        out[idx] = { query: q, html: await curlViaSocks(url, proxy) };
      }
    }),
  );
  return out;
}

export const googleShards = braveShards;
