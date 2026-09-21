/**
 * Public-record + LinkedIn-guest extras for PDL person fields.
 * SERP-first; HTML only when the URL is clearly this person.
 */

import { resilientFetch } from "./http";

export type RecordHit = {
  sex: string | null;
  birth_year: number | null;
  birth_date: string | null;
  mobile_phone: string | null;
  phone_numbers: string[];
  personal_emails: string[];
  street_address: string | null;
  postal_code: string | null;
  locality: string | null;
  region: string | null;
  facebook_url: string | null;
  facebook_id: string | null;
  linkedin_id: string | null;
  linkedin_connections: number | null;
  summary: string | null;
  job_summary: string | null;
  industry: string | null;
  job_title: string | null;
  job_start_date: string | null;
  email_hint: string | null;
  alt_emails: string[];
  company_location: {
    name: string | null;
    locality: string | null;
    region: string | null;
    country: string | null;
    continent: string | null;
    street_address: string | null;
    postal_code: string | null;
    metro: string | null;
    geo: string | null;
  };
  company_linkedin_url: string | null;
  company_linkedin_id: string | null;
  company_industry: string | null;
  company_size: string | null;
  company_founded: number | null;
  sources: string[];
};

const MONTH: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function selfRow(title: string, url: string, name: string, company?: string, desc = ""): boolean {
  const u = url.toLowerCase();
  const t = title.toLowerCase();
  const n = name.toLowerCase();
  const hay = compact(`${title} ${url} ${desc}`);
  const brand = compact(company ?? "");
  if (brand.length > 4 && /rocketreach\.co|tofler\.in|behance\.net|adapt\.io|filesure\.in|companydetails\.in/i.test(u))
    return hay.includes(brand);
  if (brand.length > 4 && /unpan|thatsthem|truepeople|fastpeople|spokeo|whitepages/i.test(u) && !hay.includes(brand))
    return false;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (u.includes(slug) && brand && hay.includes(brand)) return true;
  return t.startsWith(n) && /phone|address|email|age/i.test(t) && (!brand || hay.includes(brand));
}

const US_NPA = /^(201|202|203|205|206|207|208|209|210|212|213|214|215|216|217|218|219|220|224|225|228|229|231|234|239|240|248|251|252|253|254|256|260|262|267|269|270|272|276|279|281|301|302|303|304|305|307|308|309|310|312|313|314|315|316|317|318|319|320|321|323|325|326|330|331|332|334|336|337|339|346|347|351|352|360|361|364|380|385|386|401|402|404|405|406|407|408|409|410|412|413|414|415|417|419|423|424|425|430|432|434|435|440|442|443|445|458|463|469|470|475|478|479|480|484|501|502|503|504|505|507|508|509|510|512|513|515|516|517|518|520|530|531|534|539|540|541|551|559|561|562|563|564|567|570|571|573|574|575|580|585|586|601|602|603|605|606|607|608|609|610|612|614|615|616|617|618|619|620|623|626|628|629|630|631|636|640|641|646|650|651|657|660|661|662|667|669|678|680|681|682|684|701|702|703|704|706|707|708|712|713|714|715|716|717|718|719|720|724|725|726|727|730|731|732|734|737|740|743|747|754|757|760|762|763|765|769|770|772|773|774|775|779|781|785|786|801|802|803|804|805|806|808|810|812|813|814|815|816|817|818|828|830|831|832|835|843|845|847|848|850|854|856|857|858|859|860|862|863|864|865|870|872|878|901|903|904|906|907|908|909|910|912|913|914|915|916|917|918|919|920|925|928|929|930|931|934|936|937|938|940|941|947|949|951|952|954|956|959|970|971|972|973|978|979|980|984|985|986|989)$/;

function phonesIn(text: string, preferIn = false): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (cc: "91" | "1", digits: string) => {
    const d = digits.replace(/\D/g, "");
    if (d.length !== 10) return;
    const key = d;
    if (seen.has(key)) return;
    seen.add(key);
    if (cc === "91") {
      if (!/^[6-9]/.test(d)) return;
      out.push(`+91 ${d.slice(0, 5)} ${d.slice(5)}`);
    } else {
      if (!US_NPA.test(d.slice(0, 3))) return;
      if (/^[6-9]/.test(d) && preferIn) return;
      out.push(`+1 ${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`);
    }
  };
  const inRe = /\+91[\s-]*([6-9]\d{4})[\s-]*(\d{5})/g;
  let m: RegExpExecArray | null;
  while ((m = inRe.exec(text))) add("91", m[1]! + m[2]!);
  const in10 = /(?:\+91[\s-]*)?([6-9]\d{9})\b/g;
  while ((m = in10.exec(text))) add("91", m[1]!);
  if (!preferIn) {
    const us = /\+?1[\s.-]*\(?\s*([2-5]\d{2})\s*\)?[\s.-]*(\d{3})[\s.-]*(\d{4})/g;
    while ((m = us.exec(text))) add("1", m[1]! + m[2]! + m[3]!);
  }
  return out;
}

export function emailBelongs(fullName: string, email: string): boolean {
  const local = (email.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (local.length < 4) return false;
  if (/^(info|admin|hello|contact|sales|support|mail|office)$/.test(local)) return false;
  const tokens = fullName.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
  const last = tokens[tokens.length - 1] ?? "";
  const first = tokens[0] ?? "";
  if (last && local.includes(last)) return true;
  if (first && last && (local.includes(first) && local.includes(last[0] ?? ""))) return true;
  return false;
}

function emailsIn(text: string, fullName: string): string[] {
  return [...new Set((text.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) ?? [])
    .map((e) => e.toLowerCase())
    .filter((e) => !/example\.|sentry\.|wixpress|godaddy|schema|sentry|png|jpg/.test(e))
    .filter((e) => emailBelongs(fullName, e)))];
}

function parseBirth(text: string): { year: number | null; date: string | null } {
  const okYear = (y: number) => y >= 1955 && y <= new Date().getFullYear() - 21;
  const full = text.match(/born on ([A-Z][a-z]+) (\d{1,2}), (\d{4})/i);
  if (full) {
    const year = Number(full[3]);
    if (okYear(year)) {
      const mo = MONTH[full[1]!.toLowerCase()];
      const day = full[2]!.padStart(2, "0");
      return { year, date: mo ? `${full[3]}-${mo}-${day}` : `${full[3]}-01-01` };
    }
  }
  const ageMo = text.match(/Age\s*(\d{2})\s*\(([A-Z][a-z]{2,9})(?:\.?\s+(\d{1,2}))?,?\s*(\d{4})\)/i);
  if (ageMo) {
    const year = Number(ageMo[4]);
    const a = Number(ageMo[1]);
    if (okYear(year) && a >= 21 && a <= 70) {
      const moName = ageMo[2]!.toLowerCase();
      const mo = MONTH[moName] ?? MONTH[Object.keys(MONTH).find((k) => k.startsWith(moName.slice(0, 3))) ?? ""];
      const day = ageMo[3] ? ageMo[3].padStart(2, "0") : "01";
      return { year, date: mo ? `${ageMo[4]}-${mo}-${day}` : `${ageMo[4]}-01-01` };
    }
  }
  const y = text.match(/\bborn\s+(?:on\s+|in\s+)?(?:[A-Z][a-z]+\s+(?:\d{1,2},?\s+)?)?(19[4-9]\d|20[0-1]\d)\b/i);
  if (y) {
    const year = Number(y[1]);
    if (year >= 1945 && year <= new Date().getFullYear() - 18) return { year, date: `${year}-01-01` };
  }
  const age = text.match(/\b(?:is|age)\s+(\d{2})\s+years old\b/i);
  if (age) {
    const a = Number(age[1]);
    if (a >= 21 && a <= 70) {
      const year = new Date().getFullYear() - a;
      return { year, date: `${year}-01-01` };
    }
  }
  return { year: null, date: null };
}

function parseStreet(text: string): { street: string | null; city: string | null; region: string | null; postal: string | null } {
  const m = text.match(
    /(\d{1,5}\s+[A-Z][A-Za-z0-9 .]+(?:Ave|Avenue|St|Street|Rd|Road|Blvd|Dr|Drive|Pl|Place|Ct|Ln|Lane)\.?)\s*(?:Apt\s*[\w-]+)?\s*,?\s*([A-Z][A-Za-z .]+),\s*([A-Z]{2})\s*(\d{5})?/i,
  );
  if (!m) return { street: null, city: null, region: null, postal: null };
  return { street: m[1]!.replace(/\s+/g, " ").trim(), city: m[2]!.trim(), region: m[3]!.toUpperCase(), postal: m[4] ?? null };
}

function industryFromText(text: string): string | null {
  const t = text.toLowerCase();
  if (/real estate|realtor|property consultant|property advisory|channel partner|home buying/.test(t)) return "Real Estate";
  if (/\bkubernetes\b|devops|saas\b|software development|cloud infrastructure/.test(t)) return "Computer Software";
  if (/\bfintech\b|payments|banking/.test(t)) return "Financial Services";
  return null;
}

async function personFromEmployerSite(domain: string, fullName: string): Promise<{
  title: string | null;
  summary: string | null;
  location: string | null;
  phone: string | null;
}> {
  const paths = ["/", "/about", "/about-us", "/aboutus", "/team", "/our-team", "/leadership", "/people", "/founders"];
  const needle = fullName.trim();
  if (!needle || needle.length < 5) return { title: null, summary: null, location: null, phone: null };
  for (const path of paths) {
    try {
      const page = await resilientFetch(`https://${domain}${path}`, { timeoutMs: 8000, maxAttempts: 1, preferBot: true });
      if (!page.ok || page.body.length < 400) continue;
      const html = page.body;
      const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const idx = html.search(re);
      if (idx < 0) continue;
      const window = html
        .slice(Math.max(0, idx - 80), idx + 900)
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z#0-9]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      const after = window.split(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"))[1] ?? "";
      const title =
        after.match(
          /\b(Co-?Founder|Founder|Managing Partner|Managing Director|Partner|CEO|CTO|CFO|COO|Director|Head of [^,]{3,40}|Vice President|President)\b/i,
        )?.[0] ?? null;
      const summary = after.replace(/\s+/g, " ").trim().slice(0, 420) || null;
      const location =
        window.match(/\b(Gurugram|Gurgaon|Noida|Bengaluru|Bangalore|Mumbai|Delhi|Hyderabad|Pune|Chennai|Sydney|London|New York)\b/i)?.[1] ??
        null;
      const tel = window.match(/\+91[\s-]*[6-9]\d(?:[\s-]?\d){8}|\b[6-9]\d{9}\b/)?.[0] ?? null;
      if (title || (summary && summary.length > 40) || tel) {
        return { title, summary: summary && summary.length > 40 ? summary : null, location: location?.toLowerCase() ?? null, phone: tel };
      }
    } catch {
      /* */
    }
  }
  return { title: null, summary: null, location: null, phone: null };
}

export function parseLinkedInGuest(html: string): Partial<RecordHit> {
  if (!html || html.length < 400 || /just a moment/i.test(html)) return {};
  const attr = (prop: string) =>
    html.match(new RegExp(`property="${prop}" content="([^"]*)"`, "i"))?.[1] ??
    html.match(new RegExp(`content="([^"]*)" property="${prop}"`, "i"))?.[1] ??
    "";
  const desc = (attr("og:description") || "").replace(/&/g, "&").replace(/&#39;/g, "'");
  const industry =
    html.match(/"industryName":"([^"]+)"/)?.[1] ??
    html.match(/Industry<\/dt>\s*<dd[^>]*>\s*([^<]+)/i)?.[1] ??
    null;
  const connections =
    Number(html.match(/([\d,]+)\+?\s*connections/i)?.[1]?.replace(/,/g, "")) ||
    (html.includes("500+") ? 500 : null);
  const linkedin_id =
    html.match(/urn:li:(?:fsd_profile|member):([A-Za-z0-9_\-]+)/)?.[1] ??
    html.match(/"objectUrn":"urn:li:member:(\d+)"/)?.[1] ??
    html.match(/"profileId":"(\d+)"/)?.[1] ??
    null;
  const tenure = html.match(/(\d+)\s+years?\s+(\d+)\s+months?/i) ?? desc.match(/(\d+)\s+years?\s+(\d+)\s+months?/i);
  let job_start_date: string | null = null;
  if (tenure) {
    const d = new Date();
    d.setMonth(d.getMonth() - (Number(tenure[1]) * 12 + Number(tenure[2])));
    job_start_date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  let summary: string | null = null;
  const about = desc.split(/·/).pop()?.replace(/^I'm |^I am /i, "").trim();
  if (about && about.length > 40 && !/^view /i.test(about)) summary = about.slice(0, 500);
  const job_summary = desc.match(/At [A-Z][^.]{8,240}\./)?.[0] ?? summary;
  const loc =
    html.match(/\b(Gurgaon|Gurugram),\s*Haryana(?:,\s*India)?/i)?.[0] ??
    html.match(/"defaultLocalizedName":"([^"]{4,40})"/)?.[1] ??
    "";
  return {
    linkedin_id,
    linkedin_connections: connections,
    industry: industry?.replace(/\s+/g, " ").trim() || null,
    summary,
    job_summary,
    job_start_date,
    locality: /gurgaon|gurugram/i.test(loc) ? "gurugram" : null,
    region: /haryana/i.test(loc) ? "haryana" : null,
  };
}

async function genderOf(first: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.genderize.io?name=${encodeURIComponent(first)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { gender?: string; probability?: number };
    if (j.gender && (j.probability ?? 0) >= 0.7) return j.gender;
  } catch {
    /* */
  }
  return null;
}

export async function companyLite(domain: string, name: string) {
  const brand = domain.split(".")[0]!;
  const tld = domain.split(".").slice(1).join(".");
  const slugs = [`${brand}-${tld}`, `${brand}ai`, name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), brand].filter(
    (s, i, a) => s.length > 1 && a.indexOf(s) === i,
  );
  for (const slug of slugs) {
    try {
      const html = await resilientFetch(`https://www.linkedin.com/company/${slug}/`, { timeoutMs: 6000, maxAttempts: 1 });
      if (!html.ok || html.body.length < 1500) continue;
      const title = (html.body.match(/<title>([^<]+)/i)?.[1] ?? "").toLowerCase();
      if (!title.includes(brand.toLowerCase()) && !html.body.toLowerCase().includes(domain.toLowerCase())) continue;
      const street = html.body.match(/"streetAddress":"([^"]+)"/)?.[1] ?? null;
      const locality = html.body.match(/"addressLocality":"([^"]+)"/)?.[1] ?? null;
      const region = html.body.match(/"addressRegion":"([^"]+)"/)?.[1] ?? null;
      const postal = html.body.match(/"postalCode":"([^"]+)"/)?.[1] ?? null;
      const countryRaw = html.body.match(/"addressCountry":"([^"]+)"/)?.[1] ?? null;
      const country = countryRaw && countryRaw.length === 2
        ? ({ US: "united states", AU: "australia", GB: "united kingdom", CA: "canada", IN: "india", AE: "united arab emirates" } as Record<string, string>)[countryRaw.toUpperCase()] ?? countryRaw
        : countryRaw?.toLowerCase() ?? null;
      const hq = html.body.match(/Headquarters<\/dt>\s*<dd[^>]*>\s*([^<]+)/i)?.[1]?.trim();
      let industry =
        html.body.match(/Industry<\/dt>\s*<dd[^>]*>\s*([^<]+)/i)?.[1]?.trim() ??
        html.body.match(/"industryName"\s*:\s*"([^"]{4,60})"/i)?.[1] ??
        industryFromText(`${title} ${html.body.slice(0, 4000)}`) ??
        null;
      if (industry && /personal care|beauty|cosmetic|hair care/i.test(industry) && !/beauty|cosmetic|personal care/i.test(`${brand} ${title}`)) {
        industry = industryFromText(`${title} ${html.body.slice(0, 4000)}`);
      }
      const founded = html.body.match(/Founded<\/dt>\s*<dd[^>]*>\s*[^<]*?(1[89]\d{2}|20\d{2})/i)?.[1]
        ?? html.body.match(/"foundedOn"\s*:\s*\{[^}]*"year"\s*:\s*(\d{4})/i)?.[1]
        ?? html.body.match(/founded in (20\d{2}|19\d{2})/i)?.[1];
      const emp = html.body.match(/([\d,]+)\+?\s*employees/i)?.[1]?.replace(/,/g, "");
      const orgId = html.body.match(/urn:li:organization:(\d{3,})/)?.[1] ?? null;
      const continent = /united states|canada|mexico/.test(country ?? "")
        ? "north america"
        : /australia/.test(country ?? "")
          ? "oceania"
          : /india|singapore|uae|emirates/.test(country ?? "")
          ? "asia"
        : /united kingdom|germany|france/.test(country ?? "")
            ? "europe"
            : null;
      const nameStr = [locality, region, country].filter(Boolean).join(", ").toLowerCase() || hq?.toLowerCase() || null;
      return {
        company_location: {
          name: nameStr,
          locality: locality?.toLowerCase() ?? null,
          region: region?.toLowerCase() ?? null,
          country,
          continent,
          street_address: street,
          postal_code: postal,
          metro: null,
          geo: null,
        },
        company_linkedin_url: `https://www.linkedin.com/company/${slug}/`,
        company_linkedin_id: orgId,
        company_industry: industry,
        company_size: emp ? `${Number(emp).toLocaleString()}+` : null,
        company_founded: founded ? Number(founded) : null,
      };
    } catch {
      /* */
    }
  }
  return null;
}

export async function harvestRecords(input: {
  fullName: string;
  first: string;
  company?: string;
  domain?: string;
  locationHint?: string;
  guestHtml?: string | null;
  linkedinSlug?: string;
}): Promise<RecordHit> {
  const sources: string[] = [];
  const emptyLoc = {
    name: null, locality: null, region: null, country: null, continent: null,
    street_address: null, postal_code: null, metro: null, geo: null,
  };
  const hit: RecordHit = {
    sex: null, birth_year: null, birth_date: null, mobile_phone: null, phone_numbers: [],
    personal_emails: [], street_address: null, postal_code: null, locality: null, region: null,
    facebook_url: null, facebook_id: null, linkedin_id: null, linkedin_connections: null,
    summary: null, job_summary: null, industry: null, job_title: null, job_start_date: null, email_hint: null, alt_emails: [],
    company_location: emptyLoc, company_linkedin_url: null, company_linkedin_id: null,
    company_industry: null, company_size: null, company_founded: null, sources,
  };

  const slug = input.fullName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const loc = input.locationHint ?? "";
  const { decodoSearch, decodoShards } = await import("./decodo-serp");
  const [gender, pages, co, guest, site] = await Promise.all([
    genderOf(input.first),
    decodoShards(
      (input.linkedinSlug
        ? [
            `site:linkedin.com/in/${input.linkedinSlug}`,
            `site:rocketreach.co "${input.linkedinSlug}"`,
            `"linkedin.com/in/${input.linkedinSlug}"`,
          ]
        : [
            `"${input.fullName}"${input.company ? ` "${input.company}"` : ""} (phone OR mobile)`,
            `site:rocketreach.co "${input.fullName}"${input.company ? ` "${input.company}"` : ""}`,
            `site:datanyze.com "${input.fullName}"${input.company ? ` "${input.company}"` : ""}`,
            `site:instagram.com "${input.fullName}"${input.company ? ` "${input.company}"` : ""}`,
            `site:tofler.in "${input.fullName}" director`,
            `site:filesure.in/director "${input.fullName}"`,
            `"${input.fullName}" "${input.domain ?? input.company ?? ""}" (director OR "co-founder")`,
            `site:adapt.io "${input.fullName}"${input.company ? ` "${input.company}"` : ""}`,
            `site:behance.net "${input.fullName}"${input.company ? ` "${input.company}"` : ""}`,
            input.company
              ? `"${input.fullName}" "${input.company}" (@gmail.com OR @yahoo.com OR @icloud.com)`
              : `"${input.fullName}" "@gmail.com"`,
            input.domain && input.first
              ? `"${input.first.toLowerCase()}@${input.domain.replace(/^www\./, "")}"`
              : "",
          ]
      ).filter(Boolean),
    ),
    input.domain ? companyLite(input.domain, input.company ?? input.domain.split(".")[0]!) : Promise.resolve(null),
    Promise.resolve(input.guestHtml ? parseLinkedInGuest(input.guestHtml) : {}),
    input.domain ? personFromEmployerSite(input.domain.replace(/^www\./, ""), input.fullName) : Promise.resolve({ title: null, summary: null, location: null, phone: null }),
  ]);

  if (gender) {
    hit.sex = gender;
    sources.push("genderize");
  }
  Object.assign(hit, guest);
  if (guest.summary || guest.linkedin_id || guest.linkedin_connections) sources.push("linkedin-guest-fields");
  if (co) {
    hit.company_location = co.company_location;
    hit.company_linkedin_url = co.company_linkedin_url;
    hit.company_linkedin_id = co.company_linkedin_id;
    hit.company_industry = co.company_industry;
    hit.company_size = co.company_size;
    hit.company_founded = co.company_founded;
    sources.push("company-linkedin");
  }
  if (site.title || site.summary || site.phone) {
    if (site.title) hit.job_title = site.title;
    if (site.summary && !hit.summary) hit.summary = site.summary;
    if (site.summary && !hit.job_summary) hit.job_summary = site.summary;
    if (site.location && !hit.locality) {
      hit.locality = /gurgaon/i.test(site.location) ? "gurugram" : site.location;
      if (/gurugram|gurgaon/i.test(site.location)) hit.region = "haryana";
    }
    if (site.phone && !hit.mobile_phone) {
      hit.mobile_phone = site.phone;
      if (!hit.phone_numbers.includes(site.phone)) hit.phone_numbers.unshift(site.phone);
    }
    sources.push("employer-site");
  }

  const blobParts: string[] = [];
  if (!input.company && !input.linkedinSlug) {
    const unpanUrl = `https://unpan.org/name/${slug}`;
    try {
      const page = await resilientFetch(unpanUrl, { timeoutMs: 8000, maxAttempts: 3, preferBot: true });
      if (page.ok && page.body.length > 2000 && !/just a moment|attention required/i.test(page.body.slice(0, 400))) {
        const text = page.body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
        blobParts.push(text.slice(0, 15000));
        sources.push("unpan");
      }
    } catch {
      /* */
    }
  }
  for (const row of pages.flat()) {
    const url = (row.link ?? "").split("?")[0] ?? "";
    const title = row.title ?? "";
    const desc = row.description ?? "";
    if (input.linkedinSlug) {
      const s = input.linkedinSlug.toLowerCase();
      if (!url.toLowerCase().includes(s) && !`${title} ${desc}`.toLowerCase().includes(s))
        continue;
    }
    if (!selfRow(title, url, input.fullName, input.company, desc))
      continue;
    blobParts.push(`${title} ${desc}`);
    if (/unpan\.org|thatsthem\.com|fastpeoplesearch\.com\/name|truepeoplesearch\.com\/results|rocketreach\.co/i.test(url)) {
      try {
        const page = await resilientFetch(url, { timeoutMs: 8000, maxAttempts: 1 });
        if (page.ok && page.body.length > 2000 && !/just a moment|attention required/i.test(page.body)) {
          const text = page.body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
          blobParts.push(text.slice(0, 12000));
          sources.push(new URL(url).hostname.replace(/^www\./, ""));
        }
      } catch {
        /* */
      }
    }
    if (!hit.facebook_url && /facebook\.com\/(people\/|profile\.php|[A-Za-z0-9.]+)\/?$/i.test(url) && !/\/posts\//i.test(url)) {
      hit.facebook_url = url;
      const id = url.match(/id=(\d+)/)?.[1] ?? url.match(/facebook\.com\/people\/[^/]+\/(\d+)/)?.[1];
      if (id) hit.facebook_id = id;
      sources.push("facebook-serp");
    }
  }
  const blob = blobParts.join(" \n ");
  const birth = parseBirth(blob);
  if (birth.year) {
    hit.birth_year = birth.year;
    hit.birth_date = birth.date;
    sources.push("public-records");
  }
  const street = parseStreet(blob);
  if (street.street && !/gurugram|gurgaon|haryana|\bindia\b/i.test(blob)) {
    hit.street_address = street.street;
    hit.locality = street.city;
    hit.region = street.region;
    hit.postal_code = street.postal;
  }
  const inCity = blob.match(/\b(Gurugram|Gurgaon|Noida|Bengaluru|Bangalore|Mumbai|Hyderabad|Pune|Chennai|Delhi)\b/i);
  if (inCity && /\.in$|india/i.test(input.domain ?? "")) {
    hit.locality = /gurgaon/i.test(inCity[1]!) ? "gurugram" : inCity[1]!.toLowerCase();
    if (/gurugram|gurgaon/i.test(inCity[1]!)) hit.region = "haryana";
  }
  const appt = blob.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s*,?\s*(20\d{2})/i);
  if (appt && /director|appointment|warewe/i.test(blob)) {
    const mo = MONTH[appt[2]!.toLowerCase()];
    if (mo) hit.job_start_date = `${appt[3]}-${mo}-${appt[1]!.padStart(2, "0")}`;
  }
  const preferIn = /\.in$|\.au$|india|australia|gurugram|gurgaon|sydney/i.test(
    `${input.domain ?? ""} ${input.company ?? ""} ${blob}`,
  );
  const phones = (input.company || input.domain) ? phonesIn(blob, preferIn) : [];
  if (phones.length) {
    hit.phone_numbers = phones.slice(0, 6);
    hit.mobile_phone = phones[0] ?? null;
  }
  const personal = emailsIn(blob, input.fullName).filter((e) => /gmail|yahoo|aol|hotmail|icloud|outlook|msn/.test(e));
  hit.personal_emails = personal.slice(0, 5);
  const mask = blob.toLowerCase().match(/\b([a-z])[•*x]{3,}@\s*([a-z0-9 .\-]+)/);
  if (mask && input.domain && mask[2]!.replace(/\s+/g, "").includes(input.domain.replace(/^www\./, ""))) {
    const start = mask[1]!;
    const last = input.fullName.split(/\s+/).pop()!.toLowerCase();
    const first = input.first.toLowerCase();
    if (last.startsWith(start)) hit.email_hint = `${last}@${input.domain}`;
    else if (first.startsWith(start)) hit.email_hint = `${first}@${input.domain}`;
  }
  if (!hit.email_hint && input.domain) {
    const dom = input.domain.replace(/^www\./, "").toLowerCase();
    const first = input.first.toLowerCase();
    const last = input.fullName.split(/\s+/).pop()!.toLowerCase();
    const companyMails = [...new Set((blob.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) ?? []).map((e) => e.toLowerCase()))]
      .filter((e) => e.endsWith(`@${dom}`));
    const prefer =
      companyMails.find((e) => e.split("@")[0] === first) ||
      companyMails.find((e) => e.split("@")[0] === last) ||
      companyMails.find((e) => (e.split("@")[0] ?? "").includes(first));
    if (prefer) hit.email_hint = prefer;
  }
  const firstTok = input.first.toLowerCase();
  for (const m of blob.toLowerCase().matchAll(/\b([a-z])[•*x]{3,}@\s*([a-z0-9.\-]+\.[a-z]{2,})/g)) {
    const host = m[2]!.replace(/\s+/g, "");
    if (/gmail|yahoo|hotmail|icloud|outlook/.test(host)) continue;
    if (firstTok.startsWith(m[1]!)) {
      const guess = `${firstTok}@${host}`;
      if (!hit.alt_emails.includes(guess) && guess !== hit.email_hint) hit.alt_emails.push(guess);
    }
  }
  if (!hit.company_founded) {
    const fy = blob.match(/founded(?:\s+in)?\s+(20\d{2}|19\d{2})/i)?.[1];
    if (fy) hit.company_founded = Number(fy);
  }
  if (!hit.job_start_date) {
    const start = blob.match(/(?:since|from|joined|co-founded|founded)\s+(20\d{2})/i)?.[1]
      ?? blob.match(/\b(20\d{2})\s*[–-]\s*(?:now|present|current)/i)?.[1];
    if (start) hit.job_start_date = `${start}-01`;
  }
  if (!hit.industry) {
    hit.industry = industryFromText(blob) ?? hit.company_industry;
  }
  return hit;
}
