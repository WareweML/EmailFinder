import { suggestCompanies } from "../src/lib/email-finder/company-suggest.ts";
for (const q of ["paperbot", "32dentalso", "warewe"]) {
  const t0 = Date.now();
  const r = await suggestCompanies(q, 6);
  console.log("\n" + q, Date.now()-t0+"ms");
  for (const s of r) console.log(" ", s.confidence, s.source, s.name, "→", s.domain);
}
