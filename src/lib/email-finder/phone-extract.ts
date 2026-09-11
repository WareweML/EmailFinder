/**
 * Public phone extraction from company website contact surfaces.
 */

import { resilientFetch, mapPool } from "./http";

export interface PhoneHit {
  phone: string;
  e164ish: string;
  sourceUrl: string;
  confidence: number;
}

export interface PhoneExtractResult {
  domain: string;
  phones: PhoneHit[];
  durationMs: number;
}

const PHONE_RE =
  /(?:\+?\d{1,3}[\s\-.]?)?(?:\(?\d{2,5}\)?[\s\-.]?)?\d{3,5}[\s\-.]?\d{3,5}(?:[\s\-.]?\d{2,5})?/g;

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  const only = digits.replace(/\D/g, "");
  if (only.length < 10 || only.length > 15) return null;
  // drop obvious years / order ids
  if (/^(19|20)\d{2}$/.test(only)) return null;
  if (only.startsWith("000") || only.startsWith("111111")) return null;
  return raw.replace(/\s+/g, " ").trim().slice(0, 24);
}

function e164ish(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+91${d}`; // default IN bias for this product use; still labeled ish
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 12 && d.startsWith("91")) return `+${d}`;
  return d.startsWith("+") ? raw : `+${d}`;
}

export async function extractPhones(
  domainInput: string,
): Promise<PhoneExtractResult> {
  const t0 = Date.now();
  const domain = domainInput
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();

  const paths = [
    "",
    "/contact",
    "/contact-us",
    "/contactus",
    "/about",
    "/about-us",
    "/support",
    "/company",
  ];
  const urls = paths.map((p) => `https://${domain}${p}`);

  const pages = await mapPool(urls, 4, async (url) => {
    const res = await resilientFetch(url, {
      timeoutMs: 9000,
      maxAttempts: 2,
      preferBot: true,
    });
    return { url: res.url || url, ok: res.ok, body: res.body };
  });

  const hits = new Map<string, PhoneHit>();

  const add = (raw: string, sourceUrl: string, confidence: number) => {
    const norm = normalizePhone(raw);
    if (!norm) return;
    const key = norm.replace(/\D/g, "").replace(/^0+/, "");
    const prev = hits.get(key);
    if (prev && prev.confidence >= confidence) return;
    hits.set(key, { phone: e164ish(norm).startsWith("+") ? formatIn(norm) : norm, e164ish: e164ish(norm), sourceUrl, confidence });
  };

  function formatIn(raw: string): string {
    const d = raw.replace(/\D/g, "");
    if (d.length === 10 && /^[6-9]/.test(d)) return `+91 ${d}`;
    if (d.length === 12 && d.startsWith("91")) return `+${d.slice(0, 2)} ${d.slice(2)}`;
    if (d.length === 11 && d.startsWith("0")) return `+91 ${d.slice(1)}`;
    return raw.replace(/\s+/g, " ").trim();
  }

  for (const page of pages) {
    if (!page.ok || page.body.length < 100) continue;
    for (const m of page.body.matchAll(/href=["']tel:([^"']+)["']/gi)) {
      add(decodeURIComponent(m[1]).trim(), page.url, 92);
    }
    const text = page.body
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ");
    const contactish = /phone|call|tel|mobile|whatsapp|contact|hq|office/i.test(text);
    for (const m of text.matchAll(PHONE_RE)) {
      if (!contactish) continue;
      add(m[0], page.url, 70);
    }
  }

  try {
    const { decodoSearch } = await import("./decodo-serp");
    const stem = domain.split(".")[0] ?? domain;
    const rows = await decodoSearch(`site:zoominfo.com/c "${stem}" OR site:zoominfo.com "${domain}" ("phone number" OR phone)`);
    for (const r of rows.slice(0, 6)) {
      const url = (r.link ?? "").split("?")[0] ?? "";
      if (!/zoominfo\.com\/(c|pic)\//i.test(url)) continue;
      const blob = `${r.title ?? ""} ${r.description ?? ""}`;
      if (!new RegExp(stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(`${blob} ${url}`)) continue;
      for (const m of blob.matchAll(/\+91[\s.-]*([6-9]\d{4})[\s.-]*(\d{5})/g)) {
        add(`+91 ${m[1]}${m[2]}`, url, 88);
      }
      for (const m of blob.matchAll(/\+91[\s.-]*([6-9]\d{9})\b/g)) {
        add(`+91 ${m[1]}`, url, 88);
      }
    }
  } catch {
    /* zoominfo serp optional */
  }

  const ranked = [...hits.values()].sort((a, b) => {
    const isMobile = (p: PhoneHit) => {
      const d = p.e164ish.replace(/\D/g, "").replace(/^91/, "");
      return d.length === 10 && /^[6-9]/.test(d);
    };
    const am = isMobile(a);
    const bm = isMobile(b);
    if (am !== bm) return am ? -1 : 1;
    return b.confidence - a.confidence;
  });

  return {
    domain,
    phones: ranked,
    durationMs: Date.now() - t0,
  };
}
