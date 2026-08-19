/**
 * Professional + social network discovery hop.
 *
 * Clay/Hunter use LinkedIn + GitHub + social graphs heavily. Full LinkedIn
 * profile scrapes need their API (auth-walled). We use:
 *  - LinkedIn: public SERP (site:linkedin.com/in), company slug pages when open,
 *    profile URL → name parse
 *  - GitHub: org/user public HTML + @domain code search
 *  - X/Twitter: public handles from SERP
 *  - Crunchbase / Wellfound: public org pages when not blocked
 */

import {
  isValidEmailSyntax,
  normalizeDomain,
  parseFullName,
  slugifyToken,
} from "./normalize";
import { nameFromSlug } from "./linkedin";
import { isRoleBasedEmail } from "./disposable";
import { resilientFetch } from "./http";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const T = 11000;

export type SocialNetwork =
  | "linkedin"
  | "github"
  | "x"
  | "crunchbase"
  | "wellfound"
  | "aboutme"
  | "angel"
  | "other";

export interface SocialPerson {
  fullName: string;
  firstName: string;
  lastName: string;
  title?: string;
  profileUrl: string;
  network: SocialNetwork;
  email?: string;
  evidence: string;
}

export interface SocialEmailHit {
  email: string;
  sourceUrl: string;
  network: SocialNetwork;
  firstName?: string;
  lastName?: string;
  isRoleBased: boolean;
}

export interface SocialGraphResult {
  people: SocialPerson[];
  emails: SocialEmailHit[];
  profiles: Array<{ url: string; network: SocialNetwork; label: string }>;
  durationMs: number;
  detail: string;
  networksHit: SocialNetwork[];
}

const GITHUB_RESERVED = new Set(
  [
    "features",
    "topics",
    "collections",
    "marketplace",
    "explore",
    "settings",
    "login",
    "join",
    "orgs",
    "enterprise",
    "pricing",
    "about",
    "site",
    "pulls",
    "issues",
    "notifications",
    "new",
    "organizations",
    "search",
    "sponsors",
    "security",
    "team",
    "solutions",
    "resources",
    "customer-stories",
    "trust-center",
    "partners",
    "open-source",
    "trending",
    "readme",
    "events",
    "codespaces",
    "copilot",
    "github",
    "mcp",
    "why-github",
    "mobile",
    "watch",
    "stars",
    "account",
    "sessions",
    "logout",
    "dashboard",
    "apps",
    "integrations",
    "marketplace",
    "customer",
    "stories",
    "footer",
    "home",
    "blog",
    "docs",
    "help",
    "support",
    "contact",
    "status",
    "git-guides",
    "community",
    "education",
  ].map((s) => s.toLowerCase()),
);

const NAME_NOISE =
  /^(the|and|for|with|our|team|about|home|login|sign|view|more|page|this|that|from|company|private|limited|why|open|source|trust|center|customer|stories|delivering|enterprise|github|security|performance|solutions|resources|partners|features)$/i;

async function fetchText(
  url: string,
  timeout = T,
): Promise<{ ok: boolean; body: string; url: string; status: number }> {
  const res = await resilientFetch(url, {
    timeoutMs: timeout,
    maxAttempts: 4,
    preferBot: /companydetails|instafinancials|zauba|crunchbase|wellfound|github/i.test(url),
  });
  return { ok: res.ok, body: res.body, url: res.url, status: res.status };
}

const EMAIL_RE =
  /[a-zA-Z0-9](?:[a-zA-Z0-9._%+\-]{0,62}[a-zA-Z0-9])?@[a-zA-Z0-9](?:[a-zA-Z0-9.\-]{0,61}[a-zA-Z0-9])?\.[a-zA-Z]{2,}/gi;

function emailsForDomain(text: string, domain: string): string[] {
  const d = domain.toLowerCase();
  const out = new Set<string>();
  for (const m of text.matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase().replace(/[.,;:)+\]>]+$/, "");
    if (isValidEmailSyntax(e) && e.endsWith(`@${d}`)) out.add(e);
  }
  return [...out];
}

function strip(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function addPerson(map: Map<string, SocialPerson>, p: SocialPerson) {
  if (NAME_NOISE.test(p.firstName) || NAME_NOISE.test(p.lastName)) return;
  if (p.firstName.length > 24 || p.lastName.length > 24) return;
  if (p.fullName.length > 50) return;
  const key = `${p.firstName}|${p.lastName}`.toLowerCase();
  const ex = map.get(key);
  if (ex) {
    if (p.email && !ex.email) ex.email = p.email;
    if (p.title && !ex.title) ex.title = p.title;
    return;
  }
  map.set(key, p);
}

function personFromName(
  name: string,
  profileUrl: string,
  network: SocialNetwork,
  title?: string,
  email?: string,
): SocialPerson | null {
  const parsed = parseFullName(name);
  if (!parsed.first || !parsed.last) return null;
  if (parsed.first.length < 2 || parsed.last.length < 2) return null;
  if (NAME_NOISE.test(parsed.first) || NAME_NOISE.test(parsed.last))
    return null;
  return {
    fullName: `${parsed.first} ${parsed.last}`,
    firstName: parsed.first,
    lastName: parsed.last,
    title,
    profileUrl,
    network,
    email,
    evidence: `${network} public signal`,
  };
}

function extractLinkedInProfiles(
  html: string,
): Array<{ url: string; slug: string; name: string | null }> {
  const out: Array<{ url: string; slug: string; name: string | null }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /https?:\/\/(?:www\.)?linkedin\.com\/in\/([a-zA-Z0-9_%\-]+)\/?/gi,
  )) {
    const slug = decodeURIComponent(m[1]).replace(/\/+$/, "");
    if (seen.has(slug.toLowerCase())) continue;
    if (/^pub\//i.test(slug)) continue;
    seen.add(slug.toLowerCase());
    const guessed = nameFromSlug(slug);
    const name =
      guessed?.first && guessed?.last
        ? `${guessed.first} ${guessed.last}`
        : null;
    out.push({
      url: `https://www.linkedin.com/in/${slug}/`,
      slug,
      name,
    });
  }
  return out.slice(0, 30);
}

function isLikelyGithubUser(login: string): boolean {
  const u = login.toLowerCase();
  if (GITHUB_RESERVED.has(u)) return false;
  if (u.includes(".")) return false;
  if (u.length < 2 || u.length > 39) return false;
  return true;
}

/**
 * Multi-network professional graph for a company domain.
 */
export async function discoverSocialGraph(
  domainInput: string,
  opts: { brand?: string; legalName?: string | null } = {},
): Promise<SocialGraphResult> {
  const t0 = Date.now();
  const domain = normalizeDomain(domainInput);
  const brand = opts.brand ?? domain.split(".")[0] ?? domain;
  const people = new Map<string, SocialPerson>();
  const emails: SocialEmailHit[] = [];
  const seenEmail = new Set<string>();
  const profiles: SocialGraphResult["profiles"] = [];
  const networksHit = new Set<SocialNetwork>();
  const brandLower = brand.toLowerCase();

  const pushEmail = (
    email: string,
    sourceUrl: string,
    network: SocialNetwork,
    firstName?: string,
    lastName?: string,
  ) => {
    const e = email.toLowerCase();
    if (seenEmail.has(e)) return;
    seenEmail.add(e);
    emails.push({
      email: e,
      sourceUrl,
      network,
      firstName,
      lastName,
      isRoleBased: isRoleBasedEmail(e),
    });
    networksHit.add(network);
  };

  const brandQ = encodeURIComponent(brand);
  const domainQ = encodeURIComponent(domain);
  const legalQ = opts.legalName
    ? encodeURIComponent(opts.legalName.slice(0, 60))
    : brandQ;

  const targets: Array<{
    url: string;
    network: SocialNetwork;
    kind: string;
  }> = [
    {
      url: `https://www.bing.com/search?q=site%3Alinkedin.com%2Fin+%22${brandQ}%22&count=40`,
      network: "linkedin",
      kind: "serp",
    },
    {
      url: `https://www.bing.com/search?q=site%3Alinkedin.com%2Fin+%22${brandQ}%22+(founder+OR+CEO+OR+director+OR+CTO)&count=30`,
      network: "linkedin",
      kind: "serp",
    },
    {
      url: `https://www.bing.com/search?q=%22${domainQ}%22+site%3Alinkedin.com%2Fin&count=30`,
      network: "linkedin",
      kind: "serp",
    },
    {
      url: `https://html.duckduckgo.com/html/?q=site%3Alinkedin.com%2Fin+${brandQ}+founder+OR+director`,
      network: "linkedin",
      kind: "serp",
    },
    {
      url: `https://www.linkedin.com/company/${brand}/`,
      network: "linkedin",
      kind: "page",
    },
    {
      url: `https://github.com/${brand}`,
      network: "github",
      kind: "page",
    },
    {
      url: `https://github.com/orgs/${brand}/people`,
      network: "github",
      kind: "page",
    },
    {
      url: `https://github.com/search?q=%22%40${domainQ}%22&type=code`,
      network: "github",
      kind: "serp",
    },
    {
      url: `https://www.bing.com/search?q=site%3Ax.com+OR+site%3Atwitter.com+%22${brandQ}%22+(founder+OR+CEO)&count=20`,
      network: "x",
      kind: "serp",
    },
    {
      url: `https://x.com/${brand}`,
      network: "x",
      kind: "page",
    },
    {
      url: `https://www.crunchbase.com/organization/${brand}`,
      network: "crunchbase",
      kind: "page",
    },
    {
      url: `https://www.bing.com/search?q=site%3Acrunchbase.com+${legalQ}&count=15`,
      network: "crunchbase",
      kind: "serp",
    },
    {
      url: `https://wellfound.com/company/${brand}`,
      network: "wellfound",
      kind: "page",
    },
    {
      url: `https://www.bing.com/search?q=site%3Awellfound.com+OR+site%3Aangel.co+${brandQ}&count=15`,
      network: "wellfound",
      kind: "serp",
    },
  ];

  const results = await Promise.all(
    targets.map(async (t) => ({ ...t, res: await fetchText(t.url) })),
  );

  // Track only github logins that appear as user cards, not nav
  const githubCandidates = new Set<string>();

  for (const row of results) {
    const { res, network, kind, url } = row;
    if (!res.body || res.body.length < 200) continue;

    for (const e of emailsForDomain(res.body, domain)) {
      pushEmail(e, res.url || url, network);
    }

    if (network === "linkedin") {
      const profilesLi = extractLinkedInProfiles(res.body);
      // Require brand co-occurrence near the profile for SERP noise control
      for (const p of profilesLi) {
        profiles.push({
          url: p.url,
          network: "linkedin",
          label: p.name ?? p.slug,
        });
        networksHit.add("linkedin");
        if (!p.name) continue;
        // Snippet window: if brand appears near slug in page, higher trust
        const idx = res.body.toLowerCase().indexOf(p.slug.toLowerCase());
        const window =
          idx >= 0
            ? res.body.slice(Math.max(0, idx - 200), idx + 200).toLowerCase()
            : res.body.slice(0, 3000).toLowerCase();
        const brandNear =
          window.includes(brandLower) ||
          window.includes(domain) ||
          kind === "page";
        if (!brandNear && kind === "serp") continue;
        const person = personFromName(p.name, p.url, "linkedin");
        if (person) {
          person.evidence = brandNear
            ? `LinkedIn profile co-mentioned with ${brand}`
            : `LinkedIn profile in search for ${brand}`;
          addPerson(people, person);
        }
      }

      const text = strip(res.body);
      for (const m of text.matchAll(
        /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s*[-–|]\s*([^|]+?)\s*(?:at|@)\s*([A-Za-z0-9 .&]+)/g,
      )) {
        const company = m[3].toLowerCase();
        if (
          company.includes(brandLower) ||
          company.includes(domain.split(".")[0] ?? "")
        ) {
          const person = personFromName(
            m[1],
            `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(m[1] + " " + brand)}`,
            "linkedin",
            m[2].trim().slice(0, 80),
          );
          if (person) {
            person.evidence = `LinkedIn SERP title: ${m[2].trim()} at ${m[3].trim()}`;
            addPerson(people, person);
            networksHit.add("linkedin");
          }
        }
      }
    }

    if (network === "github") {
      // Prefer explicit user profile pattern / user-hovercard
      for (const m of res.body.matchAll(
        /data-hovercard-type="user"[^>]*data-hovercard-url="\/users\/([^"/]+)/gi,
      )) {
        if (isLikelyGithubUser(m[1])) githubCandidates.add(m[1]);
      }
      for (const m of res.body.matchAll(
        /"login"\s*:\s*"([a-zA-Z0-9\-]+)"/g,
      )) {
        if (isLikelyGithubUser(m[1])) githubCandidates.add(m[1]);
      }
      // Org page: only take brand itself as org profile to follow
      if (kind === "page" && res.ok && res.url.includes(`github.com/${brand}`)) {
        githubCandidates.add(brand);
        networksHit.add("github");
        profiles.push({
          url: `https://github.com/${brand}`,
          network: "github",
          label: brand,
        });
      }
    }

    if (network === "crunchbase") {
      const text = strip(res.body);
      for (const m of text.matchAll(
        /(?:Founded by|Founders?|CEO|CTO|Board Member)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/g,
      )) {
        const person = personFromName(
          m[1],
          res.url || url,
          "crunchbase",
          "Founder/exec (Crunchbase)",
        );
        if (person) {
          person.evidence = "Crunchbase public page";
          addPerson(people, person);
          networksHit.add("crunchbase");
        }
      }
      for (const m of res.body.matchAll(
        /href="(\/person\/[a-z0-9\-]+)"[^>]*>([^<]{3,40})</gi,
      )) {
        const person = personFromName(
          m[2].trim(),
          `https://www.crunchbase.com${m[1]}`,
          "crunchbase",
        );
        if (person) {
          person.evidence = "Crunchbase person link";
          addPerson(people, person);
          networksHit.add("crunchbase");
        }
      }
    }

    if (network === "wellfound") {
      for (const m of res.body.matchAll(
        /href="(\/(?:u|p)\/[a-z0-9\-]+)"[^>]*>([^<]{3,40})</gi,
      )) {
        const person = personFromName(
          m[2].trim(),
          `https://wellfound.com${m[1]}`,
          "wellfound",
        );
        if (person) {
          person.evidence = "Wellfound/AngelList public";
          addPerson(people, person);
          networksHit.add("wellfound");
        }
      }
    }

    if (network === "x") {
      for (const m of res.body.matchAll(
        /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{2,30})/g,
      )) {
        const handle = m[1];
        if (
          /^(home|search|i|intent|share|hashtag|explore|settings|login|signup)$/i.test(
            handle,
          )
        )
          continue;
        profiles.push({
          url: `https://x.com/${handle}`,
          network: "x",
          label: `@${handle}`,
        });
        networksHit.add("x");
      }
    }
  }

  // Follow real GitHub user/org profiles only
  const follow = [...githubCandidates].filter(isLikelyGithubUser).slice(0, 8);
  await Promise.all(
    follow.map(async (login) => {
      const profileUrl = `https://github.com/${login}`;
      profiles.push({ url: profileUrl, network: "github", label: login });
      const res = await fetchText(profileUrl);
      if (!res.ok) return;
      networksHit.add("github");
      for (const e of emailsForDomain(res.body, domain)) {
        pushEmail(e, res.url, "github");
      }
      // Only use vcard-names / itemprop=name for real display names
      const nameM =
        res.body.match(
          /itemprop="name"[^>]*>\s*<span[^>]*>\s*([^<]+)/i,
        ) ||
        res.body.match(/class="[^"]*vcard-fullname[^"]*"[^>]*>\s*([^<]+)/i) ||
        res.body.match(
          /itemprop="name"[^>]*content="([^"]+)"/i,
        );
      if (nameM) {
        const display = nameM[1].trim();
        if (display.length < 40 && !/github/i.test(display)) {
          const person = personFromName(display, profileUrl, "github");
          if (person) {
            person.evidence =
              login.toLowerCase() === brandLower
                ? `GitHub org/user @${login} display name`
                : `GitHub profile @${login}`;
            addPerson(people, person);
          }
        }
      }
    }),
  );

  const peopleList = [...people.values()];
  const nets = [...networksHit];
  const detail =
    peopleList.length || emails.length
      ? `${peopleList.length} people · ${emails.length} emails · networks: ${nets.join(", ") || "—"} · ${profiles.length} profiles`
      : `No open social graph hits (LinkedIn/X often auth-wall) · tried ${targets.length} endpoints`;

  return {
    people: peopleList,
    emails,
    profiles: profiles.slice(0, 50),
    durationMs: Date.now() - t0,
    detail,
    networksHit: nets,
  };
}
