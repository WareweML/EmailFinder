/**
 * Browser SERP fallback when plain fetch is bot-blocked.
 * Uses Playwright (available in this environment) against Startpage —
 * same query a human runs: site:linkedin.com {brand}
 */

import type { SerpPerson } from "./serp";
import { parseFullName } from "./normalize";
import { nameFromSlug } from "./linkedin";

function cleanName(n: string): string | null {
  const s = n.replace(/\s+/g, " ").trim();
  if (s.length < 3 || s.length > 48) return null;
  if (/linkedin|india|https|www\.|passionate|research/i.test(s)) return null;
  const p = parseFullName(s);
  if (!p.first || !p.last) return null;
  return `${p.first} ${p.last}`;
}

export async function serpDiscoverPeopleBrowser(
  brand: string,
): Promise<{ people: SerpPerson[]; detail: string; ms: number }> {
  const t0 = Date.now();
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        viewport: { width: 1360, height: 900 },
      });

      const queries = [
        `site:linkedin.com ${brand}`,
        `site:linkedin.com/in ${brand}`,
        `site:linkedin.com ${brand} consultancy`,
      ];

      const peopleMap = new Map<string, SerpPerson>();

      for (const q of queries) {
        await page.goto(
          `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}&language=english`,
          { waitUntil: "domcontentloaded", timeout: 40000 },
        );
        await page.waitForTimeout(1800);

        const rows = await page.evaluate(() => {
          const out: Array<{ href: string; aText: string; block: string }> =
            [];
          for (const a of document.querySelectorAll(
            "a[href*='linkedin.com/in']",
          )) {
            let el: HTMLElement | null = a as HTMLElement;
            let blockText = (a as HTMLAnchorElement).innerText || "";
            for (let i = 0; i < 6; i++) {
              el = el.parentElement;
              if (!el) break;
              const t = el.innerText || "";
              if (t.length > blockText.length && t.length < 900) blockText = t;
              if (t.length > 100 && t.length < 700) break;
            }
            out.push({
              href: (a as HTMLAnchorElement).href,
              aText: ((a as HTMLAnchorElement).innerText || "").trim(),
              block: blockText.replace(/\n+/g, " | ").slice(0, 500),
            });
          }
          return out;
        });

        for (const r of rows) {
          if (!new RegExp(brand, "i").test(r.block + r.aText))
            continue;
          const m = r.href.match(/linkedin\.com\/in\/([^/?#]+)/i);
          if (!m) continue;
          const slug = decodeURIComponent(m[1]);

          // Prefer "Name - Role ... Brand" in block
          const hit = r.block.match(
            /([A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+){1,3})\s*[-–|]\s*([^|]{0,120})/i,
          );
          let fullName: string | null = null;
          let title: string | undefined;
          let current = true;
          if (hit) {
            fullName = cleanName(hit[1]);
            title = hit[2].replace(/\s*\|\s*LinkedIn.*/i, "").trim();
            current = !/\b(ex[- ]|former)\b/i.test(title);
          } else {
            const guessed = nameFromSlug(slug);
            if (guessed?.first && guessed?.last) {
              fullName = `${guessed.first} ${guessed.last}`;
            }
          }
          if (!fullName) continue;
          const p = parseFullName(fullName);
          if (!p.first || !p.last) continue;
          const key = `${p.first}|${p.last}`.toLowerCase();
          if (peopleMap.has(key)) {
            const ex = peopleMap.get(key)!;
            if (title && !ex.title) ex.title = title;
            continue;
          }
          peopleMap.set(key, {
            fullName: `${p.first} ${p.last}`,
            firstName: p.first,
            lastName: p.last,
            title,
            profileUrl: `https://www.linkedin.com/in/${slug}/`,
            network: "linkedin",
            evidence: `site:linkedin.com ${brand} (browser SERP)`,
            engine: "startpage-browser",
            current,
          });
        }
      }

      const people = [...peopleMap.values()];
      return {
        people,
        detail: people.length
          ? `${people.length} LinkedIn people via browser SERP (Startpage)`
          : "Browser SERP returned no LinkedIn people",
        ms: Date.now() - t0,
      };
    } finally {
      await browser.close();
    }
  } catch (e) {
    return {
      people: [],
      detail: `Browser SERP failed: ${e instanceof Error ? e.message : "error"}`,
      ms: Date.now() - t0,
    };
  }
}
