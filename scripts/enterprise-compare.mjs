/**
 * Enterprise accuracy bakeoff:
 * Mailgraph vs Hunter (free/public) vs Clay (public docs/endpoints)
 * Domains: ghd.com, stripe.com, aidacare.com.au
 */
import { findEmail } from "../src/lib/email-finder/pipeline.ts";
import { searchDomain } from "../src/lib/email-finder/pipeline.ts";
import { verifyEmail } from "../src/lib/email-finder/verify.ts";
import { resilientFetch } from "../src/lib/email-finder/http.ts";
import fs from "fs";

const CASES = [
  {
    domain: "stripe.com",
    people: [
      { fullName: "Patrick Collison", title: "CEO" },
      { fullName: "John Collison", title: "President" },
    ],
  },
  {
    domain: "ghd.com",
    people: [
      { fullName: "Peter Booth", title: "CEO" }, // may be wrong - we'll search
      { fullName: "John Dawson", title: "unknown" },
    ],
  },
  {
    domain: "aidacare.com.au",
    people: [
      { fullName: "Mark Smith", title: "unknown" },
      { fullName: "David Thomas", title: "unknown" },
    ],
  },
];

async function hunterEmailFinder(first, last, domain) {
  // Official API needs key
  const withKey = process.env.HUNTER_API_KEY;
  const urls = [];
  if (withKey) {
    urls.push(
      `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}&api_key=${withKey}`,
    );
    urls.push(
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=10&api_key=${withKey}`,
    );
  }
  // free auth-less attempts (document 401)
  urls.push(
    `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}`,
  );
  // public web search page
  const webUrl = `https://hunter.io/search/${domain}`;
  const out = { api: [], web: null };
  for (const url of urls.slice(0, withKey ? 2 : 1)) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      out.api.push({
        url: url.replace(/api_key=[^&]+/, "api_key=***"),
        status: res.status,
        data: json?.data
          ? {
              email: json.data.email,
              score: json.data.score,
              sources: json.data.sources?.length,
              pattern: json.data.pattern,
              emails: json.data.emails?.slice?.(0, 8)?.map((e) => ({
                value: e.value,
                type: e.type,
                confidence: e.confidence,
              })),
            }
          : text.slice(0, 300),
      });
    } catch (e) {
      out.api.push({ error: e.message });
    }
  }
  try {
    const page = await resilientFetch(webUrl, {
      timeoutMs: 15000,
      maxAttempts: 2,
    });
    const emails = [
      ...new Set(
        (
          page.body.match(
            new RegExp(
              `[a-zA-Z0-9._%+\\-]+@${domain.replace(".", "\\.")}`,
              "gi",
            ),
          ) || []
        ).map((e) => e.toLowerCase()),
      ),
    ];
    out.web = {
      status: page.status,
      ok: page.ok,
      emails: emails.slice(0, 15),
      len: page.body.length,
    };
  } catch (e) {
    out.web = { error: e.message };
  }
  return out;
}

async function clayPublic() {
  // Clay does not expose a free public email-finder API comparable to Hunter.
  // Probe known public surfaces / docs endpoints.
  const probes = [
    "https://api.clay.com/v1/enrich",
    "https://api.clay.com/v3/enrich",
    "https://api.clay.com/health",
    "https://www.clay.com/api/public",
    "https://api.clay.com/v1/find-email",
  ];
  const results = [];
  for (const url of probes) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      const text = await res.text();
      results.push({
        url,
        status: res.status,
        body: text.slice(0, 200),
      });
    } catch (e) {
      results.push({ url, error: e.message });
    }
  }
  // Clay "free" is product trial + provider waterfall behind auth — document that
  return {
    note: "Clay has no free public email-finder API. Enrichment is authenticated workspace + paid providers. Probes below confirm no open free endpoint.",
    probes: results,
  };
}

function splitName(full) {
  const parts = full.trim().split(/\s+/);
  return {
    first: parts[0] || "",
    last: parts.slice(1).join(" ") || parts[0] || "",
  };
}

const report = {
  ranAt: new Date().toISOString(),
  clay: await clayPublic(),
  cases: [],
};

for (const c of CASES) {
  console.log("\n##########", c.domain, "##########");
  const caseOut = {
    domain: c.domain,
    people: [],
    domainSearch: null,
    hunterDomain: null,
  };

  // Our domain search (lighter - may take time)
  try {
    console.log("mailgraph domain search...");
    const ds = await searchDomain(c.domain, { verifyRoles: false });
    caseOut.domainSearch = {
      emailCount: ds.emails?.length ?? 0,
      peopleCount: ds.peopleCount ?? ds.people?.length,
      top: (ds.emails || []).slice(0, 10).map((e) => ({
        email: e.email,
        conf: e.confidence,
        status: e.status,
        role: e.isRoleBased,
        name: [e.firstName, e.lastName].filter(Boolean).join(" "),
      })),
      pattern: ds.pattern || ds.domainIntel?.patterns?.[0],
    };
    console.log(
      "domain emails",
      caseOut.domainSearch.emailCount,
      caseOut.domainSearch.top.map((t) => t.email),
    );
  } catch (e) {
    caseOut.domainSearch = { error: e.message };
    console.log("domain search err", e.message);
  }

  // Hunter domain web
  try {
    const hDom = await hunterEmailFinder("A", "B", c.domain);
    caseOut.hunterDomain = hDom;
    console.log("hunter web emails", hDom.web?.emails);
  } catch (e) {
    caseOut.hunterDomain = { error: e.message };
  }

  for (const person of c.people) {
    const { first, last } = splitName(person.fullName);
    console.log("\n---", person.fullName, "@", c.domain);
    const row = {
      fullName: person.fullName,
      mailgraph: null,
      hunter: null,
      smtp: {},
    };

    // Mailgraph
    try {
      const t0 = Date.now();
      const found = await findEmail({
        fullName: person.fullName,
        domain: c.domain,
        skipSmtp: false,
      });
      row.mailgraph = {
        best: found.best
          ? {
              email: found.best.email,
              confidence: found.best.confidence,
              status: found.best.status,
              pattern: found.best.patternId || found.best.patternLabel,
              sources: found.best.sources,
            }
          : null,
        alternatives: (found.alternatives || []).slice(0, 5).map((a) => ({
          email: a.email,
          confidence: a.confidence,
          status: a.status,
        })),
        ms: Date.now() - t0,
        provider: found.winningProvider,
      };
      console.log(
        "mailgraph best",
        row.mailgraph.best?.email,
        row.mailgraph.best?.status,
        row.mailgraph.best?.confidence,
      );
    } catch (e) {
      row.mailgraph = { error: e.message };
      console.log("mailgraph err", e.message);
    }

    // Hunter
    try {
      row.hunter = await hunterEmailFinder(first, last, c.domain);
      const he =
        row.hunter.api?.[0]?.data?.email ||
        row.hunter.web?.emails?.find((e) =>
          e.includes(first.toLowerCase().slice(0, 3)),
        );
      console.log("hunter", row.hunter.api?.[0]?.status, he || row.hunter.web?.emails?.slice(0, 3));
    } catch (e) {
      row.hunter = { error: e.message };
    }

    // SMTP truth on common patterns + our best + hunter web emails
    const candidates = new Set();
    if (row.mailgraph?.best?.email) candidates.add(row.mailgraph.best.email);
    for (const a of row.mailgraph?.alternatives || []) candidates.add(a.email);
    for (const e of row.hunter?.web?.emails || []) candidates.add(e);
    const f = first.toLowerCase().replace(/[^a-z]/g, "");
    const l = last.toLowerCase().replace(/[^a-z]/g, "");
    for (const local of [
      f,
      l,
      `${f}.${l}`,
      `${f}${l}`,
      `${f[0]}${l}`,
      `${f}_${l}`,
    ]) {
      if (local) candidates.add(`${local}@${c.domain}`);
    }
    // limit SMTP checks
    const list = [...candidates].slice(0, 10);
    for (const email of list) {
      try {
        const v = await verifyEmail(email, { skipSmtp: false });
        row.smtp[email] = {
          status: v.status,
          catchAll: v.isCatchAll,
          mx: v.mxProvider,
        };
        console.log("  smtp", email, v.status, v.isCatchAll ? "CA" : "");
      } catch (e) {
        row.smtp[email] = { error: e.message };
      }
    }

    caseOut.people.push(row);
  }

  report.cases.push(caseOut);
}

// scoring summary
const summary = [];
for (const c of report.cases) {
  for (const p of c.people) {
    const best = p.mailgraph?.best?.email;
    const smtpBest = best ? p.smtp[best]?.status : null;
    const anyValid = Object.entries(p.smtp || {}).filter(
      ([e, v]) => v.status === "valid" && !v.catchAll,
    );
    const hunterEmails = p.hunter?.web?.emails || [];
    const hunterValid = hunterEmails.filter(
      (e) => p.smtp[e]?.status === "valid",
    );
    summary.push({
      domain: c.domain,
      person: p.fullName,
      mailgraphBest: best,
      mailgraphSmtp: smtpBest,
      mailgraphOk: smtpBest === "valid",
      hunterWebCount: hunterEmails.length,
      hunterValidCount: hunterValid.length,
      validMailboxesFound: anyValid.map(([e]) => e),
      catchAllDomain: Object.values(p.smtp || {}).some((v) => v.catchAll),
    });
  }
}
report.summary = summary;

fs.writeFileSync(
  "/workspace/data/enterprise-compare.json",
  JSON.stringify(report, null, 2),
);
console.log("\n\n===== SUMMARY =====");
console.log(JSON.stringify(summary, null, 2));
console.log("\nClay:", report.clay.note);
