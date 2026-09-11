/**
 * Published-identity phones (Gravatar-shaped): the person or their card
 * printed the number. Company footer / "call us" CTAs are not used.
 */

import { resilientFetch } from "./http";
import { formatInMobile, isInMobile, phonesFromCards, type MobileHit } from "./phone-waterfall";
import { looksLikeInternalId } from "./phone-identity";

function isPns(n: string): boolean {
  const ten = n.replace(/\D/g, "");
  const d = ten.length === 12 && ten.startsWith("91") ? ten.slice(2) : ten;
  return /^(8047|8069|8882|8884)/.test(d) || /^(1800|1860|140)/.test(d);
}

function digits(s: string): string {
  return s.replace(/\D/g, "");
}

function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tenOf(s: string): string | null {
  const n = digits(s);
  const ten = n.length === 12 && n.startsWith("91") ? n.slice(2) : n.length === 11 && n.startsWith("1") ? n : n;
  if (ten.length === 10 && /^[6-9]/.test(ten) && !isPns(ten) && !looksLikeInternalId(ten)) return ten;
  if (n.length === 11 && n.startsWith("1") && !looksLikeInternalId(n)) return n;
  return null;
}

function phonesNearName(blob: string, fullName: string): string[] {
  const hay = blob.replace(/\s+/g, " ");
  const name = fullName.trim();
  if (name.length < 5) return [];
  const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(hay))) {
    const win = hay.slice(Math.max(0, m.index - 70), m.index + name.length + 90);
    for (const raw of win.match(/\+91[\s-]*[6-9]\d(?:[\s-]?\d){8}|\b[6-9]\d{9}\b|\+1[\s.(]*\d{3}[\s.)-]*\d{3}[\s-]*\d{4}/g) ?? []) {
      const t = tenOf(raw);
      if (t) out.add(t);
    }
  }
  return [...out];
}

function hit(ten: string, source: string): MobileHit {
  const inMob = isInMobile(ten);
  return {
    e164: inMob ? `+91${ten}` : ten.startsWith("1") ? `+${ten}` : `+${ten}`,
    display: inMob ? formatInMobile(ten) : formatInMobile(ten),
    source,
  };
}

export async function jsonLdPersonPhone(domain: string, fullName: string): Promise<MobileHit[]> {
  if (!domain || !fullName) return [];
  const host = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const paths = ["/", "/about", "/about-us", "/team", "/contact", "/our-team"];
  const out: MobileHit[] = [];
  for (const path of paths) {
    try {
      const page = await resilientFetch(`https://${host}${path}`, { timeoutMs: 8000, maxAttempts: 1, preferBot: true });
      if (!page.ok) continue;
      const html = page.body;
      for (const block of html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? []) {
        const json = block.replace(/<script[^>]*>|<\/script>/gi, "");
        let data: unknown;
        try {
          data = JSON.parse(json);
        } catch {
          continue;
        }
        const nodes = Array.isArray(data) ? data : [data];
        const walk = (n: unknown) => {
          if (!n || typeof n !== "object") return;
          const o = n as Record<string, unknown>;
          if (Array.isArray(o["@graph"])) o["@graph"].forEach(walk);
          const typ = String(o["@type"] ?? "");
          const nm = String(o.name ?? "");
          const tel = String(o.telephone ?? o.phone ?? "");
          if (/Person/i.test(typ) && nm && fullName.toLowerCase().split(/\s+/).every((t) => t.length < 3 || nm.toLowerCase().includes(t.toLowerCase()))) {
            const t = tenOf(tel);
            if (t) out.push(hit(t, "jsonld-person"));
          }
          for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
        };
        nodes.forEach(walk);
      }
      for (const ten of phonesNearName(html.replace(/<[^>]+>/g, " "), fullName)) {
        out.push(hit(ten, "site-hcard"));
      }
    } catch {
      /* */
    }
  }
  return out;
}

export async function socialPublishedPhones(opts: {
  fullName: string;
  company?: string;
  domain?: string;
}): Promise<MobileHit[]> {
  const { decodoSearch } = await import("./decodo-serp");
  const brand = opts.company || (opts.domain ?? "").split(".")[0] || "";
  const q = [
    `site:instagram.com "${opts.fullName}"${brand ? ` "${brand}"` : ""}`,
    `site:facebook.com "${opts.fullName}"${brand ? ` "${brand}"` : ""} (phone OR +91 OR call)`,
    `site:x.com "${opts.fullName}"${brand ? ` "${brand}"` : ""} (phone OR +91)`,
    `site:about.me "${opts.fullName}"${brand ? ` "${brand}"` : ""}`,
    `"${opts.fullName}"${brand ? ` "${brand}"` : ""} filetype:vcf`,
    `site:zoominfo.com/p "${opts.fullName}"${brand ? ` "${brand}"` : ""}`,
  ];
  const rows = (await Promise.all(q.map((x) => decodoSearch(x)))).flat();
  const out: MobileHit[] = [];
  const seen = new Set<string>();
  const brandLock = compact(brand);
  const domainLock = compact(opts.domain ?? "");
  for (const r of rows) {
    const blob = `${r.title ?? ""} ${r.description ?? ""} ${r.link ?? ""}`;
    const hay = compact(blob);
    if (brandLock.length >= 5 && !hay.includes(brandLock) && !(domainLock.length >= 5 && hay.includes(domainLock))) continue;
    const tens = phonesNearName(blob, opts.fullName);
    for (const ten of tens) {
      if (seen.has(ten)) continue;
      seen.add(ten);
      const host = (() => {
        try {
          return new URL(r.link ?? "https://serp.local").hostname.replace(/^www\./, "");
        } catch {
          return "serp";
        }
      })();
      out.push(hit(ten, host));
    }
  }
  const fromCards = phonesFromCards(rows, opts.fullName, opts.company);
  for (const h of fromCards) {
    const t = tenOf(h.e164);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(h);
    }
  }
  return out;
}

/** Founder/CEO: ZoomInfo HQ mobile is often the founder's cell (confirmed on Warewe). */
export async function founderHqMobile(opts: {
  fullName: string;
  company?: string;
  domain?: string;
  title?: string | null;
}): Promise<MobileHit | null> {
  const { decodoSearch } = await import("./decodo-serp");
  const brand = opts.company || (opts.domain ?? "").split(".")[0] || "";
  const first = opts.fullName.split(/\s+/)[0] ?? "";
  const rows = (
    await Promise.all([
      decodoSearch(`site:zoominfo.com "${brand || opts.fullName}" ("headquarters phone" OR "phone number")`),
      decodoSearch(`site:zoominfo.com "${opts.fullName}" ${brand} (phone OR mobile)`),
    ])
  ).flat();
  for (const r of rows) {
    const blob = `${r.title ?? ""} ${r.description ?? ""}`;
    const named = first.length > 2 && blob.toLowerCase().includes(first.toLowerCase());
    const founderish = /founder|ceo|owner|managing partner|headquarters phone/i.test(`${opts.title ?? ""} ${blob}`);
    if (!named || !founderish) continue;
    const m = blob.match(/\+91[\s-]*[6-9]\d(?:[\s-]?\d){8}|\b[6-9]\d{9}\b/);
    const t = m ? tenOf(m[0]!) : null;
    if (t && isInMobile(t)) return hit(t, "zoominfo-hq-founder");
  }
  return null;
}

function namesClose(a: string, b: string): boolean {
  const na = a.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const nb = b.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!na.length || !nb.length) return false;
  return na[0] === nb[0] && na[na.length - 1] === nb[nb.length - 1];
}

function handleFromUrl(url: string, hostRe: RegExp): string | null {
  const m = url.match(hostRe);
  if (!m?.[1]) return null;
  const h = m[1].replace(/^@/, "").split(/[/?#]/)[0] ?? "";
  if (h.length < 2 || h.length > 32) return null;
  if (/^(i|intent|share|search|hashtag|home|explore|status|s|joinchat)$/i.test(h)) return null;
  return h;
}

function phonesInBio(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.match(/\+91[\s-]*[6-9]\d(?:[\s-]?\d){8}|\b[6-9]\d{9}\b|\+1[\s.(]*\d{3}[\s.)-]*\d{3}[\s-]*\d{4}/g) ?? []) {
    const t = tenOf(raw);
    if (t && isInMobile(t)) out.add(t);
  }
  return [...out];
}

async function xProfile(handle: string): Promise<{
  name: string;
  bio: string;
  website: string;
  url: string;
} | null> {
  try {
    const res = await fetch(`https://api.fxtwitter.com/${encodeURIComponent(handle)}`, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mailgraph/1.0", Accept: "application/json" },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { user?: Record<string, unknown> };
    const u = j.user;
    if (!u) return null;
    const site = u.website as { url?: string; display_url?: string } | string | undefined;
    const website = typeof site === "string" ? site : site?.url || site?.display_url || "";
    return {
      name: String(u.name ?? ""),
      bio: String(u.description ?? ""),
      website,
      url: String(u.url ?? `https://x.com/${handle}`),
    };
  } catch {
    return null;
  }
}

async function telegramAbout(handle: string): Promise<{ name: string; bio: string; url: string } | null> {
  try {
    const page = await resilientFetch(`https://t.me/${encodeURIComponent(handle)}`, { timeoutMs: 8000, maxAttempts: 1 });
    if (!page.ok) return null;
    const html = page.body;
    const name =
      html.match(/property="og:title" content="([^"]+)"/i)?.[1]?.replace(/^Telegram:\s*Contact\s*/i, "") ??
      handle;
    const bio =
      html.match(/property="og:description" content="([^"]*)"/i)?.[1] ??
      html.match(/tgme_page_description[^>]*>([\s\S]*?)<\/div>/i)?.[1]?.replace(/<[^>]+>/g, " ") ??
      "";
    if (/If you have Telegram, you can contact/i.test(bio) && bio.length < 80) {
      /* empty user, no public about */
    }
    return { name: name.replace(/&/g, "&").trim(), bio: bio.replace(/&/g, "&").replace(/\s+/g, " ").trim(), url: `https://t.me/${handle}` };
  } catch {
    return null;
  }
}

function identityOk(opts: {
  displayName: string;
  fullName: string;
  bio: string;
  website?: string;
  company?: string;
  domain?: string;
}): boolean {
  if (!namesClose(opts.displayName, opts.fullName) && !namesClose(opts.bio.slice(0, 80), opts.fullName)) return false;
  const hay = compact(`${opts.bio} ${opts.website ?? ""} ${opts.displayName}`);
  const brand = compact(opts.company ?? "");
  const dom = compact((opts.domain ?? "").split(".")[0] ?? "");
  const host = compact(opts.domain ?? "");
  if (host.length >= 5 && hay.includes(host)) return true;
  if (brand.length >= 5 && hay.includes(brand)) return true;
  if (dom.length >= 5 && hay.includes(dom)) return true;
  /* queried with an employer — don't attach a same-name stranger */
  if (brand.length >= 4 || host.length >= 4) return false;
  return namesClose(opts.displayName, opts.fullName);
}

/** Public X + Telegram bios. APIs never return the private phone; only digits the user printed. */
export async function xTelegramPhones(opts: {
  fullName: string;
  company?: string;
  domain?: string;
  twitter?: string;
  telegram?: string;
}): Promise<MobileHit[]> {
  const { decodoSearch } = await import("./decodo-serp");
  const brand = opts.company || (opts.domain ?? "").split(".")[0] || "";
  const rows = (
    await Promise.all([
      decodoSearch(`site:x.com "${opts.fullName}"${brand ? ` "${brand}"` : ""}`),
      decodoSearch(`site:twitter.com "${opts.fullName}"${brand ? ` "${brand}"` : ""}`),
      decodoSearch(`site:t.me "${opts.fullName}"${brand ? ` "${brand}"` : ""}`),
    ])
  ).flat();
  const xHandles = new Set<string>();
  const tgHandles = new Set<string>();
  if (opts.twitter) xHandles.add(opts.twitter.replace(/^@/, ""));
  if (opts.telegram) tgHandles.add(opts.telegram.replace(/^@/, ""));
  for (const r of rows) {
    const x = handleFromUrl(r.link ?? "", /(?:x|twitter)\.com\/(?:#!\/)?([A-Za-z0-9_]{2,32})/i);
    const tg = handleFromUrl(r.link ?? "", /t(?:elegram)?\.me\/([A-Za-z0-9_]{2,32})/i);
    if (x) xHandles.add(x);
    if (tg) tgHandles.add(tg);
  }
  const out: MobileHit[] = [];
  const seen = new Set<string>();
  await Promise.all([
    ...[...xHandles].slice(0, 6).map(async (h) => {
      const p = await xProfile(h);
      if (!p) return;
      if (!identityOk({ displayName: p.name, fullName: opts.fullName, bio: p.bio, website: p.website, company: opts.company, domain: opts.domain }))
        return;
      for (const ten of phonesInBio(`${p.bio} ${p.website}`)) {
        if (seen.has(ten)) continue;
        seen.add(ten);
        out.push(hit(ten, `x.com/${h}`));
      }
    }),
    ...[...tgHandles].slice(0, 6).map(async (h) => {
      const p = await telegramAbout(h);
      if (!p) return;
      if (!identityOk({ displayName: p.name, fullName: opts.fullName, bio: p.bio, company: opts.company, domain: opts.domain }))
        return;
      for (const ten of phonesInBio(p.bio)) {
        if (seen.has(ten)) continue;
        seen.add(ten);
        out.push(hit(ten, `t.me/${h}`));
      }
    }),
  ]);
  return out;
}

export async function publicPhones(opts: {
  fullName: string;
  company?: string;
  domain?: string;
  title?: string | null;
  twitter?: string;
  telegram?: string;
}): Promise<MobileHit | null> {
  const [ld, social, hq, xt] = await Promise.all([
    opts.domain ? jsonLdPersonPhone(opts.domain, opts.fullName) : Promise.resolve([]),
    socialPublishedPhones(opts),
    founderHqMobile(opts),
    xTelegramPhones(opts),
  ]);
  return hq ?? ld[0] ?? social[0] ?? xt[0] ?? null;
}
