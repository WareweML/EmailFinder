/**
 * Off-domain public graph discovery (company registries).
 */

import {
  isValidDomainShape,
  isValidEmailSyntax,
  normalizeDomain,
  parseFullName,
  slugifyToken,
} from "./normalize";
import { isRoleBasedEmail } from "./disposable";
import type { PatternId } from "./types";
import { resilientFetch } from "./http";

const FETCH_MS = 12000;

export interface GraphPerson {
  firstName: string;
  lastName: string;
  fullName: string;
  title?: string;
  email?: string;
  sourceUrl: string;
  sourceKind: "company_registry" | "web_directory" | "public_mention";
}

export interface GraphEmailHit {
  email: string;
  sourceUrl: string;
  sourceKind: GraphPerson["sourceKind"];
  firstName?: string;
  lastName?: string;
  title?: string;
  isRoleBased: boolean;
}

export interface PublicGraphResult {
  domain: string;
  people: GraphPerson[];
  emails: GraphEmailHit[];
  durationMs: number;
  sourcesChecked: string[];
  detail: string;
}

const EMAIL_RE =
  /[a-zA-Z0-9](?:[a-zA-Z0-9._%+\-]{0,62}[a-zA-Z0-9])?@[a-zA-Z0-9](?:[a-zA-Z0-9.\-]{0,61}[a-zA-Z0-9])?\.[a-zA-Z]{2,}/gi;

async function fetchText(
  url: string,
): Promise<{ ok: boolean; body: string; finalUrl: string }> {
  const res = await resilientFetch(url, {
    timeoutMs: FETCH_MS,
    maxAttempts: 4,
    preferBot: true,
  });
  return { ok: res.ok, body: res.body, finalUrl: res.url };
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&/gi, "&")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, "\n");
}

function emailsForDomain(text: string, domain: string): string[] {
  const d = domain.toLowerCase();
  const out = new Set<string>();
  for (const m of text.matchAll(EMAIL_RE)) {
    const email = m[0].toLowerCase().replace(/[.,;:)+\]>]+$/, "");
    if (!isValidEmailSyntax(email)) continue;
    if (email.endsWith(`@${d}`)) out.add(email);
  }
  return [...out];
}

function parseIndiaCompanyPage(
  html: string,
  url: string,
  domain: string,
): { people: GraphPerson[]; emails: GraphEmailHit[] } {
  const people: GraphPerson[] = [];
  const emails: GraphEmailHit[] = [];
  const text = stripTags(html);

  for (const email of emailsForDomain(html, domain)) {
    emails.push({
      email,
      sourceUrl: url,
      sourceKind: "company_registry",
      isRoleBased: isRoleBasedEmail(email),
    });
  }

  const directorBlock = text.match(
    /(\d+)\s*director\(s\)\s*:?\s*([^\n]{5,200})/i,
  );
  if (directorBlock) {
    const names = directorBlock[2]
      .split(/[;|,]/)
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z][A-Za-z.\s]{2,40}$/.test(s));
    for (const full of names) {
      const parsed = parseFullName(full);
      if (!parsed.first || !parsed.last) continue;
      people.push({
        firstName: parsed.first,
        lastName: parsed.last,
        fullName: `${parsed.first} ${parsed.last}`,
        title: "Director",
        sourceUrl: url,
        sourceKind: "company_registry",
      });
    }
  }

  const dinRows = text.matchAll(
    /\b(\d{8})\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,3})\s+(Director|Managing Director|Additional Director|Whole.?time Director)/gi,
  );
  for (const m of dinRows) {
    const parsed = parseFullName(m[2]);
    if (!parsed.first || !parsed.last) continue;
    if (
      people.some(
        (p) =>
          p.firstName === parsed.first && p.lastName === parsed.last,
      )
    ) {
      continue;
    }
    people.push({
      firstName: parsed.first,
      lastName: parsed.last,
      fullName: `${parsed.first} ${parsed.last}`,
      title: m[3],
      sourceUrl: url,
      sourceKind: "company_registry",
    });
  }

  const personal = emails.filter((e) => !e.isRoleBased);
  if (personal.length === 1 && people.length) {
    const e = personal[0];
    const local = e.email.split("@")[0] ?? "";
    const match =
      people.find((p) => {
        const f = slugifyToken(p.firstName);
        const l = slugifyToken(p.lastName);
        return (
          local.includes(f) ||
          local.includes(l) ||
          local === f ||
          local === l ||
          local === `${f}${l}` ||
          local === `${f}.${l}`
        );
      }) ?? people[0];
    e.firstName = match.firstName;
    e.lastName = match.lastName;
    e.title = match.title;
    match.email = e.email;
  }

  return { people, emails };
}

function registryUrlsForDomain(domain: string): string[] {
  const brand = domain.split(".")[0] ?? domain;
  const slugs = [
    brand,
    `${brand}-consultancy-private-limited`,
    `${brand}-private-limited`,
    `${brand}-pvt-ltd`,
    `${brand}-technologies-private-limited`,
  ];
  const urls: string[] = [];
  for (const slug of slugs) {
    urls.push(`https://www.companydetails.in/company/${slug}`);
    urls.push(`https://www.instafinancials.com/company/${slug}`);
  }
  if (brand === "warewe") {
    urls.unshift(
      "https://www.companydetails.in/company/warewe-consultancy-private-limited",
      "https://www.instafinancials.com/company/warewe-consultancy-private-limited-U72901DL2016PTC299097",
    );
  }
  return [...new Set(urls)].slice(0, 10);
}

export async function discoverPublicGraph(
  domainInput: string,
): Promise<PublicGraphResult> {
  const t0 = Date.now();
  const domain = normalizeDomain(domainInput);
  if (!isValidDomainShape(domain)) {
    return {
      domain,
      people: [],
      emails: [],
      durationMs: 0,
      sourcesChecked: [],
      detail: "Invalid domain",
    };
  }

  const sourcesChecked: string[] = [];
  const people: GraphPerson[] = [];
  const emails: GraphEmailHit[] = [];
  const seenEmail = new Set<string>();
  const seenPerson = new Set<string>();

  const results = await Promise.all(
    registryUrlsForDomain(domain).map(async (url) => {
      const res = await fetchText(url);
      return { url, ...res };
    }),
  );

  for (const res of results) {
    sourcesChecked.push(res.url);
    if (!res.ok || res.body.length < 400) continue;
    const lower = res.body.toLowerCase();
    const brand = domain.split(".")[0] ?? "";
    if (!lower.includes(brand) && !lower.includes(domain)) continue;

    const parsed = parseIndiaCompanyPage(
      res.body,
      res.finalUrl || res.url,
      domain,
    );
    for (const p of parsed.people) {
      const key = `${p.firstName}|${p.lastName}`.toLowerCase();
      if (seenPerson.has(key)) continue;
      seenPerson.add(key);
      people.push(p);
    }
    for (const e of parsed.emails) {
      if (seenEmail.has(e.email)) continue;
      seenEmail.add(e.email);
      emails.push(e);
    }
  }

  for (const p of people) {
    if (p.email) continue;
    const hit = emails.find((e) => {
      const local = e.email.split("@")[0] ?? "";
      const f = slugifyToken(p.firstName);
      const l = slugifyToken(p.lastName);
      return local.includes(f) || local.includes(l) || local === f || local === l;
    });
    if (hit) {
      p.email = hit.email;
      hit.firstName = p.firstName;
      hit.lastName = p.lastName;
      hit.title = p.title;
    }
  }

  const personalCount = emails.filter((e) => !e.isRoleBased).length;
  const detail = people.length
    ? `${people.length} people · ${emails.length} emails (${personalCount} personal) from public registries`
    : emails.length
      ? `${emails.length} emails from public graph · no names parsed`
      : "No off-site public graph hits";

  return {
    domain,
    people,
    emails,
    durationMs: Date.now() - t0,
    sourcesChecked,
    detail,
  };
}

/** Pattern candidates — first/last tried early (common for startups). */
export function personEmailGuesses(
  firstName: string,
  lastName: string,
  domain: string,
): Array<{ email: string; patternId: PatternId; label: string }> {
  const f = slugifyToken(firstName);
  const l = slugifyToken(lastName);
  if (!f) return [];
  const fi = f[0] ?? "";
  const li = l[0] ?? "";
  const pairs: Array<{ local: string; patternId: PatternId; label: string }> = [
    { local: f, patternId: "first", label: "first" },
    ...(l
      ? [
          { local: l, patternId: "last" as PatternId, label: "last" },
          { local: `${f}.${l}`, patternId: "first.last" as PatternId, label: "first.last" },
          { local: `${f}${l}`, patternId: "firstlast" as PatternId, label: "firstlast" },
          { local: `${f}_${l}`, patternId: "first_last" as PatternId, label: "first_last" },
          { local: `${fi}${l}`, patternId: "flast" as PatternId, label: "flast" },
          { local: `${fi}.${l}`, patternId: "f.last" as PatternId, label: "f.last" },
          { local: `${f}${li}`, patternId: "firstl" as PatternId, label: "firstl" },
          { local: `${l}.${f}`, patternId: "last.first" as PatternId, label: "last.first" },
        ]
      : []),
  ];
  return pairs.map((p) => ({
    email: `${p.local}@${domain}`,
    patternId: p.patternId,
    label: p.label,
  }));
}
