import { discoverSocialGraph } from "../src/lib/email-finder/social-graph.ts";

const r = await discoverSocialGraph("warewe.com", {
  brand: "warewe",
  legalName: "Warewe Consultancy Private Limited",
});
console.log(
  JSON.stringify(
    {
      detail: r.detail,
      networks: r.networksHit,
      people: r.people.slice(0, 20),
      emails: r.emails,
      profiles: r.profiles.slice(0, 25),
      ms: r.durationMs,
    },
    null,
    2,
  ),
);
