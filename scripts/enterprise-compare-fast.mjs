/**
 * Faster bakeoff: name-find + SMTP only, skip full domain crawl.
 * Hunter free API (no key = 401), Clay (no free public API).
 */
import { findEmail } from "../src/lib/email-finder/pipeline.ts";
import { verifyEmail } from "../src/lib/email-finder/verify.ts";
import { resilientFetch } from "../src/lib/email-finder/http.ts";
import { lookupMx } from "../src/lib/email-finder/dns.ts";
import fs from "fs";

const CASES = [
  { domain: "stripe.com", people: ["Patrick Collison", "John Collison"] },
  { domain: "ghd.com", people: ["Peter Booth", "Cindy Ruckman"] },
  {
    domain: "aidacare.com.au",
    people: ["Mark Smith", "Greg Parker"],
  },
  // add a few more "random" enterprise-ish public execs
  { domain: "shopify.com", people: ["Tobi Lutke", "Harley Finkelstein"] },
  { domain: "atlassian.com", people: ["Mike Cannon-Brookes", "Scott Farquhar"] },
];

function splitName(full) {
  const parts = full.trim().split(/\s+/);
  const first = parts[0] || "";
  const last = parts.slice(1).join(" ") || "";
  return { first, last };
}

async function hunterWebDomain(domain) {
  try {
    const page = await resilientFetch(`https://hunter.io/search/${domain}`, {
      timeoutMs: 12000,
      maxAttempts: 2,
    });
    const re = new RegExp(
      `[a-zA-Z0-9._%+\\-]+@${domain.replace(/\./g, "\\.")}`,
      "gi",
    );
    const emails = [...new Set((page.body.match(re) || []).map((e) => e.toLowerCase()))];
    return { status: page.status, emails: emails.slice(0, 20), len: page.body.length };
  } catch (e) {
    return { error: e.message };
  }
}

async function hunterApiFinder(first, last, domain) {
  const key = process.env.HUNTER_API_KEY;
  const q = `domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}`;
  const url = key
    ? `https://api.hunter.io/v2/email-finder?${q}&api_key=${key}`
    : `https://api.hunter.io/v2/email-finder?${q}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    return {
      status: res.status,
      email: json?.data?.email ?? null,
      score: json?.data?.score ?? null,
      position: json?.data?.position ?? null,
      sources: json?.data?.sources?.length ?? 0,
      error: json?.errors?.[0]?.details ?? null,
      hasKey: Boolean(key),
    };
  } catch (e) {
    return { status: 0, error: e.message, hasKey: Boolean(key) };
  }
}

// Clay free public?
async function clayStatus() {
  const probes = [
    ["GET", "https://api.clay.com/v1/health"],
    ["POST", "https://api.clay.com/v1/find-email"],
    ["GET", "https://api.open.clay.com/v1"],
  ];
  const out = [];
  for (const [method, url] of probes) {
    try {
      const res = await fetch(url, {
        method,
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify({ domain: "stripe.com", full_name: "Patrick Collison" }) : undefined,
        signal: AbortSignal.timeout(8000),
      });
      out.push({ url, status: res.status, body: (await res.text()).slice(0, 120) });
    } catch (e) {
      out.push({ url, error: e.message });
    }
  }
  return out;
}

const report = {
  ranAt: new Date().toISOString(),
  clay: {
    freePublicApi: false,
    note: "Clay does not offer a free public email-finder REST API. Product is auth-gated workspace + paid provider waterfall.",
    probes: await clayStatus(),
  },
  hunter: {
    freePublicApi: "API requires key (401 without). Free tier exists with key signup. Web /search/{domain} may show limited HTML.",
  },
  rows: [],
};

console.log("Clay probes:", JSON.stringify(report.clay.probes, null, 2));

for (const c of CASES) {
  console.log("\n===", c.domain, "===");
  const mx = await lookupMx(c.domain);
  console.log("MX", mx.provider, "hasMx", mx.hasMx);

  const hunterDom = await hunterWebDomain(c.domain);
  console.log("Hunter web emails", hunterDom.emails || hunterDom.error);

  for (const fullName of c.people) {
    const { first, last } = splitName(fullName);
    console.log("\n-", fullName);

    // Mailgraph
    let mg = null;
    try {
      const t0 = Date.now();
      const found = await findEmail({
        fullName,
        domain: c.domain,
        skipSmtp: false,
      });
      mg = {
        email: found.best?.email ?? null,
        confidence: found.best?.confidence ?? null,
        status: found.best?.status ?? null,
        pattern: found.best?.patternId ?? found.best?.patternLabel ?? null,
        ms: Date.now() - t0,
        alts: (found.alternatives || []).slice(0, 4).map((a) => a.email),
      };
      console.log("  MG", mg.email, mg.status, mg.confidence, `${mg.ms}ms`);
    } catch (e) {
      mg = { error: e.message };
      console.log("  MG err", e.message);
    }

    // Hunter API
    const hApi = await hunterApiFinder(first, last, c.domain);
    console.log("  Hunter API", hApi.status, hApi.email || hApi.error);

    // SMTP batch: mg best + common patterns
    const f = first.toLowerCase().replace(/[^a-z\-]/g, "");
    const l = last.toLowerCase().replace(/[^a-z\-]/g, "");
    const locals = [
      mg?.email,
      hApi.email,
      `${f}@${c.domain}`,
      `${l}@${c.domain}`,
      `${f}.${l}@${c.domain}`,
      `${f}${l}@${c.domain}`,
      `${f[0]}${l}@${c.domain}`,
    ].filter(Boolean);
    const uniq = [...new Set(locals)].slice(0, 7);
    const smtp = {};
    let catchAll = false;
    for (const email of uniq) {
      const v = await verifyEmail(email, { skipSmtp: false });
      smtp[email] = { status: v.status, catchAll: v.isCatchAll };
      if (v.isCatchAll) catchAll = true;
      console.log("  SMTP", email, v.status, v.isCatchAll ? "CATCH-ALL" : "");
    }

    const mgOk =
      mg?.email &&
      smtp[mg.email]?.status === "valid" &&
      !smtp[mg.email]?.catchAll;
    const mgCatchAll =
      mg?.email && smtp[mg.email]?.catchAll === true;
    const anyHardValid = Object.entries(smtp).filter(
      ([, v]) => v.status === "valid" && !v.catchAll,
    );

    report.rows.push({
      domain: c.domain,
      mx: mx.provider,
      person: fullName,
      mailgraph: mg,
      hunterApi: hApi,
      hunterWebEmails: hunterDom.emails || [],
      smtp,
      catchAllDomain: catchAll,
      mailgraphHardValid: mgOk,
      mailgraphCatchAllOnly: mgCatchAll,
      hardValidMailboxes: anyHardValid.map(([e]) => e),
    });
  }
}

// Aggregate accuracy
const scored = report.rows.map((r) => {
  // Accuracy definition:
  // - If domain is catch-all: confidence must be capped / status catch_all (not claim "valid person")
  // - If not catch-all: best email must be SMTP valid
  let verdict = "unknown";
  if (r.catchAllDomain) {
    verdict =
      r.mailgraph?.status === "catch_all" || r.mailgraphCatchAllOnly
        ? "correct_catch_all_handling"
        : r.mailgraphHardValid
          ? "overconfident_on_catch_all"
          : "catch_all_no_hard_valid";
  } else if (r.mailgraphHardValid) {
    verdict = "correct_valid";
  } else if (r.mailgraph?.email && r.smtp[r.mailgraph.email]?.status === "invalid") {
    verdict = "wrong_invalid";
  } else {
    verdict = "no_confident_valid";
  }
  return {
    domain: r.domain,
    person: r.person,
    mg: r.mailgraph?.email,
    mgStatus: r.mailgraph?.status,
    hunter: r.hunterApi?.email,
    hunterStatus: r.hunterApi?.status,
    verdict,
    hardValid: r.hardValidMailboxes,
  };
});

report.scored = scored;
report.totals = {
  people: scored.length,
  mailgraphCorrectValid: scored.filter((s) => s.verdict === "correct_valid").length,
  mailgraphCorrectCatchAll: scored.filter((s) => s.verdict === "correct_catch_all_handling").length,
  mailgraphWrong: scored.filter((s) => s.verdict === "wrong_invalid" || s.verdict === "overconfident_on_catch_all").length,
  hunterApiWorking: scored.filter((s) => s.hunterStatus === 200).length,
  hunterApiBlocked: scored.filter((s) => s.hunterStatus === 401).length,
};

fs.writeFileSync(
  "/workspace/data/enterprise-compare.json",
  JSON.stringify(report, null, 2),
);
console.log("\n===== SCORED =====");
console.log(JSON.stringify(scored, null, 2));
console.log("\nTOTALS", report.totals);
