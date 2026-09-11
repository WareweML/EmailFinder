/**
 * Public India phone graph: IndiaMART company pages + site tel: links.
 * PNS virtuals (8046–8049) are call-tracking — never a person's mobile.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadOkkProxy } from "./okk-serp";

const execFileAsync = promisify(execFile);
const PNS = /^80(4[6-9]|5\d)/;

export type DirHit = { e164: string; display: string; source: string };

function formatIn(ten: string): string {
  return `+91 ${ten.slice(0, 5)} ${ten.slice(5)}`;
}

function digits(s: string): string {
  const n = s.replace(/\D/g, "");
  return n.length === 12 && n.startsWith("91") ? n.slice(2) : n;
}

async function okkGet(url: string): Promise<string> {
  const proxy = await loadOkkProxy();
  const args = [
    "-sS", "-m", "18", "-L", "--max-redirs", "3", "-A",
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  ];
  if (proxy) {
    const sid = proxy.user.replace(/sessid-[A-Za-z0-9]+/i, `sessid-${Date.now().toString(36)}`);
    args.push("-x", `http://${sid}:${proxy.pass}@${proxy.host}:${proxy.port}`);
  }
  args.push(url);
  try {
    const { stdout } = await execFileAsync("curl", args, { maxBuffer: 800_000, timeout: 20000 });
    return stdout || "";
  } catch {
    return "";
  }
}

function phonesIn(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.match(/\+91[\s-]*[6-9][\d\s,-]{8,18}|\b[6-9]\d{9}\b/g) ?? []) {
    const ten = digits(m).slice(0, 10);
    if (ten.length === 10 && /^[6-9]/.test(ten) && !PNS.test(ten)) out.add(ten);
  }
  return [...out];
}

export async function indiaMartCompany(slugOrName: string): Promise<DirHit[]> {
  const slug = slugOrName.trim().toLowerCase().replace(/\s+/g, "-");
  let html = await okkGet(`https://m.indiamart.com/${encodeURIComponent(slug)}/`);
  if (!html || html.length < 2000 || /search\.html/i.test(html.slice(0, 500))) {
    const search = await okkGet(`https://dir.indiamart.com/search.mp?ss=${encodeURIComponent(slugOrName)}`);
    const found = search.match(/indiamart\.com\/([a-z0-9-]+)\//i)?.[1];
    if (found) html = await okkGet(`https://m.indiamart.com/${found}/`);
  }
  return phonesIn(html).map((ten) => ({
    e164: `+91${ten}`,
    display: formatIn(ten),
    source: "indiamart",
  }));
}

export async function siteTelLinks(domain: string): Promise<DirHit[]> {
  if (!domain) return [];
  const host = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const html = await okkGet(`https://${host}`);
  return phonesIn(html).slice(0, 5).map((ten) => ({
    e164: `+91${ten}`,
    display: formatIn(ten),
    source: "site-tel",
  }));
}
