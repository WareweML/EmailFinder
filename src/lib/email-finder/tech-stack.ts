/**
 * Tech-stack fingerprint — tighter rules to avoid content false positives
 * (e.g. blog "Shopify vs WooCommerce" must not mark WooCommerce installed).
 */

import { resilientFetch } from "./http";

export interface TechHit {
  name: string;
  category: string;
  evidence: string;
  confidence: number;
}

export interface TechStackResult {
  domain: string;
  technologies: TechHit[];
  durationMs: number;
  sources: string[];
}

type Rule = {
  name: string;
  category: string;
  /** Strong signals only */
  test: (html: string) => string | null;
  confidence: number;
};

const RULES: Rule[] = [
  {
    name: "WordPress",
    category: "CMS",
    confidence: 95,
    test: (h) =>
      /\/wp-content\/|\/wp-includes\//i.test(h)
        ? "wp-content / wp-includes paths"
        : null,
  },
  {
    name: "WooCommerce",
    category: "Ecommerce",
    confidence: 90,
    test: (h) => {
      // Require real plugin assets, not blog article mentions
      if (
        /\/wp-content\/plugins\/woocommerce\//i.test(h) ||
        /wc-ajax=|woocommerce-js|wc-blocks/i.test(h)
      ) {
        return "WooCommerce plugin assets";
      }
      return null;
    },
  },
  {
    name: "Shopify",
    category: "Ecommerce",
    confidence: 95,
    test: (h) =>
      /cdn\.shopify\.com|Shopify\.theme|myshopify\.com/i.test(h)
        ? "Shopify CDN / theme"
        : null,
  },
  {
    name: "Cloudflare",
    category: "Infrastructure",
    confidence: 85,
    test: (h) =>
      /cloudflareinsights\.com|cdnjs\.cloudflare\.com|cf-beacon/i.test(h)
        ? "Cloudflare beacon/CDN"
        : null,
  },
  {
    name: "Next.js",
    category: "Framework",
    confidence: 95,
    test: (h) =>
      /_next\/static|__NEXT_DATA__/i.test(h) ? "Next.js assets" : null,
  },
  {
    name: "React",
    category: "Framework",
    confidence: 70,
    test: (h) =>
      /react(?:\.production)?\.min\.js|data-reactroot/i.test(h)
        ? "React runtime"
        : null,
  },
  {
    name: "Google Tag Manager",
    category: "Analytics",
    confidence: 95,
    test: (h) =>
      /googletagmanager\.com\/gtm\.js/i.test(h) ? "GTM script" : null,
  },
  {
    name: "Google Analytics",
    category: "Analytics",
    confidence: 90,
    test: (h) =>
      /google-analytics\.com\/analytics\.js|gtag\/js\?id=/i.test(h)
        ? "GA script"
        : null,
  },
  {
    name: "HubSpot",
    category: "Marketing",
    confidence: 95,
    test: (h) =>
      /js\.hs-scripts\.com|hs-scripts\.com/i.test(h) ? "HubSpot JS" : null,
  },
  {
    name: "Intercom",
    category: "Support",
    confidence: 95,
    test: (h) =>
      /widget\.intercom\.io|intercomSettings/i.test(h) ? "Intercom" : null,
  },
  {
    name: "Stripe",
    category: "Payments",
    confidence: 95,
    test: (h) => (/js\.stripe\.com/i.test(h) ? "Stripe.js" : null),
  },
  {
    name: "jQuery",
    category: "Library",
    confidence: 80,
    test: (h) =>
      /\/jquery(?:\.min)?\.js/i.test(h) ? "jQuery script" : null,
  },
  {
    name: "Google Fonts",
    category: "Assets",
    confidence: 70,
    test: (h) =>
      /fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(h)
        ? "Google Fonts"
        : null,
  },
  {
    name: "Hotjar",
    category: "Analytics",
    confidence: 95,
    test: (h) => (/static\.hotjar\.com/i.test(h) ? "Hotjar" : null),
  },
  {
    name: "Meta Pixel",
    category: "Ads",
    confidence: 90,
    test: (h) =>
      /connect\.facebook\.net\/.+\/fbevents\.js|fbq\(/i.test(h)
        ? "Meta Pixel"
        : null,
  },
  {
    name: "Webflow",
    category: "CMS",
    confidence: 95,
    test: (h) =>
      /webflow\.js|static\.webflow/i.test(h) ? "Webflow" : null,
  },
  {
    name: "Squarespace",
    category: "CMS",
    confidence: 95,
    test: (h) =>
      /static\.squarespace\.com/i.test(h) ? "Squarespace" : null,
  },
  {
    name: "Wix",
    category: "CMS",
    confidence: 95,
    test: (h) => (/static\.wixstatic\.com/i.test(h) ? "Wix" : null),
  },
  {
    name: "Sitecore",
    category: "Content Management System",
    confidence: 95,
    test: (h) =>
      /sitecore|sc_device|sitecorecontenthub/i.test(h) ? "Sitecore assets" : null,
  },
  {
    name: "Salesforce",
    category: "CRM",
    confidence: 90,
    test: (h) =>
      /cdn\.lightning\.force|salesforce\.com\/embed|js\.salesforce/i.test(h)
        ? "Salesforce"
        : null,
  },
  {
    name: "SAP",
    category: "Accounting & Finance",
    confidence: 85,
    test: (h) =>
      /sap[.-]?(hana|fiori|successfactors)|sapcdn/i.test(h) ? "SAP" : null,
  },
  {
    name: "Azure",
    category: "Cloud Computing Services",
    confidence: 90,
    test: (h) =>
      /azure\.com|azurefd\.net|windows\.net\/|applicationinsights/i.test(h)
        ? "Azure"
        : null,
  },
  {
    name: "Azure Front Door",
    category: "Cloud Computing Services",
    confidence: 90,
    test: (h) => (/azurefd\.net/i.test(h) ? "Azure Front Door" : null),
  },
  {
    name: "Kubernetes",
    category: "Cloud Computing Services",
    confidence: 80,
    test: (h) => (/kubernetes\.io|k8s\./i.test(h) ? "Kubernetes" : null),
  },
  {
    name: "GitHub Actions",
    category: "Cloud Computing Services",
    confidence: 80,
    test: (h) =>
      /github\.com\/[^"' ]+\/actions|actions\/checkout/i.test(h)
        ? "GitHub Actions"
        : null,
  },
  {
    name: "Oracle",
    category: "Database",
    confidence: 80,
    test: (h) => (/oracle\.com|oraclecloud/i.test(h) ? "Oracle" : null),
  },
  {
    name: "LinkedIn Ads",
    category: "Advertising",
    confidence: 90,
    test: (h) =>
      /snap\.licdn\.com|lintrk\(/i.test(h) ? "LinkedIn Insight" : null,
  },
];

export async function detectTechStack(
  domainInput: string,
): Promise<TechStackResult> {
  const t0 = Date.now();
  const domain = domainInput
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  const sources: string[] = [];
  const technologies: TechHit[] = [];
  const seen = new Set<string>();

  const urls = [`https://${domain}/`, `https://www.${domain}/`];

  for (const url of urls) {
    const res = await resilientFetch(url, {
      timeoutMs: 10000,
      maxAttempts: 2,
      preferBot: true,
    });
    if (!res.ok || res.body.length < 200) continue;
    sources.push(res.url);
    const html = res.body;

    for (const rule of RULES) {
      if (seen.has(rule.name)) continue;
      const evidence = rule.test(html);
      if (evidence) {
        seen.add(rule.name);
        technologies.push({
          name: rule.name,
          category: rule.category,
          evidence,
          confidence: rule.confidence,
        });
      }
    }

    const gen = html.match(
      /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i,
    );
    if (gen?.[1]) {
      const g = gen[1].trim();
      if (!seen.has(g)) {
        seen.add(g);
        technologies.push({
          name: g.slice(0, 48),
          category: "CMS",
          evidence: "meta generator",
          confidence: 90,
        });
      }
    }

    const theme = html.match(/\/wp-content\/themes\/([^/"']+)/i);
    if (theme?.[1] && !seen.has(`theme:${theme[1]}`)) {
      seen.add(`theme:${theme[1]}`);
      technologies.push({
        name: `WP theme: ${theme[1]}`,
        category: "CMS",
        evidence: "theme path",
        confidence: 90,
      });
    }

    break;
  }

  // Sort by confidence
  technologies.sort((a, b) => b.confidence - a.confidence);

  return {
    domain,
    technologies,
    durationMs: Date.now() - t0,
    sources,
  };
}
