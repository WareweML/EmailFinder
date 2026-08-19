import { chromium } from "playwright";
import fs from "fs";
import { lookupMx } from "../src/lib/email-finder/dns.ts";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
});

const urls = [
  "https://warewe.com/about-us/",
  "https://warewe.com/content-business-toolbox/",
  "https://warewe.com/e-comm-business-toolbox/",
  "https://warewe.com/hetrolinks/",
  "https://warewe.com/serpwe/",
  "https://warewe.com/sellerwe/",
  "https://warewe.com/duptext/",
  "https://warewe.com/established-websites-for-sale/",
  "https://warewe.com/sign-up/",
  "https://warewe.com/",
];

const dump = {};
for (const url of urls) {
  try {
    const res = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });
    await page.waitForTimeout(700);
    const text = await page.locator("body").innerText();
    const html = await page.content();
    const title = await page.title();
    const tech = {
      wordpress: /wp-content|wp-includes/i.test(html),
      woocommerce:
        /woocommerce|wc-ajax|wc-blocks/i.test(html) &&
        !/shopify-vs-woocommerce/i.test(html),
      cloudflare: /cloudflareinsights|cdnjs\.cloudflare/i.test(html),
      gtm: /googletagmanager/i.test(html),
      ga: /google-analytics|gtag\(/i.test(html),
      generator:
        (html.match(
          /name=["']generator["'][^>]+content=["']([^"']+)/i,
        ) || [])[1] || null,
      theme:
        (html.match(/\/wp-content\/themes\/([^/"']+)/i) || [])[1] || null,
    };
    dump[url] = { status: res?.status(), title, tech, text: text.slice(0, 5000) };
    console.log(res?.status(), title.slice(0, 55), JSON.stringify(tech));
  } catch (e) {
    dump[url] = { error: e.message };
    console.log("ERR", url, e.message);
  }
}

try {
  await page.goto("https://api.github.com/users/warewe/repos?per_page=20", {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });
  const t = await page.locator("body").innerText();
  dump.github = JSON.parse(t).map((r) => ({
    name: r.name,
    desc: r.description,
    lang: r.language,
    stars: r.stargazers_count,
    updated: r.updated_at,
    url: r.html_url,
  }));
  console.log("github", dump.github);
} catch (e) {
  dump.githubErr = e.message;
}

dump.mx = await lookupMx("warewe.com");
console.log("mx", dump.mx.provider, dump.mx.mxHosts?.map((h) => h.exchange));

fs.writeFileSync(
  "/workspace/data/warewe-products-team.json",
  JSON.stringify(dump, null, 2),
);
await browser.close();
