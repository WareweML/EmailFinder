/**
 * 100 decision-maker bake-off: our person/company enrich vs Hunter + LinkedIn card.
 * Wrong person/email = fail. Honest null = miss, not a fail.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { findPerson } from "../src/lib/email-finder/person-find";
import { findCompany } from "../src/lib/email-finder/company-find";
import { companyOnCard, decodoSearch } from "../src/lib/email-finder/decodo-serp";

const HUNTER = process.env.HUNTER_API_KEY || "";

const DOMAINS = [
  "stripe.com",
  "shopify.com",
  "atlassian.com",
  "canva.com",
  "ghd.com",
  "partner2simplify.com.au",
  "warewe.com",
  "kubex.ai",
  "hubspot.com",
  "notion.so",
  "figma.com",
  "airbnb.com",
  "dropbox.com",
  "asana.com",
  "intercom.com",
  "twilio.com",
  "zoom.us",
  "adobe.com",
  "salesforce.com",
  "nvidia.com",
  "shopify.com",
  "gitlab.com",
  "cloudflare.com",
  "datadog.com",
  "okta.com",
];

const DM_RE =
  /\b(ceo|cto|cfo|coo|cmo|chief|founder|co-founder|cofounder|president|vp|vice president|head of|director|partner|owner|managing|principal|chair)\b/i;

type HunterEmail = {
  value?: string;
  first_name?: string;
  last_name?: string;
  position?: string;
  seniority?: string;
  linkedin?: string;
  verification?: { status?: string };
  department?: string;
  confidence?: number;
};

type PersonRow = {
  fullName: string;
  domain: string;
  company: string;
  hunterEmail: string | null;
  hunterLi: string | null;
  hunterTitle: string | null;
  hunterSeniority: string | null;
};

function slugOf(url?: string | null): string | null {
  const m = (url ?? "").match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]!).replace(/\/+$/, "").toLowerCase() : null;
}

function isDm(e: HunterEmail): boolean {
  if (DM_RE.test(e.position ?? "")) return true;
  if (/executive|director|founder/i.test(e.seniority ?? "")) return true;
  return false;
}

async function hunterDomain(domain: string): Promise<{
  org: string | null;
  pattern: string | null;
  emails: HunterEmail[];
  company: Record<string, unknown> | null;
}> {
  try {
    const res = await fetch(
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=20&api_key=${HUNTER}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const j = (await res.json()) as {
      data?: { organization?: string; pattern?: string; emails?: HunterEmail[] };
    };
    return {
      org: j.data?.organization ?? null,
      pattern: j.data?.pattern ?? null,
      emails: j.data?.emails ?? [],
      company: (j.data as Record<string, unknown>) ?? null,
    };
  } catch {
    return { org: null, pattern: null, emails: [], company: null };
  }
}

async function hunterCompany(domain: string) {
  try {
    const res = await fetch(
      `https://api.hunter.io/v2/companies/find?domain=${encodeURIComponent(domain)}&api_key=${HUNTER}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    return (await res.json()) as { data?: Record<string, unknown> };
  } catch {
    return { data: undefined };
  }
}

async function hunterFinder(first: string, last: string, domain: string) {
  try {
    const res = await fetch(
      `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}&api_key=${HUNTER}`,
      { signal: AbortSignal.timeout(12_000) },
    );
    const j = (await res.json()) as { data?: { email?: string | null; linkedin_url?: string | null; position?: string | null; score?: number | null } };
    return j.data ?? {};
  } catch {
    return {};
  }
}

function pool(rows: PersonRow[], n = 100): PersonRow[] {
  const dm = rows.filter(
    (r) =>
      Boolean((r as { decision_maker?: boolean }).decision_maker) ||
      DM_RE.test(r.hunterTitle ?? "") ||
      /executive|director|founder/i.test(r.hunterSeniority ?? ""),
  );
  const rest = rows.filter((r) => !dm.includes(r));
  const out = [...dm, ...rest];
  const seen = new Set<string>();
  const uniq: PersonRow[] = [];
  for (const r of out) {
    const k = `${r.fullName.toLowerCase()}|${r.domain}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(r);
    if (uniq.length >= n) break;
  }
  return uniq;
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]!, idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

async function liCardOk(url: string | null, name: string, company: string, domain: string): Promise<{ ok: boolean; title: string; blob: string }> {
  if (!url) return { ok: false, title: "", blob: "" };
  const slug = slugOf(url);
  if (!slug) return { ok: false, title: "", blob: "" };
  const rows = await decodoSearch(`site:linkedin.com/in/${slug}`);
  const blob = rows.map((r) => `${r.title ?? ""} ${r.description ?? ""}`).join(" ");
  const title = rows[0]?.title ?? "";
  const nameOk = name.split(/\s+/).every((t) => t.length < 3 || new RegExp(t, "i").test(blob + title));
  return { ok: nameOk && companyOnCard(`${title} ${blob}`, company, domain), title, blob: blob.slice(0, 240) };
}

type PersonScore = {
  name: string;
  domain: string;
  hunterEmail: string | null;
  hunterLi: string | null;
  ourEmail: string | null;
  ourLi: string | null;
  ourTitle: string | null;
  li: "match" | "ours-ok" | "wrong" | "miss" | "hunter-unverified";
  email: "match" | "plausible" | "wrong" | "miss";
  identityFail: boolean;
  notes: string[];
};

async function scorePerson(row: PersonRow): Promise<PersonScore> {
  const notes: string[] = [];
  const ours = await findPerson({ fullName: row.fullName, domain: row.domain, company: row.company });
  const d = ours.data;
  const ourLi = d.linkedin_url;
  const ourEmail = d.work_email;
  const ourTitle = d.job_title;
  const ourSlug = slugOf(ourLi);
  const hSlug = slugOf(row.hunterLi);

  let li: PersonScore["li"] = "miss";
  if (ourSlug && hSlug && ourSlug === hSlug) li = "match";
  else if (ourLi) {
    const card = await liCardOk(ourLi, row.fullName, row.company, row.domain);
    if (card.ok) li = "ours-ok";
    else {
      li = "wrong";
      notes.push(`LI card fail: ${card.title || ourLi}`);
    }
  } else if (row.hunterLi) {
    const hCard = await liCardOk(row.hunterLi, row.fullName, row.company, row.domain);
    li = hCard.ok ? "miss" : "hunter-unverified";
  }

  let email: PersonScore["email"] = "miss";
  const he = (row.hunterEmail ?? "").toLowerCase();
  const oe = (ourEmail ?? "").toLowerCase();
  const first = row.fullName.split(/\s+/)[0]?.toLowerCase() ?? "";
  const last = row.fullName.split(/\s+/).pop()?.toLowerCase() ?? "";
  if (!oe) email = "miss";
  else if (he && oe === he) email = "match";
  else if (!oe.endsWith(`@${row.domain}`)) {
    email = "wrong";
    notes.push(`email off-domain ${oe}`);
  } else {
    const local = oe.split("@")[0] ?? "";
    const belongs = local.includes(first) || local.includes(last) || local === first[0] + last || local === first;
    if (!belongs) {
      email = "wrong";
      notes.push(`email local !name ${oe}`);
    } else email = "plausible";
  }

  const personalJunk = (d.personal_emails ?? []).filter((e) => !e.includes(first) && !e.includes(last));
  if (personalJunk.length) {
    notes.push(`junk personal ${personalJunk.slice(0, 2).join(",")}`);
  }
  if (ourTitle && /at\s+/i.test(ourTitle) && !companyOnCard(ourTitle, row.company, row.domain)) {
    notes.push(`title other employer ${ourTitle}`);
  }

  const identityFail = li === "wrong" || email === "wrong" || personalJunk.length > 0;
  return {
    name: row.fullName,
    domain: row.domain,
    hunterEmail: row.hunterEmail,
    hunterLi: row.hunterLi,
    ourEmail,
    ourLi,
    ourTitle,
    li,
    email,
    identityFail,
    notes,
  };
}

async function main() {
  console.log("1) load Hunter gold…");
  const people = JSON.parse(readFileSync("/tmp/hunter-gold.json", "utf8")) as PersonRow[];
  console.log("hunter people", people.length);

  let sample = pool(people, 100);
  if (sample.length < 80) {
    // pad with remaining hunter contacts
    sample = pool(people, 100);
  }
  console.log("eval n", sample.length, "dms", sample.filter((s) => DM_RE.test(s.hunterTitle ?? "")).length);

  console.log("2) Person enrich (concurrency 5)…");
  const t0 = Date.now();
  const scores = await mapPool(sample, 5, async (row, i) => {
    if (i % 10 === 0) console.log(`  person ${i + 1}/${sample.length} ${row.fullName} @ ${row.domain}`);
    const s = await scorePerson(row);
    try {
      const { appendFileSync } = await import("node:fs");
      appendFileSync("/tmp/enrich-accuracy-100.jsonl", JSON.stringify(s) + "\n");
    } catch {
      /* */
    }
    return s;
  });
  console.log("person enrich done", Date.now() - t0, "ms");

  const n = scores.length;
  const liWrong = scores.filter((s) => s.li === "wrong");
  const liMatch = scores.filter((s) => s.li === "match" || s.li === "ours-ok");
  const liMiss = scores.filter((s) => s.li === "miss");
  const emWrong = scores.filter((s) => s.email === "wrong");
  const emOk = scores.filter((s) => s.email === "match" || s.email === "plausible");
  const idFail = scores.filter((s) => s.identityFail);

  const personReport = {
    personN: n,
    personMs: Date.now() - t0,
    linkedin: {
      matchOrOk: liMatch.length,
      miss: liMiss.length,
      wrong: liWrong.length,
      hunterUnverified: scores.filter((s) => s.li === "hunter-unverified").length,
      wrongRate: n ? +(liWrong.length / n).toFixed(4) : 0,
    },
    email: {
      ok: emOk.length,
      miss: scores.filter((s) => s.email === "miss").length,
      wrong: emWrong.length,
      wrongRate: n ? +(emWrong.length / n).toFixed(4) : 0,
    },
    identityFail: { n: idFail.length, rate: n ? +(idFail.length / n).toFixed(4) : 0 },
    wrongPeople: liWrong.map((s) => ({ name: s.name, domain: s.domain, hunterLi: s.hunterLi, ourLi: s.ourLi, notes: s.notes })),
    wrongEmails: emWrong.map((s) => ({ name: s.name, domain: s.domain, hunterEmail: s.hunterEmail, ourEmail: s.ourEmail, notes: s.notes })),
  };
  writeFileSync("/tmp/enrich-accuracy-person.json", JSON.stringify({ ...personReport, sample: scores }, null, 2));
  console.log("PERSON SUMMARY", JSON.stringify(personReport, null, 2));

  console.log("3) Company enrich vs Hunter…");
  const uniqueDomains = [...new Set(sample.map((s) => s.domain))];
  const coDomains = uniqueDomains.slice(0, 8);
  const coScores = await mapPool(coDomains, 3, async (domain) => {
    const [ours, hunter] = await Promise.all([findCompany(domain), hunterCompany(domain)]);
    const hd = hunter.data ?? {};
    const name = ours.data.name;
    const hName = (hd.name as string) || (hd.legalName as string) || "";
    const site = ours.data.domain;
    const hSite = ((hd.domain as string) || "").replace(/^www\./, "");
    const domainOk = site === domain;
    const nameOk = !hName || name.toLowerCase().includes(hName.toLowerCase().slice(0, 6)) || hName.toLowerCase().includes(name.toLowerCase().slice(0, 6));
    return {
      domain,
      ourName: name,
      hunterName: hName,
      domainOk,
      nameOk,
      ourHeadcount: ours.data.metrics.employeesExact,
      hunterHeadcount: hd.headcount ?? hd.metrics,
      fail: !domainOk,
    };
  });

  const report = {
    ranAt: new Date().toISOString(),
    personN: n,
    personMs: Date.now() - t0,
    linkedin: {
      matchOrOk: liMatch.length,
      miss: liMiss.length,
      wrong: liWrong.length,
      wrongRate: n ? liWrong.length / n : 0,
    },
    email: {
      ok: emOk.length,
      miss: scores.filter((s) => s.email === "miss").length,
      wrong: emWrong.length,
      wrongRate: n ? emWrong.length / n : 0,
    },
    identityFail: { n: idFail.length, rate: n ? idFail.length / n : 0 },
    company: {
      n: coScores.length,
      domainFail: coScores.filter((c) => c.fail).length,
      nameMismatch: coScores.filter((c) => !c.nameOk).length,
    },
    wrongPeople: liWrong.map((s) => ({ name: s.name, domain: s.domain, hunterLi: s.hunterLi, ourLi: s.ourLi, notes: s.notes })),
    wrongEmails: emWrong.map((s) => ({ name: s.name, domain: s.domain, hunterEmail: s.hunterEmail, ourEmail: s.ourEmail, notes: s.notes })),
    sample: scores,
    companies: coScores,
  };

  writeFileSync("/tmp/enrich-accuracy-100.json", JSON.stringify(report, null, 2));
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify({
    personN: n,
    li: report.linkedin,
    email: report.email,
    identityFail: report.identityFail,
    company: report.company,
    wrongPeople: report.wrongPeople.slice(0, 15),
    wrongEmails: report.wrongEmails.slice(0, 15),
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
