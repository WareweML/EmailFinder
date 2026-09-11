/**
 * One LinkedIn HTTP client.
 * Session cookies stay alive only if every call uses the SAME residential
 * exit IP and a Chrome fingerprint. Datacenter IP or rotating -sid- logs
 * the account out (401). Never hit /voyager/api/me.
 */

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function env(key: string): string {
  if (process.env[key]) return process.env[key]!;
  try {
    const m = readFileSync("/workspace/.env", "utf8").match(
      new RegExp(`^${key}=(.*)$`, "m"),
    );
    return m?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

const SESSION_FILE = "/workspace/data/li-session.json";
const STICKY_FILE = "/workspace/data/li-proxy-session.json";
const CONFIG_URL =
  env("OKK_PROXY_CONFIG_URL_BING") || env("OKK_PROXY_CONFIG_URL");
const STICKY_MIN = Number(env("OKK_STICKY_MINUTES") || 1440);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type LiSession = {
  liAt: string;
  jsession: string;
  liA?: string;
  bcookie?: string;
  bscookie?: string;
};

type ProxyAuth = { host: string; port: string; user: string; pass: string };

let proxyCache: { at: number; proxy: ProxyAuth } | null = null;
let chain: Promise<unknown> = Promise.resolve();

function stickyId(): string {
  try {
    const j = JSON.parse(readFileSync(STICKY_FILE, "utf8")) as {
      id?: string;
      at?: number;
    };
    if (j.id && j.at && Date.now() - j.at < Math.max(STICKY_MIN, 1440) * 60_000)
      return j.id;
  } catch {
    /* none */
  }
  const id = `li${Date.now().toString(36)}`;
  try {
    writeFileSync(STICKY_FILE, JSON.stringify({ id, at: Date.now() }));
  } catch {
    /* none */
  }
  return id;
}

function stickyUser(base: string): string {
  const clean = base
    .replace(/-sid-[a-z0-9]+/gi, "")
    .replace(/-session-[a-zA-Z0-9]+/g, "")
    .replace(/-sessiontime-\d+/g, "")
    .replace(/-sessionduration-\d+/g, "");
  return `${clean}-session-${stickyId()}-sessiontime-${STICKY_MIN}`;
}

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

async function loadProxy(): Promise<ProxyAuth | null> {
  if (proxyCache && Date.now() - proxyCache.at < (STICKY_MIN - 2) * 60_000) {
    return proxyCache.proxy;
  }
  if (!CONFIG_URL) return proxyCache?.proxy ?? null;
  try {
    const res = await fetch(CONFIG_URL, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "text/plain" },
    });
    if (!res.ok) return proxyCache?.proxy ?? null;
    const parsed = parseConfig(await res.text());
    if (!parsed) return proxyCache?.proxy ?? null;
    const proxy = { ...parsed, user: stickyUser(parsed.user) };
    proxyCache = { at: Date.now(), proxy };
    return proxy;
  } catch {
    return proxyCache?.proxy ?? null;
  }
}

export function loadLiSession(): LiSession | null {
  if (env("LI_USE_SESSION") !== "1") return null;
  const liAt = process.env.LI_AT;
  const jsession = process.env.LI_JSESSIONID;
  const liA = process.env.LI_A;
  if (liAt && jsession) return { liAt, jsession, liA };
  try {
    const j = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as LiSession;
    if (j.liAt && j.jsession) return j;
  } catch {
    /* none */
  }
  return null;
}

function persistCookies(extra: Partial<LiSession>) {
  const cur = loadLiSession();
  if (!cur) return;
  const next = { ...cur, ...extra };
  try {
    writeFileSync(SESSION_FILE, JSON.stringify(next));
  } catch {
    /* none */
  }
}

function cookieHeader(sess: LiSession): string {
  const parts = [
    `li_at=${sess.liAt}`,
    sess.liA ? `li_a=${sess.liA}` : "",
    `JSESSIONID="${sess.jsession}"`,
    "liap=true",
    "lang=v=2&lang=en-us",
    sess.bcookie ? `bcookie="${sess.bcookie}"` : "",
    sess.bscookie ? `bscookie="${sess.bscookie}"` : "",
  ].filter(Boolean);
  return parts.join("; ");
}

export function chromeHeaders(sess: LiSession, referer: string): string[] {
  return [
    "-A",
    UA,
    "-H",
    "Accept: application/vnd.linkedin.normalized+json+2.1",
    "-H",
    "Accept-Language: en-US,en;q=0.9",
    "-H",
    `csrf-token: ${sess.jsession}`,
    "-H",
    "x-restli-protocol-version: 2.0.0",
    "-H",
    "x-li-lang: en_US",
    "-H",
    "x-li-page-instance: urn:li:page:d_sales2_search_people",
    "-H",
    "Origin: https://www.linkedin.com",
    "-H",
    `Referer: ${referer}`,
    "-H",
    `Cookie: ${cookieHeader(sess)}`,
    "-H",
    'sec-ch-ua: "Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "-H",
    "sec-ch-ua-mobile: ?0",
    "-H",
    'sec-ch-ua-platform: "Windows"',
    "-H",
    "sec-fetch-dest: empty",
    "-H",
    "sec-fetch-mode: cors",
    "-H",
    "sec-fetch-site: same-origin",
  ];
}

export type LiResponse = {
  status: number;
  body: string;
  via: "proxy" | "direct";
};

async function curlOnce(
  url: string,
  headers: string[],
  proxy: ProxyAuth | null,
): Promise<LiResponse> {
  const { mkdtempSync, readFileSync: read, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "li-"));
  const hdrFile = join(dir, "h");
  const bodyFile = join(dir, "b");
  const args = [
    "-sS",
    "-m",
    "22",
    "--compressed",
    "-D",
    hdrFile,
    "-o",
    bodyFile,
    "-w",
    "%{http_code}",
    "--max-redirs",
    "0",
  ];
  if (proxy) {
    args.push("-x", `http://${proxy.user}:${proxy.pass}@${proxy.host}:${proxy.port}`);
  }
  args.push(...headers, url);
  try {
    const { stdout } = await execFileAsync("curl", args, {
      maxBuffer: 50_000,
      timeout: 25_000,
    });
    const status = Number(stdout.trim()) || 0;
    const hdr = read(hdrFile, "utf8");
    const body = read(bodyFile, "utf8");
    const bc = hdr.match(/set-cookie:\s*bcookie="?([^";]+)/i)?.[1];
    const bsc = hdr.match(/set-cookie:\s*bscookie="?([^";]+)/i)?.[1];
    if (bc || bsc) persistCookies({ bcookie: bc, bscookie: bsc });
    return { status, body, via: proxy ? "proxy" : "direct" };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* none */
    }
  }
}

type PW = {
  browser: { close: () => Promise<void> };
  page: {
    evaluate: (fn: (a: { url: string; csrf: string }) => Promise<{ status: number; body: string }>, a: { url: string; csrf: string }) => Promise<{ status: number; body: string }>;
  };
};
let pw: PW | null = null;

async function ensureBrowser(sess: LiSession, proxy: ProxyAuth | null): Promise<PW | null> {
  if (pw) return pw;
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      proxy: proxy
        ? {
            server: `http://${proxy.host}:${proxy.port}`,
            username: proxy.user,
            password: proxy.pass,
          }
        : undefined,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    });
    const context = await browser.newContext({
      userAgent: UA,
      locale: "en-US",
    });
    const cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
    }> = [
      { name: "li_at", value: sess.liAt, domain: ".linkedin.com", path: "/" },
      { name: "JSESSIONID", value: `"${sess.jsession}"`, domain: ".www.linkedin.com", path: "/" },
      { name: "liap", value: "true", domain: ".linkedin.com", path: "/" },
    ];
    if (sess.liA)
      cookies.push({ name: "li_a", value: sess.liA, domain: ".linkedin.com", path: "/" });
    if (sess.bcookie)
      cookies.push({ name: "bcookie", value: sess.bcookie, domain: ".linkedin.com", path: "/" });
    if (sess.bscookie)
      cookies.push({
        name: "bscookie",
        value: sess.bscookie,
        domain: ".www.linkedin.com",
        path: "/",
      });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto("https://www.linkedin.com/sales/search/people", {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });
    pw = { browser, page } as unknown as PW;
    return pw;
  } catch {
    return null;
  }
}

async function liGetInPage(
  url: string,
  sess: LiSession,
  proxy: ProxyAuth | null,
): Promise<LiResponse | null> {
  const b = await ensureBrowser(sess, proxy);
  if (!b) return null;
  try {
    const r = await b.page.evaluate(
      async ({ url, csrf }) => {
        const res = await fetch(url, {
          credentials: "include",
          headers: {
            Accept: "application/vnd.linkedin.normalized+json+2.1",
            "csrf-token": csrf,
            "x-restli-protocol-version": "2.0.0",
            "x-li-page-instance": "urn:li:page:d_sales2_search_people",
          },
        });
        return { status: res.status, body: await res.text() };
      },
      { url, csrf: sess.jsession },
    );
    return { status: r.status, body: r.body, via: "proxy" };
  } catch {
    pw = null;
    return null;
  }
}

/** Serialized LinkedIn GET — sticky IP curl, then same-tab Chrome fetch. */
export async function liGet(
  url: string,
  referer: string,
): Promise<LiResponse> {
  if (url.includes("/voyager/api/me")) {
    return { status: 0, body: "blocked /me", via: "direct" };
  }
  const run = async () => {
    const sess = loadLiSession();
    if (!sess) return { status: 0, body: "no cookie", via: "direct" as const };
    const proxy = await loadProxy();
    await new Promise((r) => setTimeout(r, 180));
    const viaPage = await liGetInPage(url, sess, proxy);
    if (viaPage && viaPage.status !== 401 && viaPage.status !== 0) return viaPage;
    const headers = chromeHeaders(sess, referer);
    try {
      return await curlOnce(url, headers, proxy);
    } catch {
      return {
        status: 0,
        body: "curl failed",
        via: proxy ? ("proxy" as const) : ("direct" as const),
      };
    }
  };
  const next = chain.then(run, run) as Promise<LiResponse>;
  chain = next.catch(() => undefined);
  return next;
}

export async function proxyExitIp(): Promise<string> {
  const proxy = await loadProxy();
  if (!proxy) return "no-proxy";
  try {
    const { stdout } = await execFileAsync(
      "curl",
      [
        "-sS",
        "-m",
        "10",
        "-x",
        `http://${proxy.user}:${proxy.pass}@${proxy.host}:${proxy.port}`,
        "https://api.ipify.org",
      ],
      { timeout: 12_000 },
    );
    return `${stdout.trim()} sticky=${stickyId()}`;
  } catch (e) {
    return `proxy-error ${String(e).slice(0, 80)}`;
  }
}
