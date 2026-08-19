/**
 * Hunter public trial (no API key).
 * Domain search: count + masked preview.
 * Email finder: real emails (Turnstile via CaptchaAI).
 */

const CAPTCHA_KEY = process.env.CAPTCHAAI_KEY ?? "";
const SITEKEY = "0x4AAAAAACJuzD6q_C753fUM";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type HunterFind = {
  email: string;
  fullName: string;
  score?: number;
  linkedinUrl?: string;
};

export async function solveTurnstile(pageurl: string): Promise<string | null> {
  if (!CAPTCHA_KEY) return null;
  try {
    const inn = await fetch("https://ocr.captchaai.com/in.php", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        key: CAPTCHA_KEY,
        method: "turnstile",
        sitekey: SITEKEY,
        pageurl,
        json: "1",
      }),
    });
    const j = (await inn.json()) as { status?: number; request?: string };
    const id = j.request;
    if (!id || j.status !== 1) return null;
    for (let i = 0; i < 18; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const poll = await fetch(
        `https://ocr.captchaai.com/res.php?key=${CAPTCHA_KEY}&action=get&id=${id}&json=1`,
        { signal: AbortSignal.timeout(10_000) },
      );
      const p = (await poll.json()) as { status?: number; request?: string };
      if (p.status === 1 && p.request) return p.request;
      if (p.request && !/NOT_READY/i.test(p.request) && p.status === 1) {
        return p.request;
      }
    }
  } catch {
    /* none */
  }
  return null;
}

function pick(html: string, re: RegExp): string | undefined {
  return html.match(re)?.[1]?.trim();
}

export async function hunterDomainCount(
  domain: string,
  token: string,
): Promise<number | null> {
  try {
    const url =
      `https://hunter.io/trial/v2/domain-search.html?domain=${encodeURIComponent(domain)}` +
      `&cf-turnstile-response=${encodeURIComponent(token)}&locale=en`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": UA, Referer: "https://hunter.io/try/search/" + domain },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<strong>([\d,]+)\s*results?<\/strong>/i);
    if (!m) return null;
    return Number(m[1].replace(/,/g, ""));
  } catch {
    return null;
  }
}

export async function hunterFindEmail(
  domain: string,
  fullName: string,
  token: string,
): Promise<HunterFind | null> {
  try {
    const url =
      `https://hunter.io/trial/v2/email-finder.html?domain=${encodeURIComponent(domain)}` +
      `&full_name=${encodeURIComponent(fullName)}` +
      `&cf-turnstile-response=${encodeURIComponent(token)}&locale=en`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { "User-Agent": UA, Referer: "https://hunter.io/email-finder" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const email = pick(html, /name="lead\[email\]"[^>]*value="([^"]+@[^"]+)"/i);
    if (!email) return null;
    return {
      email: email.toLowerCase(),
      fullName:
        pick(html, /ds-result__fullname">([^<]+)/) ?? fullName,
      score: Number(pick(html, /lead\[confidence_score\]"[^>]*value="(\d+)"/) ?? ""),
      linkedinUrl: pick(html, /lead\[linkedin_url\]"[^>]*value="([^"]+)"/),
    };
  } catch {
    return null;
  }
}

export async function hunterTrialEnrich(
  domain: string,
  names: string[],
): Promise<{ count: number | null; finds: HunterFind[]; detail: string }> {
  const token = await solveTurnstile("https://hunter.io/email-finder");
  if (!token) return { count: null, finds: [], detail: "hunter trial: no turnstile" };
  const uniq = [...new Set(names.filter((n) => n.split(/\s+/).length >= 2))].slice(
    0,
    12,
  );
  const [count, ...finds] = await Promise.all([
    hunterDomainCount(domain, token),
    ...uniq.map((n) => hunterFindEmail(domain, n, token)),
  ]);
  const ok = finds.filter((x): x is HunterFind => Boolean(x && x.email));
  return {
    count: typeof count === "number" ? count : null,
    finds: ok,
    detail: `hunter trial ${ok.length} emails · index ${count ?? "?"}`,
  };
}
