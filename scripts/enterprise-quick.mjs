import { generateCandidates } from "../src/lib/email-finder/candidates.ts";
import { parseFullName } from "../src/lib/email-finder/normalize.ts";
import { verifyEmail } from "../src/lib/email-finder/verify.ts";
import { lookupMx } from "../src/lib/email-finder/dns.ts";
import fs from "fs";

const CASES = [
  { domain: "stripe.com", people: ["Patrick Collison", "John Collison"] },
  { domain: "ghd.com", people: ["Peter Booth"] },
  { domain: "aidacare.com.au", people: ["Greg Parker"] },
  { domain: "shopify.com", people: ["Tobi Lutke"] },
  { domain: "atlassian.com", people: ["Mike Cannon-Brookes"] },
];

async function catchAllTest(domain) {
  const fake = `noone-xyz-${Date.now().toString(36)}@${domain}`;
  const v = await verifyEmail(fake, { skipSmtp: false });
  return {
    status: v.status,
    isCatchAll: v.isCatchAll === true || v.status === "catch_all",
    mx: v.mxProvider,
  };
}

async function quickFind(fullName, domain, isCatchAll) {
  const name = parseFullName(fullName);
  const cands = generateCandidates(name, domain).slice(0, 4);
  if (isCatchAll) {
    return {
      best: {
        email: cands[0]?.email ?? null,
        status: "catch_all",
        confidence: 40,
        note: "Catch-all MX — RCPT cannot prove mailbox",
      },
      checked: cands.map((c) => ({ email: c.email, status: "catch_all" })),
    };
  }
  const checked = [];
  for (const c of cands) {
    const v = await verifyEmail(c.email, { skipSmtp: false });
    checked.push({
      email: c.email,
      pattern: c.patternId,
      status: v.status,
      catchAll: v.isCatchAll,
    });
    if (v.status === "valid" && !v.isCatchAll) {
      return {
        best: {
          email: c.email,
          status: "valid",
          confidence: 92,
          pattern: c.patternId,
        },
        checked,
      };
    }
  }
  const any = checked.find((r) => r.status === "valid");
  return {
    best: any
      ? { email: any.email, status: "valid", confidence: 70 }
      : {
          email: cands[0]?.email ?? null,
          status: checked[0]?.status ?? "unknown",
          confidence: 15,
        },
    checked,
  };
}

async function hunter(first, last, domain) {
  try {
    const res = await fetch(
      `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}`,
      { signal: AbortSignal.timeout(10000) },
    );
    const j = await res.json();
    return {
      http: res.status,
      email: j?.data?.email ?? null,
      score: j?.data?.score ?? null,
      detail: j?.errors?.[0]?.details ?? null,
    };
  } catch (e) {
    return { http: 0, detail: e.message };
  }
}

const out = {
  ranAt: new Date().toISOString(),
  clayFreePublicApi: false,
  clayNote:
    "Clay has no free public email-finder REST API. Endpoints return 404 deprecated; product is paid/auth workspace.",
  hunterFreePublicApi: "Requires API key (401 without). Free tier only after signup.",
  cases: [],
};

for (const c of CASES) {
  console.log("\n##", c.domain);
  const mx = await lookupMx(c.domain);
  const ca = await catchAllTest(c.domain);
  console.log("MX", mx.provider, "catchAll", ca.isCatchAll);
  const domainCase = {
    domain: c.domain,
    mx: mx.provider,
    catchAll: ca.isCatchAll,
    people: [],
  };

  for (const fullName of c.people) {
    const parts = fullName.split(/\s+/);
    const first = parts[0];
    const last = parts.slice(1).join(" ");
    process.stdout.write(`  ${fullName} ... `);
    const mg = await quickFind(fullName, c.domain, ca.isCatchAll);
    const h = await hunter(first, last, c.domain);
    console.log(
      `MG=${mg.best.email}(${mg.best.status}) | Hunter=${h.http} ${h.email || h.detail}`,
    );
    domainCase.people.push({ fullName, mailgraph: mg, hunter: h });
  }
  out.cases.push(domainCase);
}

// Score
let correct = 0;
let total = 0;
for (const c of out.cases) {
  for (const p of c.people) {
    total++;
    if (c.catchAll && p.mailgraph.best.status === "catch_all") correct++;
    else if (!c.catchAll && p.mailgraph.best.status === "valid") correct++;
  }
}
out.score = {
  total,
  mailgraphCorrectHandling: correct,
  rate: total ? Math.round((correct / total) * 100) : 0,
  hunterApiSuccesses: out.cases
    .flatMap((c) => c.people)
    .filter((p) => p.hunter.http === 200).length,
};

fs.writeFileSync("/workspace/data/enterprise-compare.json", JSON.stringify(out, null, 2));
console.log("\nSCORE", out.score);
