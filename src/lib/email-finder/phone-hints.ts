/**
 * Last-2/4 recovery hints. Instagram/Facebook lookup via Okk residential.
 * Never call LinkedIn from here — extra Voyager hits after a profile read
 * are what log the Sales Nav seat out.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadOkkProxy } from "./okk-serp";

const execFileAsync = promisify(execFile);

export type Hint = { raw: string; source: string };

function extractHints(text: string, source: string): Hint[] {
  const out: Hint[] = [];
  const re = [
    /\+91[\s-]*[*xX•.]{4,8}[\s-]*\d{2,4}/g,
    /\b(?:ending in|ends in|ends with)\s+\d{2,4}\b/gi,
    /obfuscated_phone["']?\s*[:=]\s*["']([^"']+)/gi,
    /masked_phone["']?\s*[:=]\s*["']([^"']+)/gi,
    /phoneNumbers?["']?\s*[:=]\s*["'](\+?\d[\d\s*-]{7,})/gi,
  ];
  for (const r of re) {
    for (const m of text.match(r) ?? []) out.push({ raw: m, source });
  }
  return out;
}

async function okkCurl(args: string[]): Promise<{ status: number; body: string } | null> {
  const proxy = await loadOkkProxy();
  if (!proxy) return null;
  const sid = `${proxy.user.replace(/-sid-[a-z0-9]+$/i, "")}-sid-${Date.now().toString(36)}`;
  const x = `http://${sid}:${proxy.pass}@${proxy.host}:${proxy.port}`;
  try {
    const { stdout } = await execFileAsync(
      "curl",
      ["-sS", "-m", "18", "-L", "--max-redirs", "3", "-x", x, "-w", "\n__HTTP__%{http_code}", ...args],
      { maxBuffer: 400_000, timeout: 20000 },
    );
    const idx = stdout.lastIndexOf("__HTTP__");
    const body = idx >= 0 ? stdout.slice(0, idx) : stdout;
    const status = idx >= 0 ? Number(stdout.slice(idx + 8).trim()) : 0;
    return { status, body };
  } catch {
    return null;
  }
}

async function instagramHints(emailOrUser: string): Promise<Hint[]> {
  const ua =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const home = await okkCurl(["-A", ua, "-c", "-", "https://www.instagram.com/accounts/password/reset/"]);
  const csrf =
    home?.body.match(/csrf_token["']?\s*[:=]\s*["']([^"']+)/)?.[1] ||
    home?.body.match(/csrftoken=([^;]+)/)?.[1] ||
    "";
  const lookup = await okkCurl([
    "-A", ua,
    "-H", "Content-Type: application/x-www-form-urlencoded",
    "-H", "X-Requested-With: XMLHttpRequest",
    "-H", "X-IG-App-ID: 936619743392459",
    "-H", `X-CSRFToken: ${csrf}`,
    "-H", "Referer: https://www.instagram.com/accounts/password/reset/",
    "--data-urlencode", `email_or_username=${emailOrUser}`,
    "https://www.instagram.com/api/v1/users/lookup/",
  ]);
  if (!lookup?.body) return [];
  return extractHints(lookup.body, "instagram-lookup");
}

async function facebookHints(email: string): Promise<Hint[]> {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const page = await okkCurl([
    "-A", ua,
    "-H", "Content-Type: application/x-www-form-urlencoded",
    "--data-urlencode", `email=${email}`,
    "--data-urlencode", "did_submit=1",
    "--data-urlencode", "__a=1",
    "https://www.facebook.com/ajax/login/help/identify.php?ctx=recover",
  ]);
  if (!page?.body) return [];
  return extractHints(page.body, "facebook-identify");
}

export async function recoveryHints(opts: {
  email?: string;
  instagram?: string;
  linkedinUrl?: string;
}): Promise<Hint[]> {
  const id = opts.instagram || opts.email;
  const [ig, fb] = await Promise.all([
    id ? instagramHints(id) : Promise.resolve([]),
    opts.email ? facebookHints(opts.email) : Promise.resolve([]),
  ]);
  return [...ig, ...fb];
}

export async function okkProxyReady(): Promise<boolean> {
  const p = await loadOkkProxy();
  return Boolean(p?.host && p.port && p.user && p.pass);
}
