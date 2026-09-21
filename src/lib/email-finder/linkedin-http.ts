/**
 * Personal LinkedIn / Sales Nav HTTP client.
 *
 * HARD RULES (ban-avoidance):
 * 1. Cookies NEVER leave this process except through LI_SOCKS_PROXY.
 * 2. SOCKS5h (DNS through the proxy). No OKK, no Decodo, no datacenter fallback,
 *    no direct sandbox IP.
 * 3. No Playwright / browser profile. One curl identity, one exit.
 * 4. Never hit /voyager/api/me (logs the account out).
 * 5. Serialized + delayed. One in-flight LinkedIn call at a time.
 * 7. If APIALT_KEY is set, cookies are never sent — LinkedIn goes through ApiAlt.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
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
const CIRCUIT_FILE = "/workspace/data/li-circuit.json";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type LiSession = {
  liAt: string;
  jsession: string;
  liA?: string;
  bcookie?: string;
  bscookie?: string;
  lidc?: string;
  liGc?: string;
};

export type SocksPin = {
  host: string;
  port: string;
  user: string;
  pass: string;
};

let chain: Promise<unknown> = Promise.resolve();

/** Parse host:port:user:pass. Empty / malformed = no pin. */
export function parseSocksPin(line: string): SocksPin | null {
  const raw = line.trim();
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length < 4) return null;
  const [host, port, user, ...rest] = parts;
  const pass = rest.join(":");
  if (!host || !port || !user || !pass) return null;
  if (!/^\d+$/.test(port)) return null;
  return { host, port, user, pass };
}

/** The only proxy this account is allowed to use. */
export function dedicatedSocks(): SocksPin | null {
  return parseSocksPin(env("LI_SOCKS_PROXY"));
}

export function liCircuitOpen(): boolean {
  try {
    const j = JSON.parse(readFileSync(CIRCUIT_FILE, "utf8")) as { open?: boolean };
    return !!j.open;
  } catch {
    return false;
  }
}

export function apialtConfigured(): boolean {
  return env("APIALT_KEY").trim().startsWith("alt_");
}

export function liSessionStatus(): {
  salesNav: "ready" | "paused" | "missing";
  reason?: string;
} {
  if (apialtConfigured()) {
    return {
      salesNav: "ready",
      reason: "LinkedIn via ApiAlt. Personal Sales Nav cookies are not sent.",
    };
  }
  if (liCircuitOpen()) {
    let reason = "LinkedIn challenged this Sales Nav session. Cookies are not being sent.";
    try {
      const j = JSON.parse(readFileSync(CIRCUIT_FILE, "utf8")) as { reason?: string };
      if (j.reason) reason = `Paused after ${j.reason.slice(0, 80)}. Cookies were not sent.`;
    } catch {
      /* */
    }
    return { salesNav: "paused", reason };
  }
  if (!dedicatedSocks()) return { salesNav: "missing", reason: "No SOCKS pin for this seat." };
  if (!loadLiSession()) return { salesNav: "missing", reason: "No Sales Nav cookies on disk." };
  return { salesNav: "ready" };
}

export function tripLiCircuit(reason: string): void {
  try {
    mkdirSync(dirname(CIRCUIT_FILE), { recursive: true });
    writeFileSync(
      CIRCUIT_FILE,
      JSON.stringify({ open: true, reason: reason.slice(0, 180), at: Date.now() }),
    );
  } catch {
    /* */
  }
}

export function clearLiCircuit(): void {
  try {
    unlinkSync(CIRCUIT_FILE);
  } catch {
    /* */
  }
}

export function loadLiSession(): LiSession | null {
  if (env("LI_USE_SESSION") !== "1") return null;
  try {
    const j = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as LiSession;
    if (j.liAt && j.jsession) return j;
  } catch {
    /* none */
  }
  const liAt = process.env.LI_AT;
  const jsession = process.env.LI_JSESSIONID;
  const liA = process.env.LI_A;
  if (liAt && jsession) return { liAt, jsession, liA };
  return null;
}

export function saveLiSession(sess: LiSession): void {
  writeSession(sess);
  clearLiCircuit();
}

function writeSession(sess: LiSession): void {
  mkdirSync(dirname(SESSION_FILE), { recursive: true });
  const cur = (() => {
    try {
      return JSON.parse(readFileSync(SESSION_FILE, "utf8")) as LiSession;
    } catch {
      return {} as LiSession;
    }
  })();
  writeFileSync(
    SESSION_FILE,
    JSON.stringify({ ...cur, ...sess, at: Date.now() }),
  );
}

function persistCookies(extra: Partial<LiSession>) {
  const cur = loadLiSession();
  if (!cur) return;
  try {
    writeSession({ ...cur, ...extra });
  } catch {
    /* none */
  }
}

function cookieHeader(sess: LiSession): string {
  return [
    `li_at=${sess.liAt}`,
    sess.liA ? `li_a=${sess.liA}` : "",
    `JSESSIONID="${sess.jsession}"`,
    "liap=true",
    "lang=v=2&lang=en-us",
    sess.bcookie ? `bcookie="${sess.bcookie}"` : "",
    sess.bscookie ? `bscookie="${sess.bscookie}"` : "",
    sess.lidc ? `lidc="${sess.lidc}"` : "",
    sess.liGc ? `li_gc="${sess.liGc}"` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function chromeHeaders(sess: LiSession, referer: string): string[] {
  const profile = /linkedin\.com\/in\//i.test(referer);
  const page = profile
    ? "urn:li:page:d_flagship3_profile_view_base"
    : "urn:li:page:d_sales2_search_people";
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
    `x-li-page-instance: ${page}`,
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
  via: "socks" | "refused";
};

/** Rest.li 2.0 reduced encoding — keep () , : ! so the query parses. */
export function restLiQuery(query: string): string {
  return encodeURIComponent(query)
    .replace(/%28/g, "(")
    .replace(/%29/g, ")")
    .replace(/%2C/g, ",")
    .replace(/%3A/g, ":")
    .replace(/%21/g, "!");
}

export function salesNavSearchUrl(
  keywords: string,
  start = 0,
  count = 5,
): string {
  const q = `(recentSearchParam:(id:0,doLogHistory:!f),filters:List(),keywords:${JSON.stringify(keywords)})`;
  return (
    "https://www.linkedin.com/sales-api/salesApiLeadSearch" +
    `?q=searchQuery&query=${restLiQuery(q)}` +
    `&start=${start}&count=${count}&decorationId=com.linkedin.sales.deco.desktop.searchv2.LeadSearchResult-14`
  );
}

function ingestSetCookie(hdr: string) {
  const extra: Partial<LiSession> = {};
  const bc = hdr.match(/set-cookie:\s*bcookie="?([^";]+)/i)?.[1];
  const bsc = hdr.match(/set-cookie:\s*bscookie="?([^";]+)/i)?.[1];
  const lidc = hdr.match(/set-cookie:\s*lidc="?([^";]+)/i)?.[1];
  const liGc = hdr.match(/set-cookie:\s*li_gc="?([^";]+)/i)?.[1];
  if (bc) extra.bcookie = bc;
  if (bsc) extra.bscookie = bsc;
  if (lidc) extra.lidc = lidc;
  if (liGc) extra.liGc = liGc;
  if (Object.keys(extra).length) persistCookies(extra);

  const liAtSet = hdr.match(/set-cookie:\s*li_at=([^;\s]*)/i)?.[1] ?? "";
  const deleted =
    liAtSet.length > 0 &&
    liAtSet.length < 40 &&
    !/^AQE/i.test(liAtSet);
  if (deleted) tripLiCircuit("set-cookie li_at replaced with a short value");
}

async function curlSocks(
  url: string,
  headers: string[],
  pin: SocksPin,
  redirs = 0,
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
    "25",
    "--compressed",
    "-D",
    hdrFile,
    "-o",
    bodyFile,
    "-w",
    "%{http_code}",
    "--max-redirs",
    String(redirs),
    ...(redirs > 0 ? (["-L"] as string[]) : []),
    "--socks5-hostname",
    `${pin.host}:${pin.port}`,
    "--proxy-user",
    `${pin.user}:${pin.pass}`,
    ...headers,
    url,
  ];
  try {
    const { stdout } = await execFileAsync("curl", args, {
      maxBuffer: 80_000,
      timeout: 28_000,
    });
    const status = Number(stdout.trim()) || 0;
    const hdr = read(hdrFile, "utf8");
    const body = read(bodyFile, "utf8");
    ingestSetCookie(hdr);
    if (status === 401 || status === 999) {
      tripLiCircuit(`http ${status} ${url.slice(0, 80)}`);
    }
    return { status, body, via: "socks" };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* none */
    }
  }
}

function refused(body: string): LiResponse {
  return { status: 0, body, via: "refused" };
}

async function gated(
  url: string,
  run: () => Promise<LiResponse>,
): Promise<LiResponse> {
  if (apialtConfigured()) {
    return refused("apialt — personal cookies not sent");
  }
  if (
    url.includes("/voyager/api/me") ||
    url.includes("/profileContactInfo") ||
    url.includes("/profileView")
  ) {
    return refused("blocked endpoint");
  }
  if (liCircuitOpen()) {
    return refused("circuit open — cookies not sent");
  }
  const sess = loadLiSession();
  const pin = dedicatedSocks();
  if (!sess) return refused("no cookie");
  if (!pin) {
    return refused("refused: LI_SOCKS_PROXY pin missing — cookies not sent");
  }
  const next = chain.then(
    async () => {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        return await run();
      } catch (e) {
        return refused(`socks-fail ${String(e).slice(0, 80)}`);
      }
    },
    async () => {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        return await run();
      } catch (e) {
        return refused(`socks-fail ${String(e).slice(0, 80)}`);
      }
    },
  ) as Promise<LiResponse>;
  chain = next.catch(() => undefined);
  return next;
}

/** HTML GET through the same SOCKS pin (profile pages). Cookies never go direct. */
export async function liGetHtml(url: string): Promise<LiResponse> {
  return gated(url, async () => {
    const sess = loadLiSession()!;
    const pin = dedicatedSocks()!;
    const headers = [
      "-A",
      UA,
      "-H",
      "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "-H",
      "Accept-Language: en-US,en;q=0.9",
      "-H",
      `Cookie: ${cookieHeader(sess)}`,
      "-H",
      "Upgrade-Insecure-Requests: 1",
      "-H",
      "sec-fetch-dest: document",
      "-H",
      "sec-fetch-mode: navigate",
      "-H",
      "sec-fetch-site: none",
      "-H",
      "sec-fetch-user: ?1",
    ];
    return curlSocks(url, headers, pin, 5);
  });
}

/** Serialized LinkedIn GET — dedicated SOCKS only. Cookies never go direct. */
export async function liGet(
  url: string,
  referer: string,
): Promise<LiResponse> {
  return gated(url, async () => {
    const sess = loadLiSession()!;
    const pin = dedicatedSocks()!;
    return curlSocks(url, chromeHeaders(sess, referer), pin);
  });
}

/** Exit IP of the dedicated pin. Never uses cookies. */
export async function proxyExitIp(): Promise<string> {
  const pin = dedicatedSocks();
  if (!pin) return "no-pin";
  try {
    const { stdout } = await execFileAsync(
      "curl",
      [
        "-sS",
        "-m",
        "12",
        "--socks5-hostname",
        `${pin.host}:${pin.port}`,
        "--proxy-user",
        `${pin.user}:${pin.pass}`,
        "https://api.ipify.org",
      ],
      { timeout: 14_000 },
    );
    return `${stdout.trim()} socks=${pin.host}:${pin.port}`;
  } catch (e) {
    return `socks-error ${String(e).slice(0, 80)}`;
  }
}
