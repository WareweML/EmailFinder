/**
 * Live phone waterfall — not a 125M warehouse.
 * Prospeo-shaped: partner APIs at request time, 90-day cache of hits we actually resolved.
 */

import { readFileSync } from "node:fs";
import { stitchBest, rocketMaskFor, parseInMask, holeCount } from "./phone-stitch";
import { resilientFetch } from "./http";
import { cacheGet, cacheSet, cacheKey } from "./phone-cache";
import { recoveryHints } from "./phone-hints";
import { rocketLookup, rocketSearch } from "./rocketreach-api";

export type MobileHit = {
  e164: string;
  display: string;
  source: string;
  whatsapp?: boolean | null;
};

function env(k: string): string {
  if (process.env[k]) return process.env[k]!;
  try {
    const m = readFileSync("/workspace/.env", "utf8").match(new RegExp(`^${k}=(.*)$`, "m"));
    return m?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function digits(s: string): string {
  return s.replace(/\D/g, "");
}

export function formatInMobile(d: string): string {
  const n = d.replace(/\D/g, "");
  const ten = n.length === 12 && n.startsWith("91") ? n.slice(2) : n.length === 11 && n.startsWith("0") ? n.slice(1) : n;
  if (ten.length === 10 && /^[6-9]/.test(ten)) return `+91 ${ten.slice(0, 5)} ${ten.slice(5)}`;
  if (n.length === 11 && n.startsWith("1")) return `+1 ${n.slice(1, 4)}-${n.slice(4, 7)}-${n.slice(7)}`;
  return n.startsWith("+") ? n : `+${n}`;
}

export function isInMobile(d: string): boolean {
  const n = d.replace(/\D/g, "");
  const ten = n.length === 12 && n.startsWith("91") ? n.slice(2) : n;
  return ten.length === 10 && /^[6-9]/.test(ten);
}

export function isMaskedPhone(s: string): boolean {
  return /[X*x•]{2,}|xxxx|\.{3,}/i.test(s);
}

function nameOnCard(blob: string, fullName: string): boolean {
  const hay = blob.toLowerCase();
  return fullName
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .every((t) => hay.includes(t));
}

function labeledHq(blob: string): boolean {
  return /headquarters phone number is/i.test(blob);
}

/** IndiaMART / Justdial PNS tracking numbers — not the person. */
function isPns(n: string): boolean {
  const ten = n.replace(/\D/g, "");
  const d = ten.length === 12 && ten.startsWith("91") ? ten.slice(2) : ten;
  return /^(8047|8069|8882|8884)/.test(d) || /^(1800|1860|140)/.test(d);
}

const STITCH_HOST =
  /rocketreach\.co|datanyze\.com\/people|zoominfo\.com\/p|signalhire\.com|adapt\.io|lusha\.com|lead411\.com|contactout\.com|fastpeoplesearch\.com|thatsthem\.com|truepeoplesearch\.com|whitepages\.com|spokeo\.com|easyleadz\.com|aeroleads\.com/i;

function hostOf(url?: string): string {
  try {
    return new URL(url ?? "https://serp.local").hostname.replace(/^www\./, "");
  } catch {
    return "serp";
  }
}

export function phonesFromCards(
  rows: Array<{ title?: string; description?: string; link?: string }>,
  fullName: string,
  company?: string,
): MobileHit[] {
  const out: MobileHit[] = [];
  const seen = new Set<string>();
  const brand = (company ?? "").toLowerCase();
  for (const r of rows) {
    const blob = `${r.title ?? ""} ${r.description ?? ""}`;
    const link = (r.link ?? "").toLowerCase();
    if (/instagram\.com|facebook\.com|twitter\.com|x\.com|youtube\.com|reddit\.com/i.test(link)) continue;
    if (!nameOnCard(blob, fullName)) continue;
    const directory = STITCH_HOST.test(link);
    if (!directory && brand.length > 4 && !blob.toLowerCase().includes(brand)) continue;
    if (!directory && !/\b(mobile|phone number|direct dial|cell)\b/i.test(blob)) continue;
    if (isMaskedPhone(blob) && !/\b[6-9]\d{9}\b/.test(blob) && !/\(\d{3}\)\s*\d{3}[\s-]*\d{4}/.test(blob)) continue;
    if (labeledHq(blob)) continue;
    const found = [
      ...(blob.match(/\+91[\s-]*[6-9]\d{4}[\s-]?\d{5}/g) ?? []),
      ...(blob.match(/\b[6-9]\d{9}\b/g) ?? []),
    ];
    for (const raw of found) {
      const n = digits(raw);
      const ten = n.length === 12 && n.startsWith("91") ? n.slice(2) : n;
      if (!isInMobile(ten) || isPns(ten) || seen.has(ten)) continue;
      seen.add(ten);
      out.push({ e164: `+91${ten}`, display: formatInMobile(ten), source: hostOf(r.link) });
    }
  }
  return out;
}

function collectStitchParts(
  rows: Array<{ title?: string; description?: string; link?: string }>,
  fullName: string,
  company?: string,
): { prefixes: string[]; suffixes: string[]; hqFull: string[] } {
  const prefixes: string[] = [];
  const suffixes: string[] = [];
  const hqFull: string[] = [];
  for (const r of rows) {
    const blob = `${r.title ?? ""} ${r.description ?? ""}`;
    const link = r.link ?? "";
    const rr = rocketMaskFor(r.title ?? "", r.description ?? "", link, fullName);
    if (rr) prefixes.push(rr);
    if (nameOnCard(blob, fullName)) {
      const parsed = parseInMask(blob);
      if (parsed && holeCount(parsed) > 0 && holeCount(parsed) <= 6) {
        if (holeCount(parsed) >= 4) prefixes.push(blob);
        else suffixes.push(blob);
      }
    }
    if (labeledHq(blob) && company && blob.toLowerCase().includes(company.toLowerCase())) {
      const m = blob.match(/\b[6-9]\d{9}\b/);
      if (m) hqFull.push(m[0]!);
    }
  }
  return { prefixes: [...new Set(prefixes)], suffixes: [...new Set(suffixes)], hqFull: [...new Set(hqFull)] };
}

async function rocketreachPrefixes(
  rows: Array<{ title?: string; description?: string; link?: string }>,
  fullName: string,
): Promise<string[]> {
  const url = rows.find((r) => {
    const u = r.link ?? "";
    if (!/rocketreach\.co\/.+email_/i.test(u)) return false;
    const slug = u.split("/").pop() ?? "";
    const tokens = fullName.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    return tokens.every((t) => slug.includes(t.replace(/[^a-z]/g, "")));
  })?.link;
  if (!url) return [];
  try {
    const page = await resilientFetch(url);
    if (!page.ok || !page.body) return [];
    const out: string[] = [];
    const m = page.body.match(/\+91\s*[6-9][\dX*x•.\s-]{6,18}/g) ?? [];
    for (const raw of m) {
      const p = parseInMask(raw);
      if (p && holeCount(p) > 0) out.push(raw);
    }
    return [...new Set(out)].slice(0, 6);
  } catch {
    return [];
  }
}

async function rocketPersonMobile(opts: {
  fullName: string;
  company?: string;
  linkedinUrl?: string;
}): Promise<MobileHit | null> {
  try {
    const looked = await rocketLookup({
      name: opts.fullName,
      company: opts.company,
      linkedinUrl: opts.linkedinUrl,
    });
    const p = looked.phones.find((x) => isInMobile(x.number) && !isPns(x.number) && !isMaskedPhone(x.number));
    if (p) {
      const ten = digits(p.number).slice(-10);
      return { e164: `+91${ten}`, display: formatInMobile(ten), source: "rocketreach-api" };
    }
    const search = await rocketSearch(opts.fullName, opts.company);
    for (const t of search.teasers) {
      if (isInMobile(t) && !isMaskedPhone(t) && !isPns(t)) {
        const ten = digits(t).slice(-10);
        return { e164: `+91${ten}`, display: formatInMobile(ten), source: "rocketreach-search" };
      }
    }
  } catch {
    /* sandbox / no credits */
  }
  return null;
}

async function prospeoMobile(linkedinUrl: string): Promise<MobileHit | null> {
  const key = env("PROSPEO_API_KEY");
  if (!key || !linkedinUrl) return null;
  try {
    const res = await fetch("https://api.prospeo.io/social-url-enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KEY": key },
      body: JSON.stringify({ url: linkedinUrl }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.person?.mobile ?? data?.mobile ?? data?.phone ?? "";
    const n = digits(String(raw));
    if (n.length < 10 || isPns(n)) return null;
    return { e164: raw.startsWith("+") ? String(raw) : `+${n}`, display: formatInMobile(n), source: "prospeo" };
  } catch {
    return null;
  }
}

async function apolloMobile(fullName: string, domain?: string): Promise<MobileHit | null> {
  const key = env("APOLLO_API_KEY");
  if (!key) return null;
  try {
    const res = await fetch("https://api.apollo.io/api/v1/people/match", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": key },
      body: JSON.stringify({ name: fullName, domain, reveal_personal_emails: false, reveal_phone_number: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.person?.phone_numbers?.[0]?.sanitized_number ?? data?.person?.mobile_phone ?? "";
    const n = digits(String(raw));
    if (n.length < 10 || isPns(n)) return null;
    return { e164: `+${n.replace(/^\+/, "")}`, display: formatInMobile(n), source: "apollo" };
  } catch {
    return null;
  }
}

async function datagmaMobile(fullName: string, linkedinUrl?: string, domain?: string): Promise<MobileHit | null> {
  const id = env("DATAGMA_API_ID");
  if (!id) return null;
  try {
    const u = new URL("https://gateway.datagma.net/api/ingress/v2/full");
    u.searchParams.set("apiId", id);
    if (linkedinUrl) u.searchParams.set("username", linkedinUrl);
    else u.searchParams.set("fullName", fullName);
    if (domain) u.searchParams.set("company", domain);
    const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.phones?.[0] ?? data?.person?.phone ?? "";
    const n = digits(String(raw));
    if (n.length < 10 || isPns(n)) return null;
    return { e164: raw.startsWith("+") ? String(raw) : `+${n}`, display: formatInMobile(n), source: "datagma" };
  } catch {
    return null;
  }
}

async function enrowMobile(fullName: string, linkedinUrl?: string, domain?: string): Promise<MobileHit | null> {
  const key = env("ENROW_API_KEY");
  if (!key) return null;
  try {
    const res = await fetch("https://api.enrow.io/enrich/phone", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ fullname: fullName, linkedin_url: linkedinUrl, company_domain: domain }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.phone ?? data?.mobile ?? "";
    const n = digits(String(raw));
    if (n.length < 10 || isPns(n)) return null;
    return { e164: raw.startsWith("+") ? String(raw) : `+${n}`, display: formatInMobile(n), source: "enrow" };
  } catch {
    return null;
  }
}

async function closeOneHole(fullName: string, company: string | undefined, cands: string[]): Promise<string | null> {
  if (!cands.length || cands.length > 10) return null;
  try {
    const { decodoShards } = await import("./decodo-serp");
    const rows = (
      await decodoShards(cands.map((n) => `"${fullName}" "${n}"${company ? ` "${company}"` : ""}`))
    ).flat();
    const hits = cands.filter((n) =>
      rows.some((r) => {
        const blob = `${r.title ?? ""} ${r.description ?? ""}`;
        return nameOnCard(blob, fullName) && blob.replace(/\D/g, "").includes(n);
      }),
    );
    return hits.length === 1 ? hits[0]! : null;
  } catch {
    return null;
  }
}

async function tagWa(hit: MobileHit): Promise<MobileHit> {
  try {
    const { checkWhatsApp, waConfigured } = await import("./whatsapp-check");
    if (!waConfigured()) return hit;
    const w = await checkWhatsApp(hit.e164);
    if (w.exists === true) {
      return { ...hit, whatsapp: true, source: hit.source.includes("+wa") ? hit.source : `${hit.source}+wa` };
    }
    if (w.exists === false) return { ...hit, whatsapp: false };
  } catch {
    /* checker down */
  }
  return hit;
}

export async function findPersonMobile(opts: {
  fullName: string;
  company?: string;
  domain?: string;
  linkedinUrl?: string;
  email?: string;
  instagram?: string;
  serpRows?: Array<{ title?: string; description?: string; link?: string }>;
}): Promise<MobileHit | null> {
  const key = cacheKey({ fullName: opts.fullName, domain: opts.domain, linkedinUrl: opts.linkedinUrl });
  const cached = cacheGet(key);
  if (cached) return tagWa({ e164: cached.e164, display: cached.display, source: `${cached.source}+cache` });

  const paid = await Promise.all([
    rocketPersonMobile(opts),
    opts.linkedinUrl ? prospeoMobile(opts.linkedinUrl) : Promise.resolve(null),
    apolloMobile(opts.fullName, opts.domain),
    datagmaMobile(opts.fullName, opts.linkedinUrl, opts.domain),
    enrowMobile(opts.fullName, opts.linkedinUrl, opts.domain),
  ]);
  const hit = paid.find(Boolean);
  if (hit) {
    cacheSet(key, hit);
    return tagWa(hit);
  }
  try {
    const { publicPhones } = await import("./phone-public");
    const pub = await publicPhones({
      fullName: opts.fullName,
      company: opts.company,
      domain: opts.domain,
    });
    if (pub && isInMobile(pub.e164)) {
      cacheSet(key, pub);
      return tagWa(pub);
    }
  } catch {
    /* */
  }
  let rows = opts.serpRows ?? [];
  if (!rows.length) {
    try {
      const { decodoShards } = await import("./decodo-serp");
      rows = (
        await decodoShards(
          [
            `"${opts.fullName}"${opts.company ? ` "${opts.company}"` : ""} (phone OR mobile OR "+91")`,
            `site:rocketreach.co "${opts.fullName}"${opts.company ? ` "${opts.company}"` : ""}`,
            `site:zoominfo.com "${opts.fullName}"${opts.company ? ` "${opts.company}"` : ""} ("headquarters phone" OR mobile)`,
            `site:datanyze.com/people "${opts.fullName}"`,
            `site:easyleadz.com "${opts.fullName}"`,
            `site:fastpeoplesearch.com "${opts.fullName}"`,
            `site:thatsthem.com "${opts.fullName}"`,
            `"${opts.fullName}" ("ending in" OR "ends in" OR "last 4" OR "******") (phone OR mobile OR +91)`,
            `"${opts.fullName}" ("we will send a code" OR "text a code" OR "number ending")`,
            opts.company ? `"${opts.company}" "headquarters phone"` : "",
          ].filter((q) => q.replace(/["\s]/g, "").length > 8),
        )
      ).flat();
    } catch {
      rows = [];
    }
  }
  const fromSerp = phonesFromCards(rows, opts.fullName, opts.company).filter((h) => isInMobile(h.e164));
  if (fromSerp[0]) {
    cacheSet(key, fromSerp[0]!);
    return tagWa(fromSerp[0]!);
  }

  const parts = collectStitchParts(rows, opts.fullName, opts.company);
  const rrHtml = await rocketreachPrefixes(rows, opts.fullName);
  parts.prefixes.push(...rrHtml);
  try {
    const hints = await recoveryHints({
      email: opts.email,
      instagram: opts.instagram,
      linkedinUrl: opts.linkedinUrl,
    });
    parts.suffixes.push(...hints.map((h) => h.raw));
  } catch {
    /* proxy empty or blocked */
  }
  const prefixes = [...new Set(parts.prefixes)];
  const extra = prefixes.length ? parts.hqFull : [];
  const stitched = stitchBest(prefixes, [...parts.suffixes, ...extra]);
  if (stitched.number && isInMobile(stitched.number)) {
    const out = { e164: `+91${stitched.number}`, display: formatInMobile(stitched.number), source: stitched.source };
    cacheSet(key, out);
    return tagWa(out);
  }
  if (stitched.candidates.length) {
    const closed = await closeOneHole(opts.fullName, opts.company, stitched.candidates);
    if (closed) {
      const out = { e164: `+91${closed}`, display: formatInMobile(closed), source: "mask-stitch+serp" };
      cacheSet(key, out);
      return tagWa(out);
    }
  }
  return null;
}
