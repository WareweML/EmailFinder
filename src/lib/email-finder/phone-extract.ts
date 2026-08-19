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

  for (const page of pages) {
    if (!page.ok || page.body.length < 100) continue;
    // tel: links first — highest confidence
    for (const m of page.body.matchAll(/href=["']tel:([^"']+)["']/gi)) {
      const raw = decodeURIComponent(m[1]).trim();
      const norm = normalizePhone(raw);
      if (!norm) continue;
      const key = norm.replace(/\D/g, "");
      hits.set(key, {
        phone: norm,
        e164ish: e164ish(norm),
        sourceUrl: page.url,
        confidence: 92,
      });
    }
    // visible text phones near contact keywords
    const text = page.body
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ");
    const contactish = /phone|call|tel|mobile|whatsapp|contact|hq|office/i.test(
      text,
    );
    for (const m of text.matchAll(PHONE_RE)) {
      const norm = normalizePhone(m[0]);
      if (!norm) continue;
      const key = norm.replace(/\D/g, "");
      if (hits.has(key)) continue;
      const conf = contactish ? 70 : 45;
      if (conf < 50) continue;
      hits.set(key, {
        phone: norm,
        e164ish: e164ish(norm),
        sourceUrl: page.url,
        confidence: conf,
      });
    }
  }

  return {
    domain,
    phones: [...hits.values()].sort((a, b) => b.confidence - a.confidence),
    durationMs: Date.now() - t0,
  };
}
