import { xrayPeopleAtCompanies, isDistinctiveCompany } from "../src/lib/email-finder/decodo-serp.ts";

async function main() {
  const cos = [
    { name: "First Hospitality" },
    { name: "CoralTree Hospitality" },
    { name: "GHD" },
  ];
  console.log(cos.map((c) => [c.name, isDistinctiveCompany(c.name)]));
  const hits = await xrayPeopleAtCompanies(cos, "United States");
  console.log("named", hits.length);
  for (const h of hits.slice(0, 20)) {
    console.log(" ", h.name, "|", (h.title || "").slice(0, 55), "|", h.slug);
  }
}
main();
