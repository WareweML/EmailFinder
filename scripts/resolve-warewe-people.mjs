import { verifyEmail } from "../src/lib/email-finder/verify.ts";
import { personEmailGuesses } from "../src/lib/email-finder/public-graph.ts";
import { upsertIndexRecord } from "../src/lib/email-finder/index-store.ts";
import { parseFullName, slugifyToken } from "../src/lib/email-finder/normalize.ts";
import fs from "fs";

const raw = JSON.parse(
  fs.readFileSync("/workspace/data/warewe-linkedin-people.json", "utf8"),
);

function enrich(p) {
  const block = p.block || "";
  // Prefer explicit "Name - Role at Warewe" in block
  const m = block.match(
    /((?:[A-Z][a-zA-Z.'\-]+\s+){1,3}[A-Z][a-zA-Z.'\-]+)\s*[-–]\s*([^|]{5,140}Warewe[^|]{0,40})/i,
  );
  let name = p.name;
  let role = p.role;
  if (m && !/linkedin|india|https/i.test(m[1])) {
    name = m[1].trim();
    role = m[2].trim();
  } else {
    // from block line containing name
    const line = block
      .split("|")
      .map((s) => s.trim())
      .find(
        (s) =>
          /warewe/i.test(s) &&
          /[-–]/.test(s) &&
          !/^https?:/i.test(s) &&
          !/linkedin india/i.test(s),
      );
    if (line) {
      const d = line.match(/^(.+?)\s*[-–]\s*(.+)$/);
      if (d && d[1].split(/\s+/).length <= 4) {
        name = d[1].trim();
        role = d[2].trim();
      }
    }
  }
  if (/passionate|linkedin|about research|india/i.test(name)) return null;
  const current = !/\b(ex[- ]|former)\b/i.test(role || block);
  const atWarewe = /warewe/i.test(role || block + name);
  return {
    name,
    role,
    slug: p.slug,
    url: p.url,
    current: current && atWarewe,
    atWarewe,
  };
}

const people = [];
const seen = new Set();
for (const r of raw) {
  const e = enrich(r);
  if (!e) continue;
  const key = e.name.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  people.push(e);
}

console.log("people to resolve:", people.length);
for (const p of people) console.log(" -", p.name, "|", p.role);

const domain = "warewe.com";
const resolved = [];

for (const p of people) {
  const parsed = parseFullName(p.name);
  if (!parsed.first || !parsed.last) {
    console.log("skip parse", p.name);
    continue;
  }
  const f = slugifyToken(parsed.first);
  const l = slugifyToken(parsed.last);
  const guesses = [
    // Indian order often last@ or first@
    { email: `${l}@${domain}`, patternId: "last", label: "last" },
    { email: `${f}@${domain}`, patternId: "first", label: "first" },
    ...personEmailGuesses(parsed.first, parsed.last, domain),
  ];
  const seenE = new Set();
  let best = null;
  for (const g of guesses) {
    if (seenE.has(g.email)) continue;
    seenE.add(g.email);
    if (seenE.size > 7) break;
    const v = await verifyEmail(g.email, { skipSmtp: false });
    console.log(
      `  ${p.name.padEnd(16)} ${g.email.padEnd(30)} ${v.status}`,
    );
    if (v.status === "valid") {
      best = {
        email: g.email,
        status: "valid",
        pattern: g.label,
        confidence: 96,
      };
      break;
    }
    if (v.isCatchAll) break;
  }
  const row = {
    ...p,
    firstName: parsed.first,
    lastName: parsed.last,
    email: best?.email ?? null,
    emailStatus: best?.status ?? "unknown",
    confidence: best?.confidence ?? 0,
    pattern: best?.pattern ?? null,
  };
  resolved.push(row);
  if (best?.email) {
    await upsertIndexRecord({
      email: best.email,
      domain,
      firstName: parsed.first,
      lastName: parsed.last,
      title: p.role,
      sources: [
        { url: p.url, kind: "public_graph", seenAt: new Date().toISOString() },
        {
          url: "serp://startpage?q=site:linkedin.com+warewe",
          kind: "public_graph",
          seenAt: new Date().toISOString(),
        },
      ],
      confidence: best.confidence,
      status: "valid",
    });
  }
}

fs.writeFileSync(
  "/workspace/data/warewe-resolved.json",
  JSON.stringify(resolved, null, 2),
);
console.log("\n=== RESOLVED ===");
for (const r of resolved) {
  console.log(
    `${r.emailStatus === "valid" ? "OK" : "--"} ${r.name.padEnd(16)} ${(r.email || "—").padEnd(28)} ${String(r.emailStatus).padEnd(8)} ${r.current ? "NOW" : "past"}  ${r.role || ""}`,
  );
}
