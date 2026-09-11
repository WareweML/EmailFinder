import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { findPerson } from "../src/lib/email-finder/person-find";
import { findCompany } from "../src/lib/email-finder/company-find";
import { companyOnCard, decodoSearch } from "../src/lib/email-finder/decodo-serp";

type PersonRow = {
  fullName: string;
  domain: string;
  company: string;
  hunterEmail: string | null;
  hunterLi: string | null;
  hunterTitle: string | null;
  hunterSeniority: string | null;
  decision_maker?: boolean;
};

const DM_RE =
  /\b(ceo|cto|cfo|coo|cmo|chief|founder|co-founder|cofounder|president|vp|vice president|head of|director|partner|owner|managing|principal|chair)\b/i;

function slugOf(url?: string | null): string | null {
  const m = (url ?? "").match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]!).replace(/\/+$/, "").toLowerCase() : null;
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

async function liCardOk(url: string | null, name: string, company: string, domain: string) {
  if (!url) return { ok: false, title: "" };
  const slug = slugOf(url);
  if (!slug || slug.includes("_") || slug.includes("activity-")) return { ok: false, title: "post-url" };
  const rows = await decodoSearch(`site:linkedin.com/in/${slug}`);
  const blob = rows.map((r) => `${r.title ?? ""} ${r.description ?? ""}`).join(" ");
  const title = rows[0]?.title ?? "";
  const nameOk = name.split(/\s+/).every((t) => t.length < 3 || new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(blob + title));
  return { ok: nameOk && companyOnCard(`${title} ${blob}`, company, domain), title };
}

async function hunterCompany(domain: string) {
  try {
    const res = await fetch(
      `https://api.hunter.io/v2/companies/find?domain=${encodeURIComponent(domain)}&api_key=${process.env.HUNTER_API_KEY || ""}`,
      { signal: AbortSignal.timeout(12_000) },
    );
    return (await res.json()) as { data?: Record<string, unknown> };
  } catch {
    return { data: undefined };
  }
}

async function main() {
  const gold = JSON.parse(readFileSync("/tmp/hunter-gold.json", "utf8")) as PersonRow[];
  const done = new Set(
    readFileSync("/tmp/enrich-accuracy-100.jsonl", "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const r = JSON.parse(l);
        return `${r.name}|${r.domain}`;
      }),
  );
  const dm = gold.filter(
    (r) => r.decision_maker || DM_RE.test(r.hunterTitle ?? "") || /executive|director|founder/i.test(r.hunterSeniority ?? ""),
  );
  const rest = gold.filter((r) => !dm.includes(r));
  const ordered = [...dm, ...rest];
  const need: PersonRow[] = [];
  const seen = new Set<string>();
  for (const r of ordered) {
    const k = `${r.fullName}|${r.domain}`;
    if (seen.has(k) || done.has(k)) continue;
    seen.add(k);
    need.push(r);
    if (done.size + need.length >= 100) break;
  }
  console.log("resume remaining", need.length, "already", done.size);

  await mapPool(need, 5, async (row, i) => {
    console.log(`  ${i + 1}/${need.length} ${row.fullName} @ ${row.domain}`);
    const ours = await findPerson({ fullName: row.fullName, domain: row.domain, company: row.company });
    const d = ours.data;
    const ourLi = d.linkedin_url;
    const ourEmail = d.work_email;
    const ourSlug = slugOf(ourLi);
    const hSlug = slugOf(row.hunterLi);
    let li: string = "miss";
    const notes: string[] = [];
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
    let email = "miss";
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
      const belongs = local.includes(first) || local.includes(last) || local === first;
      email = belongs ? "plausible" : "wrong";
      if (!belongs) notes.push(`email local !name ${oe}`);
    }
    const s = {
      name: row.fullName,
      domain: row.domain,
      hunterEmail: row.hunterEmail,
      hunterLi: row.hunterLi,
      ourEmail,
      ourLi,
      ourTitle: d.job_title,
      li,
      email,
      identityFail: li === "wrong" || email === "wrong",
      notes,
    };
    appendFileSync("/tmp/enrich-accuracy-100.jsonl", JSON.stringify(s) + "\n");
    return s;
  });

  const scores = readFileSync("/tmp/enrich-accuracy-100.jsonl", "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const n = scores.length;
  const summary = {
    n,
    li: scores.reduce((a: Record<string, number>, s: { li: string }) => ((a[s.li] = (a[s.li] ?? 0) + 1), a), {}),
    email: scores.reduce((a: Record<string, number>, s: { email: string }) => ((a[s.email] = (a[s.email] ?? 0) + 1), a), {}),
    identityFail: scores.filter((s: { identityFail: boolean }) => s.identityFail).length,
    wrongLi: scores.filter((s: { li: string }) => s.li === "wrong"),
    wrongEmail: scores.filter((s: { email: string }) => s.email === "wrong"),
  };
  console.log("PERSON", JSON.stringify({ n: summary.n, li: summary.li, email: summary.email, identityFail: summary.identityFail }, null, 2));

  const domains = [...new Set(scores.map((s: { domain: string }) => s.domain))].slice(0, 8) as string[];
  const co = await mapPool(domains, 3, async (domain) => {
    const [ours, hunter] = await Promise.all([findCompany(domain), hunterCompany(domain)]);
    const hd = hunter.data ?? {};
    const hName = String(hd.name ?? hd.legalName ?? "");
    const name = ours.data.name;
    const nameOk =
      !hName ||
      name.toLowerCase().includes(hName.toLowerCase().slice(0, 6)) ||
      hName.toLowerCase().includes(name.toLowerCase().slice(0, 6));
    return { domain, ourName: name, hunterName: hName, domainOk: ours.data.domain === domain, nameOk, employees: ours.data.metrics.employeesExact };
  });
  writeFileSync("/tmp/enrich-accuracy-100.json", JSON.stringify({ summary, sample: scores, companies: co }, null, 2));
  console.log("COMPANY", JSON.stringify(co, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
