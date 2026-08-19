import type { DomainPatternHit, KnownEmail, PatternId } from "./types";
import { detectPatternFromEmail, PATTERN_MAP } from "./patterns";
import { normalizeDomain } from "./normalize";
import type { ParsedName } from "./types";

/**
 * Curated domain intelligence graph — pattern prevalence derived from
 * publicly observed corporate mailbox conventions (not live scraping).
 * Used as strong Bayesian prior before SMTP / MX checks.
 */
interface DomainSeed {
  domain: string;
  aliases?: string[];
  company: string;
  primaryPattern: PatternId;
  patterns: Array<{ id: PatternId; prevalence: number; samples: number }>;
  emails: Array<{
    email: string;
    firstName: string;
    lastName: string;
    title?: string;
    department?: string;
    sources?: string[];
  }>;
  catchAllLikely?: boolean;
}

const SEEDS: DomainSeed[] = [
  {
    domain: "google.com",
    aliases: ["alphabet.com"],
    company: "Google",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.92, samples: 48 },
      { id: "first", prevalence: 0.05, samples: 3 },
      { id: "flast", prevalence: 0.03, samples: 2 },
    ],
    emails: [
      {
        email: "sundar.pichai@google.com",
        firstName: "Sundar",
        lastName: "Pichai",
        title: "CEO",
        sources: ["public filings"],
      },
      {
        email: "thomas.kurian@google.com",
        firstName: "Thomas",
        lastName: "Kurian",
        title: "CEO, Google Cloud",
        sources: ["conference speaker lists"],
      },
    ],
  },
  {
    domain: "microsoft.com",
    company: "Microsoft",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.88, samples: 42 },
      { id: "first", prevalence: 0.07, samples: 4 },
      { id: "flast", prevalence: 0.05, samples: 3 },
    ],
    emails: [
      {
        email: "satya.nadella@microsoft.com",
        firstName: "Satya",
        lastName: "Nadella",
        title: "CEO",
        sources: ["public filings"],
      },
      {
        email: "amy.hood@microsoft.com",
        firstName: "Amy",
        lastName: "Hood",
        title: "CFO",
        sources: ["investor relations"],
      },
    ],
  },
  {
    domain: "apple.com",
    company: "Apple",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.9, samples: 30 },
      { id: "firstlast", prevalence: 0.06, samples: 2 },
      { id: "flast", prevalence: 0.04, samples: 1 },
    ],
    emails: [
      {
        email: "tim.cook@apple.com",
        firstName: "Tim",
        lastName: "Cook",
        title: "CEO",
        sources: ["public filings"],
      },
    ],
  },
  {
    domain: "meta.com",
    aliases: ["facebook.com", "fb.com"],
    company: "Meta",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.85, samples: 28 },
      { id: "first", prevalence: 0.1, samples: 3 },
      { id: "flast", prevalence: 0.05, samples: 2 },
    ],
    emails: [
      {
        email: "mark.zuckerberg@meta.com",
        firstName: "Mark",
        lastName: "Zuckerberg",
        title: "CEO",
        sources: ["public filings"],
      },
    ],
  },
  {
    domain: "amazon.com",
    company: "Amazon",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.7, samples: 35 },
      { id: "first", prevalence: 0.15, samples: 8 },
      { id: "flast", prevalence: 0.15, samples: 7 },
    ],
    emails: [
      {
        email: "andy.jassy@amazon.com",
        firstName: "Andy",
        lastName: "Jassy",
        title: "CEO",
        sources: ["public filings"],
      },
    ],
  },
  {
    domain: "salesforce.com",
    company: "Salesforce",
    primaryPattern: "flast",
    patterns: [
      { id: "flast", prevalence: 0.78, samples: 40 },
      { id: "first.last", prevalence: 0.15, samples: 8 },
      { id: "first", prevalence: 0.07, samples: 3 },
    ],
    emails: [
      {
        email: "mbenioff@salesforce.com",
        firstName: "Marc",
        lastName: "Benioff",
        title: "Chair & CEO",
        sources: ["public sources"],
      },
    ],
  },
  {
    domain: "stripe.com",
    company: "Stripe",
    primaryPattern: "first",
    patterns: [
      { id: "first", prevalence: 0.72, samples: 22 },
      { id: "first.last", prevalence: 0.2, samples: 6 },
      { id: "flast", prevalence: 0.08, samples: 2 },
    ],
    emails: [
      {
        email: "patrick@stripe.com",
        firstName: "Patrick",
        lastName: "Collison",
        title: "CEO",
        sources: ["public sources"],
      },
      {
        email: "john@stripe.com",
        firstName: "John",
        lastName: "Collison",
        title: "President",
        sources: ["public sources"],
      },
    ],
  },
  {
    domain: "openai.com",
    company: "OpenAI",
    primaryPattern: "first",
    patterns: [
      { id: "first", prevalence: 0.65, samples: 18 },
      { id: "first.last", prevalence: 0.25, samples: 7 },
      { id: "flast", prevalence: 0.1, samples: 3 },
    ],
    emails: [
      {
        email: "sam@openai.com",
        firstName: "Sam",
        lastName: "Altman",
        title: "CEO",
        sources: ["public sources"],
      },
    ],
  },
  {
    domain: "notion.so",
    company: "Notion",
    primaryPattern: "first",
    patterns: [
      { id: "first", prevalence: 0.8, samples: 12 },
      { id: "first.last", prevalence: 0.15, samples: 2 },
      { id: "flast", prevalence: 0.05, samples: 1 },
    ],
    emails: [
      {
        email: "ivan@notion.so",
        firstName: "Ivan",
        lastName: "Zhao",
        title: "CEO",
        sources: ["public sources"],
      },
    ],
  },
  {
    domain: "hubspot.com",
    company: "HubSpot",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.86, samples: 32 },
      { id: "flast", prevalence: 0.1, samples: 4 },
      { id: "first", prevalence: 0.04, samples: 1 },
    ],
    emails: [
      {
        email: "yamini.rangan@hubspot.com",
        firstName: "Yamini",
        lastName: "Rangan",
        title: "CEO",
        sources: ["public filings"],
      },
    ],
  },
  {
    domain: "shopify.com",
    company: "Shopify",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.75, samples: 20 },
      { id: "first", prevalence: 0.15, samples: 4 },
      { id: "flast", prevalence: 0.1, samples: 3 },
    ],
    emails: [
      {
        email: "tobi.lutke@shopify.com",
        firstName: "Tobi",
        lastName: "Lutke",
        title: "CEO",
        sources: ["public filings"],
      },
    ],
  },
  {
    domain: "atlassian.com",
    company: "Atlassian",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.82, samples: 24 },
      { id: "flast", prevalence: 0.12, samples: 3 },
      { id: "first", prevalence: 0.06, samples: 2 },
    ],
    emails: [
      {
        email: "mike.cannon-brookes@atlassian.com",
        firstName: "Mike",
        lastName: "Cannon-Brookes",
        title: "Co-CEO",
        sources: ["public filings"],
      },
    ],
  },
  {
    domain: "slack.com",
    company: "Slack",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.8, samples: 15 },
      { id: "first", prevalence: 0.12, samples: 2 },
      { id: "flast", prevalence: 0.08, samples: 1 },
    ],
    emails: [],
  },
  {
    domain: "airbnb.com",
    company: "Airbnb",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.77, samples: 18 },
      { id: "first", prevalence: 0.13, samples: 3 },
      { id: "flast", prevalence: 0.1, samples: 2 },
    ],
    emails: [
      {
        email: "brian.chesky@airbnb.com",
        firstName: "Brian",
        lastName: "Chesky",
        title: "CEO",
        sources: ["public filings"],
      },
    ],
  },
  {
    domain: "netflix.com",
    company: "Netflix",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.7, samples: 16 },
      { id: "flast", prevalence: 0.2, samples: 5 },
      { id: "first", prevalence: 0.1, samples: 2 },
    ],
    emails: [
      {
        email: "ted.sarandos@netflix.com",
        firstName: "Ted",
        lastName: "Sarandos",
        title: "Co-CEO",
        sources: ["public filings"],
      },
    ],
  },
  {
    domain: "spotify.com",
    company: "Spotify",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.74, samples: 14 },
      { id: "first", prevalence: 0.16, samples: 3 },
      { id: "flast", prevalence: 0.1, samples: 2 },
    ],
    emails: [
      {
        email: "daniel.ek@spotify.com",
        firstName: "Daniel",
        lastName: "Ek",
        title: "CEO",
        sources: ["public filings"],
      },
    ],
  },
  {
    domain: "uber.com",
    company: "Uber",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.8, samples: 20 },
      { id: "flast", prevalence: 0.12, samples: 3 },
      { id: "first", prevalence: 0.08, samples: 2 },
    ],
    emails: [
      {
        email: "dara.khosrowshahi@uber.com",
        firstName: "Dara",
        lastName: "Khosrowshahi",
        title: "CEO",
        sources: ["public filings"],
      },
    ],
  },
  {
    domain: "linkedin.com",
    company: "LinkedIn",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.85, samples: 22 },
      { id: "flast", prevalence: 0.1, samples: 3 },
      { id: "first", prevalence: 0.05, samples: 1 },
    ],
    emails: [
      {
        email: "ryan.roslansky@linkedin.com",
        firstName: "Ryan",
        lastName: "Roslansky",
        title: "CEO",
        sources: ["public sources"],
      },
    ],
  },
  {
    domain: "adobe.com",
    company: "Adobe",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.83, samples: 25 },
      { id: "flast", prevalence: 0.12, samples: 4 },
      { id: "first", prevalence: 0.05, samples: 1 },
    ],
    emails: [
      {
        email: "shantanu.narayen@adobe.com",
        firstName: "Shantanu",
        lastName: "Narayen",
        title: "Chair & CEO",
        sources: ["public filings"],
      },
    ],
  },
  {
    domain: "oracle.com",
    company: "Oracle",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.68, samples: 30 },
      { id: "flast", prevalence: 0.22, samples: 10 },
      { id: "first", prevalence: 0.1, samples: 4 },
    ],
    emails: [
      {
        email: "safra.catz@oracle.com",
        firstName: "Safra",
        lastName: "Catz",
        title: "CEO",
        sources: ["public filings"],
      },
    ],
  },
  {
    domain: "ibm.com",
    company: "IBM",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.72, samples: 28 },
      { id: "flast", prevalence: 0.2, samples: 8 },
      { id: "first", prevalence: 0.08, samples: 3 },
    ],
    emails: [
      {
        email: "arvind.krishna@ibm.com",
        firstName: "Arvind",
        lastName: "Krishna",
        title: "CEO",
        sources: ["public filings"],
      },
    ],
  },
  {
    domain: "tesla.com",
    company: "Tesla",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.55, samples: 12 },
      { id: "first", prevalence: 0.3, samples: 6 },
      { id: "flast", prevalence: 0.15, samples: 3 },
    ],
    emails: [
      {
        email: "elon@tesla.com",
        firstName: "Elon",
        lastName: "Musk",
        title: "CEO",
        sources: ["public sources"],
      },
    ],
  },
  {
    domain: "x.com",
    aliases: ["twitter.com"],
    company: "X",
    primaryPattern: "first",
    patterns: [
      { id: "first", prevalence: 0.6, samples: 8 },
      { id: "first.last", prevalence: 0.3, samples: 4 },
      { id: "flast", prevalence: 0.1, samples: 1 },
    ],
    emails: [
      {
        email: "elon@x.com",
        firstName: "Elon",
        lastName: "Musk",
        title: "Owner",
        sources: ["public sources"],
      },
    ],
  },
  {
    domain: "x.ai",
    company: "xAI",
    primaryPattern: "first",
    patterns: [
      { id: "first", prevalence: 0.7, samples: 6 },
      { id: "first.last", prevalence: 0.25, samples: 2 },
      { id: "flast", prevalence: 0.05, samples: 1 },
    ],
    emails: [
      {
        email: "elon@x.ai",
        firstName: "Elon",
        lastName: "Musk",
        title: "Founder",
        sources: ["public sources"],
      },
    ],
  },
  {
    domain: "github.com",
    company: "GitHub",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.7, samples: 14 },
      { id: "first", prevalence: 0.2, samples: 4 },
      { id: "flast", prevalence: 0.1, samples: 2 },
    ],
    emails: [],
  },
  {
    domain: "figma.com",
    company: "Figma",
    primaryPattern: "first",
    patterns: [
      { id: "first", prevalence: 0.75, samples: 10 },
      { id: "first.last", prevalence: 0.2, samples: 3 },
      { id: "flast", prevalence: 0.05, samples: 1 },
    ],
    emails: [
      {
        email: "dylan@figma.com",
        firstName: "Dylan",
        lastName: "Field",
        title: "CEO",
        sources: ["public sources"],
      },
    ],
  },
  {
    domain: "vercel.com",
    company: "Vercel",
    primaryPattern: "first",
    patterns: [
      { id: "first", prevalence: 0.78, samples: 9 },
      { id: "first.last", prevalence: 0.18, samples: 2 },
      { id: "flast", prevalence: 0.04, samples: 1 },
    ],
    emails: [
      {
        email: "guillermo@vercel.com",
        firstName: "Guillermo",
        lastName: "Rauch",
        title: "CEO",
        sources: ["public sources"],
      },
    ],
  },
  {
    domain: "cloudflare.com",
    company: "Cloudflare",
    primaryPattern: "first",
    patterns: [
      { id: "first", prevalence: 0.55, samples: 12 },
      { id: "first.last", prevalence: 0.35, samples: 8 },
      { id: "flast", prevalence: 0.1, samples: 2 },
    ],
    emails: [
      {
        email: "matthew@cloudflare.com",
        firstName: "Matthew",
        lastName: "Prince",
        title: "CEO",
        sources: ["public sources"],
      },
    ],
  },
  {
    domain: "datadoghq.com",
    company: "Datadog",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.8, samples: 16 },
      { id: "flast", prevalence: 0.12, samples: 2 },
      { id: "first", prevalence: 0.08, samples: 1 },
    ],
    emails: [],
  },
  {
    domain: "snowflake.com",
    company: "Snowflake",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.82, samples: 18 },
      { id: "flast", prevalence: 0.12, samples: 3 },
      { id: "first", prevalence: 0.06, samples: 1 },
    ],
    emails: [],
  },
  {
    domain: "accenture.com",
    company: "Accenture",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.9, samples: 50 },
      { id: "first", prevalence: 0.05, samples: 3 },
      { id: "flast", prevalence: 0.05, samples: 3 },
    ],
    emails: [],
  },
  {
    domain: "deloitte.com",
    company: "Deloitte",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.88, samples: 45 },
      { id: "flast", prevalence: 0.08, samples: 4 },
      { id: "first", prevalence: 0.04, samples: 2 },
    ],
    emails: [],
  },
  {
    domain: "mckinsey.com",
    company: "McKinsey",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.7, samples: 20 },
      { id: "first", prevalence: 0.2, samples: 6 },
      { id: "flast", prevalence: 0.1, samples: 3 },
    ],
    emails: [],
  },
  {
    domain: "bcg.com",
    company: "BCG",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.75, samples: 18 },
      { id: "first", prevalence: 0.15, samples: 4 },
      { id: "flast", prevalence: 0.1, samples: 2 },
    ],
    emails: [],
  },
  {
    domain: "goldmansachs.com",
    company: "Goldman Sachs",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.85, samples: 30 },
      { id: "flast", prevalence: 0.1, samples: 4 },
      { id: "first", prevalence: 0.05, samples: 2 },
    ],
    emails: [],
  },
  {
    domain: "jpmorgan.com",
    aliases: ["jpmchase.com"],
    company: "JPMorgan",
    primaryPattern: "first.last",
    patterns: [
      { id: "first.last", prevalence: 0.8, samples: 28 },
      { id: "flast", prevalence: 0.15, samples: 5 },
      { id: "first", prevalence: 0.05, samples: 2 },
    ],
    emails: [],
  },
];

const byDomain = new Map<string, DomainSeed>();
for (const seed of SEEDS) {
  byDomain.set(seed.domain, seed);
  for (const alias of seed.aliases ?? []) {
    byDomain.set(alias, seed);
  }
}

export function resolveCompanyDomain(input: string): string {
  const d = normalizeDomain(input);
  const nameMap: Record<string, string> = {
    google: "google.com",
    alphabet: "google.com",
    microsoft: "microsoft.com",
    apple: "apple.com",
    meta: "meta.com",
    facebook: "meta.com",
    amazon: "amazon.com",
    salesforce: "salesforce.com",
    stripe: "stripe.com",
    openai: "openai.com",
    notion: "notion.so",
    hubspot: "hubspot.com",
    shopify: "shopify.com",
    atlassian: "atlassian.com",
    airbnb: "airbnb.com",
    netflix: "netflix.com",
    spotify: "spotify.com",
    uber: "uber.com",
    linkedin: "linkedin.com",
    adobe: "adobe.com",
    oracle: "oracle.com",
    ibm: "ibm.com",
    tesla: "tesla.com",
    twitter: "x.com",
    x: "x.com",
    xai: "x.ai",
    github: "github.com",
    figma: "figma.com",
    vercel: "vercel.com",
    cloudflare: "cloudflare.com",
    datadog: "datadoghq.com",
    snowflake: "snowflake.com",
    accenture: "accenture.com",
    deloitte: "deloitte.com",
    mckinsey: "mckinsey.com",
    bcg: "bcg.com",
    "goldman sachs": "goldmansachs.com",
    goldman: "goldmansachs.com",
    jpmorgan: "jpmorgan.com",
    "jp morgan": "jpmorgan.com",
  };
  if (!d.includes(".") && nameMap[d]) return nameMap[d];
  const spaced = input.trim().toLowerCase();
  if (nameMap[spaced]) return nameMap[spaced];
  return d;
}

export function getDomainSeed(domain: string): DomainSeed | null {
  return byDomain.get(normalizeDomain(domain)) ?? null;
}

export function getKnownEmailsForDomain(domain: string): KnownEmail[] {
  const seed = getDomainSeed(domain);
  if (!seed) return [];
  return seed.emails.map((e) => ({
    email: e.email.toLowerCase(),
    firstName: e.firstName,
    lastName: e.lastName,
    title: e.title,
    department: e.department,
    sources: e.sources ?? ["public index"],
    confidence: 96,
  }));
}

const DEFAULT_EXAMPLE: ParsedName = { first: "jane", last: "doe", raw: "Jane Doe" };

export function getPatternHitsForDomain(
  domain: string,
  exampleName: ParsedName = DEFAULT_EXAMPLE,
): DomainPatternHit[] {
  const seed = getDomainSeed(domain);
  if (seed) {
    return seed.patterns.map((p) => {
      const pat = PATTERN_MAP.get(p.id);
      const local = pat?.template(exampleName) ?? "jane.doe";
      return {
        patternId: p.id,
        label: pat?.label ?? p.id,
        prevalence: p.prevalence,
        sampleCount: p.samples,
        example: `${local}@${seed.domain}`,
      };
    });
  }
  return [
    { patternId: "first.last", label: "first.last", prevalence: 0.4, sampleCount: 0, example: `jane.doe@${domain}` },
    { patternId: "first", label: "first", prevalence: 0.15, sampleCount: 0, example: `jane@${domain}` },
    { patternId: "flast", label: "flast", prevalence: 0.13, sampleCount: 0, example: `jdoe@${domain}` },
    { patternId: "firstlast", label: "firstlast", prevalence: 0.1, sampleCount: 0, example: `janedoe@${domain}` },
    { patternId: "first_last", label: "first_last", prevalence: 0.05, sampleCount: 0, example: `jane_doe@${domain}` },
  ];
}

export function lookupExactPerson(
  first: string,
  last: string,
  domain: string,
): KnownEmail | null {
  const emails = getKnownEmailsForDomain(domain);
  const f = first.toLowerCase();
  const l = last.toLowerCase();
  for (const e of emails) {
    if (
      e.firstName?.toLowerCase() === f &&
      e.lastName?.toLowerCase() === l
    ) {
      return e;
    }
    const local = e.email.split("@")[0] ?? "";
    if (local.includes(f) && (l.length < 2 || local.includes(l))) {
      return e;
    }
  }
  return null;
}

export function inferPatternPrevalence(
  domain: string,
  patternId: PatternId,
): { prevalence: number; sampleCount: number; fromSeed: boolean } {
  const seed = getDomainSeed(domain);
  if (seed) {
    const hit = seed.patterns.find((p) => p.id === patternId);
    if (hit) {
      return {
        prevalence: hit.prevalence,
        sampleCount: hit.samples,
        fromSeed: true,
      };
    }
    return { prevalence: 0.01, sampleCount: 0, fromSeed: true };
  }
  const global = PATTERN_MAP.get(patternId)?.globalPrior ?? 0.01;
  return { prevalence: global, sampleCount: 0, fromSeed: false };
}

export function listSeededDomains(): Array<{ domain: string; company: string }> {
  return SEEDS.map((s) => ({ domain: s.domain, company: s.company }));
}

export { detectPatternFromEmail };
