/**
 * SERP people discovery — human trick:
 *   site:linkedin.com {company}
 * Fetch first; if blocked, Playwright browser fallback.
 */

import { nameFromSlug } from "./linkedin";
import { parseFullName } from "./normalize";
import { resilientFetch } from "./http";
import { serpDiscoverPeopleBrowser } from "./serp-browser";

export interface SerpPerson {
  fullName: string;
  firstName: string;
  lastName: string;
  title?: string;
  companyHint?: string;
  profileUrl: string;
  network: "linkedin" | "other";
  evidence: string;
  engine: string;
  current: boolean;
}

export interface SerpResult {
  people: SerpPerson[];
  companyPages: string[];
  durationMs: number;
  detail: string;
  enginesUsed: string[];
}

function cleanName(n: string): string | null {
  const s = n.replace(/\s+/g, " ").trim();
  if (s.length < 3 || s.length > 50) return null;
  if (/linkedin|india|https|www\.|passionate|research|about/i.test(s))
    return null;
  const p = parseFullName(s);
  if (!p.first || !p.last) return null;
  if (p.first.length < 2 || p.last.length < 2) return null;
  return `${p.first} ${p.last}`;
}

function extractFromStartpageHtml(
  html: string,
  brand: string,
  engine: string,
): SerpPerson[] {
  const people: SerpPerson[] = [];
  const seen = new Set<string>();
  const brandRe = new RegExp(brand, "i");

  const slugWindows = new Map<string, string>();
  for (const m of html.matchAll(
    /linkedin\.com\/in\/([a-zA-Z0-9_%\-]+)/gi,
  )) {
    const slug = decodeURIComponent(m[1]);
    const i = m.index ?? 0;
    slugWindows.set(slug, html.slice(Math.max(0, i - 400), i + 500));
  }

  for (const [slug, win] of slugWindows) {
    const plain = win
      .replace(/<[^>]+>/g, " | ")
      .replace(/\s+/g, " ")
      .replace(/\|+/g, "|");
    const hit = plain.match(
      /([A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+){1,3})\s*[-–|]\s*([^|]{0,100})/i,
    );
    let name: string | null = null;
    let role: string | null = null;
    let current = true;
    if (hit) {
      name = cleanName(hit[1]);
      role = hit[2].replace(/\s*\|\s*LinkedIn.*/i, "").trim();
      current = !/\b(ex[- ]|former)\b/i.test(role);
    } else {
      const guessed = nameFromSlug(slug);
      if (guessed?.first && guessed?.last) {
        if (!brandRe.test(plain)) continue;
        name = `${guessed.first} ${guessed.last}`;
      }
    }
    if (!name) continue;
    if (!brandRe.test(plain) && !role) continue;
    const p = parseFullName(name);
    if (!p.first || !p.last) continue;
    const key = `${p.first}|${p.last}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({
      fullName: `${p.first} ${p.last}`,
      firstName: p.first,
      lastName: p.last,
      title: role ?? undefined,
      profileUrl: `https://www.linkedin.com/in/${slug}/`,
      network: "linkedin",
      evidence: `site:linkedin.com ${brand} via ${engine}`,
      engine,
      current,
    });
  }
  return people;
}

export async function serpDiscoverPeople(
  domain: string,
  brand: string,
): Promise<SerpResult> {
  const t0 = Date.now();
  const brandQ = brand || domain.split(".")[0] || domain;
  const queries = [
    `site:linkedin.com ${brandQ}`,
    `site:linkedin.com/in "${brandQ}"`,
    `site:linkedin.com ${brandQ} consultancy`,
  ];

  const peopleMap = new Map<string, SerpPerson>();
  const companyPages = new Set<string>();
  const enginesUsed = new Set<string>();

  for (const q of queries) {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    let html = "";
    try {
      const { braveShards } = await import("./okk-serp");
      const [hit] = await braveShards([q]);
      if (hit?.html) html = hit.html.slice(0, 200_000);
    } catch {
      html = "";
    }
    if (html.length < 800) {
      const url = `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}&language=english`;
      const res = await resilientFetch(url, {
        timeoutMs: 14000,
        maxAttempts: 2,
        preferBot: false,
      });
      if (!res.ok || res.body.length < 5000) continue;
      if (
        /captcha|verify you|unusual traffic|enable javascript/i.test(
          res.body.slice(0, 3000),
        ) &&
        res.body.length < 40000
      ) {
        continue;
      }
      html = res.body;
      enginesUsed.add("startpage-fetch");
    } else {
      enginesUsed.add("brave-okk");
    }
    for (const m of html.matchAll(
      /linkedin\.com\/company\/([a-zA-Z0-9_%\-]+)/gi,
    )) {
      companyPages.add(
        `https://www.linkedin.com/company/${decodeURIComponent(m[1])}/`,
      );
    }
    for (const p of extractFromStartpageHtml(html, brandQ, "serp")) {
      peopleMap.set(`${p.firstName}|${p.lastName}`.toLowerCase(), p);
    }
  }

  // Browser fallback when fetch is empty/blocked
  if (peopleMap.size === 0) {
    const browser = await serpDiscoverPeopleBrowser(brandQ);
    enginesUsed.add("startpage-browser");
    for (const p of browser.people) {
      peopleMap.set(`${p.firstName}|${p.lastName}`.toLowerCase(), p);
    }
    if (browser.people.length === 0) {
      return {
        people: [],
        companyPages: [...companyPages],
        durationMs: Date.now() - t0,
        detail: browser.detail,
        enginesUsed: [...enginesUsed],
      };
    }
  }

  const people = [...peopleMap.values()].sort((a, b) => {
    const score = (p: SerpPerson) => {
      let s = 0;
      if (p.current) s += 10;
      if (/founder|ceo|cco|cto|vp|director/i.test(p.title ?? "")) s += 8;
      if (/\b(ex[- ]|former)/i.test(p.title ?? "")) s -= 5;
      return s;
    };
    return score(b) - score(a);
  });

  return {
    people,
    companyPages: [...companyPages],
    durationMs: Date.now() - t0,
    detail: `${people.length} people from site:linkedin.com SERP (${[...enginesUsed].join(", ")})`,
    enginesUsed: [...enginesUsed],
  };
}
