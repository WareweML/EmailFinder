/**
 * Live person enrichment. PDL-shaped keys. Identity-locked to the queried employer.
 */

import { createHash } from "node:crypto";
import { normalizeDomain, isValidDomainShape } from "./normalize";
import { classifyTitle, inferredSalary } from "./title-taxonomy";
import { countryFromPerson } from "./employee-geo";
import { enrichLinkedInProfile } from "./linkedin-public";
import { harvestRecords, parseLinkedInGuest, emailBelongs } from "./person-records";

export type PersonFindInput = {
  email?: string;
  linkedinUrl?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  domain?: string;
  company?: string;
  phone?: string;
};

export type PdlLocation = {
  name: string | null;
  locality: string | null;
  metro: string | null;
  region: string | null;
  country: string | null;
  continent: string | null;
  street_address: string | null;
  address_line_2: string | null;
  postal_code: string | null;
  geo: string | null;
};

export type PdlCompany = {
  id: string | null;
  name: string | null;
  website: string | null;
  size: string | null;
  founded: number | null;
  industry: string | null;
  industry_v2: string | null;
  linkedin_url: string | null;
  linkedin_id: string | null;
  facebook_url: string | null;
  twitter_url: string | null;
  ticker: string | null;
  type: string | null;
  location: PdlLocation;
};

export type PdlTitle = {
  name: string | null;
  role: string | null;
  sub_role: string | null;
  levels: string[];
  class: string | null;
};

export type PersonExperience = {
  company: PdlCompany;
  start_date: string | null;
  end_date: string | null;
  is_primary: boolean;
  location_names: string[];
  title: PdlTitle;
  summary: string | null;
};

export type PersonEducation = {
  degrees: string[];
  majors: string[];
  minors: string[];
  gpa: number | null;
  start_date: string | null;
  end_date: string | null;
  summary: string | null;
  school: {
    name: string | null;
    type: string | null;
    website: string | null;
    domain: string | null;
    id: string | null;
    linkedin_url: string | null;
    linkedin_id: string | null;
    facebook_url: string | null;
    twitter_url: string | null;
    location: PdlLocation;
  };
};

export type PersonFindData = {
  id: string;
  full_name: string;
  first_name: string | null;
  middle_initial: string | null;
  middle_name: string | null;
  last_initial: string | null;
  last_name: string | null;
  sex: string | null;
  birth_year: number | null;
  birth_date: string | null;
  linkedin_url: string | null;
  linkedin_username: string | null;
  linkedin_id: string | null;
  linkedin_connections: number | null;
  facebook_url: string | null;
  facebook_username: string | null;
  facebook_id: string | null;
  twitter_url: string | null;
  twitter_username: string | null;
  github_url: string | null;
  github_username: string | null;
  work_email: string | null;
  personal_emails: string[];
  recommended_personal_email: string | null;
  mobile_phone: string | null;
  phone_numbers: string[];
  emails: Array<{ address: string; type: string | null }>;
  industry: string | null;
  headline: string | null;
  summary: string | null;
  job_title: string | null;
  job_title_role: string | null;
  job_title_sub_role: string | null;
  job_title_class: string | null;
  job_title_levels: string[];
  job_summary: string | null;
  job_start_date: string | null;
  job_last_changed: string | null;
  job_last_verified: string | null;
  job_company_id: string | null;
  job_company_name: string | null;
  job_company_website: string | null;
  job_company_size: string | null;
  job_company_founded: number | null;
  job_company_industry: string | null;
  job_company_industry_v2: string | null;
  job_company_linkedin_url: string | null;
  job_company_linkedin_id: string | null;
  job_company_facebook_url: string | null;
  job_company_twitter_url: string | null;
  job_company_ticker: string | null;
  job_company_type: string | null;
  job_company_employee_count: number | null;
  job_company_inferred_revenue: string | null;
  job_company_total_funding_raised: number | null;
  job_company_12mo_employee_growth_rate: number | null;
  job_company_location_name: string | null;
  job_company_location_locality: string | null;
  job_company_location_metro: string | null;
  job_company_location_region: string | null;
  job_company_location_geo: string | null;
  job_company_location_street_address: string | null;
  job_company_location_address_line_2: string | null;
  job_company_location_postal_code: string | null;
  job_company_location_country: string | null;
  job_company_location_continent: string | null;
  location_name: string | null;
  location_locality: string | null;
  location_metro: string | null;
  location_region: string | null;
  location_country: string | null;
  location_continent: string | null;
  location_street_address: string | null;
  location_address_line_2: string | null;
  location_postal_code: string | null;
  location_geo: string | null;
  location_last_updated: string | null;
  location_names: string[];
  regions: string[];
  countries: string[];
  street_addresses: Array<PdlLocation & { street_address: string | null }>;
  experience: PersonExperience[];
  education: PersonEducation[];
  skills: string[];
  interests: string[];
  certifications: Array<{
    name: string | null;
    organization: string | null;
    start_date: string | null;
    end_date: string | null;
  }>;
  languages: Array<{ name: string | null; proficiency: number | null }>;
  profiles: Array<{ network: string; url: string; username: string | null; id: string | null }>;
  inferred_salary: string | null;
  inferred_years_experience: number | null;
  activity_score: number | null;
  profile_score: number | null;
  pwned: boolean | null;
  pwn_count: number | null;
  pwn_breaches: string[];
  pwn_data_classes: string[];
  pwn_latest: string | null;
  pwn_pastes: number | null;
  dataset_version: string;
};

export type PersonFindResponse = {
  data: PersonFindData;
  meta: { durationMs: number; sources: string[] };
};

const TITLE_ROLE =
  /\b(leader|director|manager|managing|head|officer|specialist|engineer|analyst|consultant|president|vp|vice president|coordinator|assistant|marketer|founder|co-?founder|partner|owner|principal|chairman|ceo|cto|cfo|coo|cmo)\b/i;

function emptyLoc(p: Partial<PdlLocation> = {}): PdlLocation {
  return {
    name: p.name ?? null,
    locality: p.locality ?? null,
    metro: p.metro ?? null,
    region: p.region ?? null,
    country: p.country ?? null,
    continent: p.continent ?? null,
    street_address: p.street_address ?? null,
    address_line_2: p.address_line_2 ?? null,
    postal_code: p.postal_code ?? null,
    geo: p.geo ?? null,
  };
}

function emptyCompany(name: string | null, website: string | null): PdlCompany {
  return {
    id: null,
    name,
    website,
    size: null,
    founded: null,
    industry: null,
    industry_v2: null,
    linkedin_url: null,
    linkedin_id: null,
    facebook_url: null,
    twitter_url: null,
    ticker: null,
    type: null,
    location: emptyLoc(),
  };
}

function idFor(key: string): string {
  return createHash("sha1").update(`mailgraph:person:${key}`).digest("hex").slice(0, 20);
}

function stripMarks(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function brandFromDomain(domain?: string | null): string | null {
  if (!domain) return null;
  const b = domain.replace(/^www\./, "").split(".")[0] ?? "";
  if (!b) return null;
  return b.charAt(0).toUpperCase() + b.slice(1);
}

function namesMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().split(/\s+/).filter(Boolean);
  const nb = b.toLowerCase().split(/\s+/).filter(Boolean);
  if (!na.length || !nb.length) return false;
  return na[0] === nb[0] && na[na.length - 1] === nb[nb.length - 1];
}

function slugFits(slug: string, fullName: string): boolean {
  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const s = compact(slug.replace(/-\d+$/, ""));
  const n = compact(fullName);
  return n.length >= 6 && (s.includes(n) || n.includes(s.slice(0, Math.min(n.length, s.length))));
}

function handleOf(url: string | null, host: string): string | null {
  if (!url) return null;
  const m = url.match(new RegExp(`${host.replace(".", "\\.")}/(?:in/|company/|person/)?([^/?#]+)`, "i"));
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function continentOf(country?: string | null): string | null {
  const c = (country ?? "").toLowerCase();
  if (/united states|canada|mexico/.test(c)) return "north america";
  if (/australia|new zealand/.test(c)) return "oceania";
  if (/india|singapore|uae|emirates|china|japan/.test(c)) return "asia";
  if (/united kingdom|germany|france|spain|italy/.test(c)) return "europe";
  return null;
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const { resilientFetch } = await import("./http");
    const r = await resilientFetch(url, { timeoutMs: 8000, maxAttempts: 2, preferBot: true });
    return r.ok ? r.body : null;
  } catch {
    return null;
  }
}

export async function findPerson(input: PersonFindInput): Promise<PersonFindResponse> {
  const t0 = Date.now();
  const sources: string[] = [];
  let email = (input.email ?? "").trim().toLowerCase() || undefined;
  let domain = input.domain ? normalizeDomain(input.domain) : email?.split("@")[1];
  let company = input.company?.trim() || undefined;
  let linkedinUrl = input.linkedinUrl?.trim() || undefined;
  let fullName = stripMarks((input.fullName ?? "").trim());
  if (!fullName && input.firstName) fullName = `${input.firstName} ${input.lastName ?? ""}`.trim();
  if (!company && domain) company = brandFromDomain(domain) ?? undefined;
  const queryDomain = domain;

  if (linkedinUrl) {
    const { profileSlugFromUrl } = await import("./identity-lock");
    const s = profileSlugFromUrl(linkedinUrl);
    linkedinUrl = s ? `https://www.linkedin.com/in/${s}/` : undefined;
  }

  if (!linkedinUrl && fullName && domain && isValidDomainShape(domain)) {
    try {
      const { lookupPersonAtCompany } = await import("./linkedin-company");
      const hits = await lookupPersonAtCompany({ domain, companyName: company, query: fullName });
      const hit = hits.find(
        (h) => namesMatch(fullName, h.fullName) || namesMatch(fullName, `${h.firstName} ${h.lastName}`),
      );
      const { profileSlugFromUrl, isPersonSlug } = await import("./identity-lock");
      const slugHit = profileSlugFromUrl(hit?.sourceUrl ?? "") ?? "";
      if (hit?.sourceUrl && slugHit && isPersonSlug(slugHit)) {
        linkedinUrl = `https://www.linkedin.com/in/${slugHit}/`;
        sources.push("linkedin-company-people");
      }
    } catch {
      /* */
    }
  }

  if (!linkedinUrl && fullName) {
    try {
      const { decodoSearch } = await import("./decodo-serp");
      const { profileSlugFromUrl, identityLocked } = await import("./identity-lock");
      const brand = domain?.split(".")[0] ?? "";
      const rows = (
        await Promise.all([
          decodoSearch(`site:linkedin.com/in "${fullName}"${company ? ` "${company}"` : ""}`),
          brand ? decodoSearch(`site:linkedin.com/in "${fullName}" "${brand}"`) : Promise.resolve([]),
        ])
      ).flat();
      let best: { slug: string; score: number } | null = null;
      for (const row of rows) {
        const decoded = profileSlugFromUrl(row.link ?? "");
        if (!decoded) continue;
        const head = (row.title ?? "").replace(/\s*\|\s*LinkedIn.*$/i, "");
        const blob = `${row.title ?? ""} ${row.description ?? ""}`;
        if (!namesMatch(fullName, head.split(/\s*[-–]\s*/)[0] ?? "") && !slugFits(decoded, fullName)) continue;
        if ((company || domain) && !identityLocked({ title: row.title ?? "", blob, fullName, company, domain })) continue;
        const score = (namesMatch(fullName, head) ? 5 : 0) + (slugFits(decoded, fullName) ? 4 : 0) + 8;
        if (score > (best?.score ?? 0)) best = { slug: decoded, score };
      }
      if (best && best.score >= 6) {
        linkedinUrl = `https://www.linkedin.com/in/${best.slug}/`;
        sources.push("linkedin-serp");
      }
    } catch {
      /* */
    }
  }

  const slug = linkedinUrl?.match(/linkedin\.com\/in\/([a-zA-Z0-9_%\-]+)/i)?.[1];
  const first = fullName.split(/\s+/)[0] ?? "";
  const last = fullName.split(/\s+/).slice(1).join(" ") || "";

  const [guestHtml, liPub, mx, emailHit, rec] = await Promise.all([
    slug ? fetchHtml(`https://www.linkedin.com/in/${slug}/`) : Promise.resolve(null),
    linkedinUrl ? enrichLinkedInProfile(linkedinUrl).catch(() => null) : Promise.resolve(null),
    domain && isValidDomainShape(domain) ? import("./dns").then((m) => m.lookupMx(domain!).catch(() => null)) : Promise.resolve(null),
    fullName && domain && isValidDomainShape(domain)
      ? import("./waterfall")
          .then((m) =>
            m.waterfallFindEmail({ fullName, domain: domain!, linkedinUrl, skipSmtp: false, skipDeepResearch: true }),
          )
          .catch(() => null)
      : Promise.resolve(null),
    harvestRecords({
      fullName,
      first,
      company,
      domain,
      guestHtml: undefined,
    }).catch(() => null),
  ]);

  if (guestHtml) sources.push("linkedin-guest");
  if (liPub) sources.push("linkedin-public");
  if (mx) sources.push("mx");
  if (emailHit) sources.push("email-waterfall");
  if (rec?.sources) sources.push(...rec.sources);

  const guest = guestHtml ? parseLinkedInGuest(guestHtml) : {};
  const jobTitle =
    rec?.job_title ||
    liPub?.title ||
    null;
  const tax = classifyTitle(jobTitle);
  const workEmailRaw = emailHit?.best?.email || rec?.email_hint || email || null;
  const { emailOnDomain } = await import("./identity-lock");
  const workEmail =
    queryDomain && workEmailRaw && !emailOnDomain(workEmailRaw, queryDomain)
      ? [email, rec?.email_hint, emailHit?.best?.email].find((e) => e && emailOnDomain(e, queryDomain)) ?? null
      : workEmailRaw;

  const personal = (rec?.personal_emails ?? []).filter((e) => emailBelongs(fullName, e));
  const phones = [...(rec?.phone_numbers ?? []), ...(input.phone ? [input.phone] : [])].filter(Boolean);
  let mobile = rec?.mobile_phone ?? phones[0] ?? null;
  try {
    const { findPersonMobile } = await import("./phone-waterfall");
    const hit = await findPersonMobile({
      fullName,
      company,
      domain: queryDomain,
      linkedinUrl,
      email: workEmail ?? email,
    });
    if (hit) {
      mobile = hit.display;
      if (!phones.includes(hit.display)) phones.unshift(hit.display);
      sources.push(hit.source);
    }
  } catch {
    /* */
  }

  let pwned: boolean | null = null;
  let pwnCount: number | null = null;
  let pwnBreaches: string[] = [];
  let pwnClasses: string[] = [];
  let pwnLatest: string | null = null;
  let pwnPastes: number | null = null;
  try {
    const { lookupPwned, lookupGravatar } = await import("./hibp");
    const accounts = [workEmail, email, ...personal, mobile, ...phones].filter((x): x is string => Boolean(x));
    const [hibp, grav] = await Promise.all([
      lookupPwned(accounts),
      workEmail || email ? lookupGravatar((workEmail ?? email) as string) : Promise.resolve(null),
    ]);
    if (hibp.pwned != null) {
      pwned = hibp.pwned;
      pwnCount = hibp.count;
      pwnBreaches = hibp.breaches.map((b) => b.title || b.name);
      pwnClasses = hibp.dataClasses;
      pwnLatest = hibp.latest;
      pwnPastes = hibp.pastes;
      sources.push("haveibeenpwned");
    }
    if (grav?.profileUrl) sources.push("gravatar");
  } catch {
    /* */
  }

  const countryName =
    countryFromPerson(linkedinUrl ?? "", `${liPub?.location ?? ""} ${rec?.locality ?? ""}`) ||
    rec?.company_location?.country ||
    (/\.in$/i.test(domain ?? "") || rec?.locality ? "india" : null);
  const locality = rec?.locality ?? null;
  const region = rec?.region ?? rec?.company_location?.region ?? null;
  const locName = [locality, region, countryName].filter(Boolean).join(", ") || null;
  const country = countryName?.toLowerCase() ?? null;
  const continent = continentOf(country);
  const today = new Date().toISOString().slice(0, 10);
  const slugName = linkedinUrl?.match(/linkedin\.com\/in\/([^/]+)/i)?.[1] ?? null;
  const companyName = company || liPub?.company || brandFromDomain(domain);
  const industry = rec?.industry && !/personal care|beauty|cosmetic|hair care/i.test(rec.industry)
    ? rec.industry
    : rec?.company_industry && !/personal care|beauty|cosmetic/i.test(rec.company_industry)
      ? rec.company_industry
      : null;

  const profiles: PersonFindData["profiles"] = [];
  if (linkedinUrl) profiles.push({ network: "linkedin", url: linkedinUrl, username: slugName, id: rec?.linkedin_id ?? null });
  if (rec?.facebook_url) {
    profiles.push({
      network: "facebook",
      url: rec.facebook_url,
      username: handleOf(rec.facebook_url, "facebook.com"),
      id: rec.facebook_id,
    });
  }

  const experience: PersonExperience[] = [
    {
      company: emptyCompany(companyName ?? null, domain ? `https://${domain}` : null),
      start_date: rec?.job_start_date ?? null,
      end_date: null,
      is_primary: true,
      location_names: locName ? [locName] : [],
      title: {
        name: jobTitle,
        role: tax.role,
        sub_role: tax.subRole,
        levels: tax.levels,
        class: tax.titleClass,
      },
      summary: rec?.job_summary ?? rec?.summary ?? null,
    },
  ];

  const data: PersonFindData = {
    id: idFor(linkedinUrl || workEmail || fullName + (domain ?? "")),
    full_name: fullName,
    first_name: first || null,
    middle_initial: null,
    middle_name: null,
    last_initial: last ? last[0]!.toUpperCase() : null,
    last_name: last || null,
    sex: rec?.sex ?? null,
    birth_year: rec?.birth_year ?? null,
    birth_date: rec?.birth_date ?? null,
    linkedin_url: linkedinUrl ?? null,
    linkedin_username: slugName,
    linkedin_id: rec?.linkedin_id ?? guest.linkedin_id ?? null,
    linkedin_connections: rec?.linkedin_connections ?? guest.linkedin_connections ?? null,
    facebook_url: rec?.facebook_url ?? null,
    facebook_username: handleOf(rec?.facebook_url ?? null, "facebook.com"),
    facebook_id: rec?.facebook_id ?? null,
    twitter_url: null,
    twitter_username: null,
    github_url: null,
    github_username: null,
    work_email: workEmail,
    personal_emails: personal,
    recommended_personal_email: personal[0] ?? null,
    mobile_phone: mobile,
    phone_numbers: phones,
    emails: [
      ...(workEmail ? [{ address: workEmail, type: "current_professional" }] : []),
      ...personal.map((e) => ({ address: e, type: "personal" })),
    ],
    industry,
    headline: jobTitle,
    summary: rec?.summary ?? guest.summary ?? null,
    job_title: jobTitle,
    job_title_role: tax.role,
    job_title_sub_role: tax.subRole,
    job_title_class: tax.titleClass,
    job_title_levels: tax.levels,
    job_summary: rec?.job_summary ?? rec?.summary ?? null,
    job_start_date: rec?.job_start_date ?? null,
    job_last_changed: null,
    job_last_verified: linkedinUrl ? today : null,
    job_company_id: rec?.company_linkedin_id ?? null,
    job_company_name: companyName ?? null,
    job_company_website: domain ? `https://${domain}` : null,
    job_company_size: rec?.company_size ?? null,
    job_company_founded: rec?.company_founded ?? null,
    job_company_industry: industry,
    job_company_industry_v2: industry,
    job_company_linkedin_url: rec?.company_linkedin_url ?? null,
    job_company_linkedin_id: rec?.company_linkedin_id ?? null,
    job_company_facebook_url: null,
    job_company_twitter_url: null,
    job_company_ticker: null,
    job_company_type: null,
    job_company_employee_count: rec?.company_size ? Number(String(rec.company_size).replace(/[^\d]/g, "")) || null : null,
    job_company_inferred_revenue: null,
    job_company_total_funding_raised: null,
    job_company_12mo_employee_growth_rate: null,
    job_company_location_name: rec?.company_location?.name ?? locName,
    job_company_location_locality: rec?.company_location?.locality ?? locality,
    job_company_location_metro: rec?.company_location?.metro ?? null,
    job_company_location_region: rec?.company_location?.region ?? region,
    job_company_location_geo: rec?.company_location?.geo ?? null,
    job_company_location_street_address: rec?.company_location?.street_address ?? null,
    job_company_location_address_line_2: null,
    job_company_location_postal_code: rec?.company_location?.postal_code ?? null,
    job_company_location_country: rec?.company_location?.country ?? country,
    job_company_location_continent: rec?.company_location?.continent ?? continent,
    location_name: locName,
    location_locality: locality,
    location_metro: null,
    location_region: region,
    location_country: country,
    location_continent: continent,
    location_street_address: rec?.street_address ?? null,
    location_address_line_2: null,
    location_postal_code: rec?.postal_code ?? null,
    location_geo: null,
    location_last_updated: locName ? today : null,
    location_names: locName ? [locName.toLowerCase()] : [],
    regions: region ? [region] : [],
    countries: country ? [country] : [],
    street_addresses: rec?.street_address
      ? [emptyLoc({ street_address: rec.street_address, locality, region, country, postal_code: rec.postal_code })]
      : [],
    experience,
    education: [],
    skills: [],
    interests: [],
    certifications: [],
    languages: [],
    profiles,
    inferred_salary: inferredSalary(tax.levels, countryName),
    inferred_years_experience: rec?.job_start_date
      ? Math.max(0, new Date().getFullYear() - Number(rec.job_start_date.slice(0, 4)))
      : null,
    activity_score: linkedinUrl ? 0.7 : null,
    profile_score: Math.min(
      1,
      (Number(Boolean(linkedinUrl)) + Number(Boolean(workEmail)) + Number(Boolean(jobTitle)) + Number(Boolean(locName))) / 4,
    ),
    pwned,
    pwn_count: pwnCount,
    pwn_breaches: pwnBreaches,
    pwn_data_classes: pwnClasses,
    pwn_latest: pwnLatest,
    pwn_pastes: pwnPastes,
    dataset_version: "live-1",
  };

  return { data, meta: { durationMs: Date.now() - t0, sources: [...new Set(sources)] } };
}
