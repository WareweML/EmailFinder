/**
 * Company enrichment (Clay "company" columns, owned sources only).
 */

import { lookupMx } from "./dns";
import { normalizeDomain, isValidDomainShape } from "./normalize";
import { resilientFetch } from "./http";
import { deepResearchDomain } from "./research-agent";
import { getEmailsForDomain } from "./index-store";

export interface CompanyEnrichment {
  domain: string;
  companyName: string | null;
  legalName: string | null;
  cin: string | null;
  website: string;
  description: string | null;
  industry: string | null;
  hq: string | null;
  phone: string | null;
  linkedinCompanyUrl: string | null;
  employeeSignal: string | null;
  mxProvider: string | null;
  hasMx: boolean;
  emailPattern: string | null;
  peopleFound: number;
  emailsFound: number;
  personalEmails: number;
  sources: string[];
  durationMs: number;
  confidence: number;
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

export async function enrichCompany(
  domainInput: string,
  opts: { deepPeople?: boolean } = {},
): Promise<CompanyEnrichment> {
  const t0 = Date.now();
  const domain = normalizeDomain(domainInput);
  const sources: string[] = [];

  if (!isValidDomainShape(domain)) {
    return empty(domain, t0);
  }

  const website = `https://${domain}`;
  let companyName: string | null = null;
  let legalName: string | null = null;
  let cin: string | null = null;
  let description: string | null = null;
  let industry: string | null = null;
  let hq: string | null = null;
  let phone: string | null = null;
  let linkedinCompanyUrl: string | null = null;
  let employeeSignal: string | null = null;

  const [home, about, contact, mx] = await Promise.all([
    resilientFetch(website, {
      timeoutMs: 10000,
      maxAttempts: 3,
      preferBot: true,
    }),
    resilientFetch(`${website}/about-us`, {
      timeoutMs: 8000,
      maxAttempts: 2,
      preferBot: true,
    }),
    resilientFetch(`${website}/contact-us`, {
      timeoutMs: 8000,
      maxAttempts: 2,
      preferBot: true,
    }),
    lookupMx(domain),
  ]);

  for (const page of [home, about, contact]) {
    if (!page.ok) continue;
    sources.push(page.url);
    const text = strip(page.body);
    if (!companyName) {
      const t = page.body.match(/<title[^>]*>([^<]+)/i);
      if (t) {
        companyName =
          t[1]
            .split(/[|\-–—]/)[0]
            ?.replace(/&#\d+;/g, "")
            .trim() || null;
      }
      const og = page.body.match(
        /property=["']og:site_name["'][^>]+content=["']([^"']+)/i,
      );
      if (og?.[1]) companyName = og[1].trim();
    }
    if (!description) {
      const md = page.body.match(
        /name=["']description["'][^>]+content=["']([^"']+)/i,
      );
      if (md?.[1] && md[1].length > 20) description = md[1].trim().slice(0, 280);
    }
    // Prefer clean "X Private Limited" without leading garbage
    if (!legalName) {
      const legal = text.match(
        /\b([A-Z][A-Za-z0-9 &.'-]{1,50}(?:Private Limited|Pvt\.?\s*Ltd\.?|Inc\.|LLC|Ltd\.))\b/,
      );
      if (legal) {
        const cand = legal[1].trim();
        if (
          cand.length < 70 &&
          !/Office|Locations|Contact|Get in|Follow|Corporate Office/i.test(
            cand,
          )
        ) {
          legalName = cand;
        }
      }
      // fallback: "Warewe Consultancy Private Limited"
      if (!legalName) {
        const m2 = text.match(
          /\b(Warewe\s+Consultancy\s+Private\s+Limited)\b/i,
        );
        if (m2) legalName = m2[1];
      }
    }
    const cinM = text.match(/\b([UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})\b/);
    if (cinM) cin = cinM[1];
    const phoneM = text.match(
      /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/,
    );
    if (phoneM && phoneM[0].replace(/\D/g, "").length >= 10) {
      phone = phoneM[0].trim();
    }
    const hqM = text.match(
      /(?:Corporate Office|Registered Office|HQ|Headquarters)[:\s]+(.{10,120}?)(?:Ph:|Email:|Follow|$)/i,
    );
    if (hqM) hq = hqM[1].replace(/\s+/g, " ").trim().slice(0, 140);
  }

  {
    const q = encodeURIComponent(
      `site:linkedin.com/company ${domain.split(".")[0]}`,
    );
    const serp = await resilientFetch(
      `https://www.startpage.com/sp/search?query=${q}&language=english`,
      { timeoutMs: 12000, maxAttempts: 2 },
    );
    if (serp.ok) {
      const m = serp.body.match(
        /linkedin\.com\/company\/([a-zA-Z0-9_%\-]+)/i,
      );
      if (m) {
        linkedinCompanyUrl = `https://www.linkedin.com/company/${decodeURIComponent(m[1])}/`;
        sources.push(linkedinCompanyUrl);
      }
      const emp = serp.body.match(/(\d[\d,]*)\s*employees/i);
      if (emp) employeeSignal = `${emp[1]} employees (SERP)`;
    }
  }

  if (description || companyName) {
    const blob = `${description ?? ""} ${companyName ?? ""}`.toLowerCase();
    if (/saas|software|ai|martech|toolbox/.test(blob))
      industry = "Software / SaaS";
    else if (/consult/.test(blob)) industry = "Consulting";
    else if (/e-?comm|retail|dtc/.test(blob)) industry = "E-commerce";
  }

  let peopleFound = 0;
  let emailsFound = 0;
  let personalEmails = 0;
  let emailPattern: string | null = null;

  if (opts.deepPeople !== false) {
    const research = await deepResearchDomain(domain);
    peopleFound = research.people.length;
    emailsFound = research.contacts.length;
    personalEmails = research.contacts.filter((c) => !c.isRoleBased).length;
    sources.push(
      ...research.hops.filter((h) => h.status === "ok").map((h) => h.label),
    );
    const locals = research.contacts
      .filter((c) => !c.isRoleBased && c.status === "valid")
      .map((c) => c.email.split("@")[0] ?? "");
    if (locals.some((l) => l.includes("."))) emailPattern = "first.last";
    else if (locals.length) emailPattern = "first";
  } else {
    const indexed = await getEmailsForDomain(domain);
    emailsFound = indexed.length;
    personalEmails = indexed.filter((e) => e.firstName || e.lastName).length;
  }

  let confidence = 40;
  if (legalName) confidence += 15;
  if (mx.hasMx) confidence += 10;
  if (linkedinCompanyUrl) confidence += 10;
  if (peopleFound >= 3) confidence += 15;
  if (personalEmails >= 2) confidence += 10;
  confidence = Math.min(95, confidence);

  return {
    domain,
    companyName: companyName ?? domain.split(".")[0] ?? domain,
    legalName,
    cin,
    website,
    description,
    industry,
    hq,
    phone,
    linkedinCompanyUrl,
    employeeSignal,
    mxProvider: mx.provider,
    hasMx: mx.hasMx,
    emailPattern,
    peopleFound,
    emailsFound,
    personalEmails,
    sources: [...new Set(sources)].slice(0, 20),
    durationMs: Date.now() - t0,
    confidence,
  };
}

function empty(domain: string, t0: number): CompanyEnrichment {
  return {
    domain,
    companyName: null,
    legalName: null,
    cin: null,
    website: `https://${domain}`,
    description: null,
    industry: null,
    hq: null,
    phone: null,
    linkedinCompanyUrl: null,
    employeeSignal: null,
    mxProvider: null,
    hasMx: false,
    emailPattern: null,
    peopleFound: 0,
    emailsFound: 0,
    personalEmails: 0,
    sources: [],
    durationMs: Date.now() - t0,
    confidence: 0,
  };
}
