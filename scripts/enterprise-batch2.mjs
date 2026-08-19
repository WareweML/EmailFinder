import { findEmail } from "../src/lib/email-finder/pipeline.ts";
import { verifyEmail } from "../src/lib/email-finder/verify.ts";
import { lookupMx } from "../src/lib/email-finder/dns.ts";
import fs from "fs";

const CASES = [
  { domain: "ghd.com", people: ["Peter Booth"] },
  { domain: "aidacare.com.au", people: ["Greg Parker", "Mark Smith"] },
  { domain: "shopify.com", people: ["Tobi Lutke"] },
  { domain: "atlassian.com", people: ["Mike Cannon-Brookes"] },
];

// stripe already known
const prior = [
  {
    domain: "stripe.com",
    person: "Patrick Collison",
    mg: "patrick@stripe.com",
    status: "catch_all",
    conf: 99,
    smtp: "catch_all",
  },
  {
    domain: "stripe.com",
    person: "John Collison",
    mg: "john@stripe.com",
    status: "catch_all",
    conf: 99,
    smtp: "catch_all",
  },
];

const rows = [...prior];

async function hunterApi(first, last, domain) {
  const key = process.env.HUNTER_API_KEY;
  const url = `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}${key ? `&api_key=${key}` : ""}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const j = await res.json();
    return {
      status: res.status,
      email: j?.data?.email ?? null,
      score: j?.data?.score ?? null,
      err: j?.errors?.[0]?.details,
    };
  } catch (e) {
    return { status: 0, err: e.message };
  }
}

for (const c of CASES) {
  console.log("\n===", c.domain, "===");
  const mx = await lookupMx(c.domain);
  console.log("MX", mx.provider);

  // one catch-all probe
  const probe = await verifyEmail(`zzzznotreal12345@${c.domain}`, {
    skipSmtp: false,
  });
  console.log("catch-all probe", probe.status, "isCatchAll", probe.isCatchAll);

  for (const fullName of c.people) {
    const parts = fullName.split(/\s+/);
    const first = parts[0];
    const last = parts.slice(1).join(" ");
    console.log("-", fullName);
    let mg = null;
    try {
      const t0 = Date.now();
      const found = await findEmail({
        fullName,
        domain: c.domain,
        skipSmtp: false,
      });
      mg = {
        email: found.best?.email,
        status: found.best?.status,
        conf: found.best?.confidence,
        ms: Date.now() - t0,
      };
      console.log("  MG", mg.email, mg.status, mg.conf, mg.ms + "ms");
    } catch (e) {
      mg = { error: e.message };
      console.log("  MG err", e.message);
    }

    const h = await hunterApi(first, last, c.domain);
    console.log("  Hunter", h.status, h.email || h.err);

    // verify mg best only + first.last pattern
    const smtp = {};
    if (mg?.email) {
      const v = await verifyEmail(mg.email, { skipSmtp: false });
      smtp[mg.email] = { status: v.status, catchAll: v.isCatchAll };
      console.log("  SMTP best", mg.email, v.status, v.isCatchAll ? "CA" : "");
    }
    const fl = `${first.toLowerCase().replace(/[^a-z]/g, "")}.${last.toLowerCase().replace(/[^a-z\-]/g, "")}@${c.domain}`;
    if (!smtp[fl]) {
      const v = await verifyEmail(fl, { skipSmtp: false });
      smtp[fl] = { status: v.status, catchAll: v.isCatchAll };
      console.log("  SMTP fl", fl, v.status, v.isCatchAll ? "CA" : "");
    }

    rows.push({
      domain: c.domain,
      mx: mx.provider,
      person: fullName,
      catchAllProbe: probe.isCatchAll || probe.status === "catch_all" || probe.status === "valid" && probe.isCatchAll,
      catchAllDetail: { status: probe.status, isCatchAll: probe.isCatchAll },
      mailgraph: mg,
      hunter: h,
      smtp,
    });
  }
}

const summary = rows.map((r) => {
  const email = r.mailgraph?.email || r.mg;
  const st = r.mailgraph?.status || r.status;
  const smtpSt = email ? r.smtp?.[email]?.status : r.smtp;
  return {
    domain: r.domain,
    person: r.person,
    mailgraph: email,
    mgStatus: st,
    hunterEmail: r.hunter?.email ?? null,
    hunterHttp: r.hunter?.status ?? null,
    catchAllDomain: r.catchAllProbe ?? (r.smtp === "catch_all"),
    verdict:
      st === "catch_all" || r.smtp === "catch_all"
        ? "catch_all_detected"
        : smtpSt === "valid" || st === "valid"
          ? "claimed_valid"
          : st || "none",
  };
});

const out = { rows, summary, clay: "no free public API", hunter: "API 401 without key" };
fs.writeFileSync("/workspace/data/enterprise-compare.json", JSON.stringify(out, null, 2));
console.log("\nSUMMARY\n", JSON.stringify(summary, null, 2));
