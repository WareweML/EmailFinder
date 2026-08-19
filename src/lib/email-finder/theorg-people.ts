/**
 * TheOrg public SSR — cookieless org chart + team pages.
 * GHD live: 7,829 positions, 125 teams, 50 named people per team.
 */

export type TheOrgHit = {
  name: string;
  title?: string;
  slug: string;
  url: string;
  team?: string;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function nextProps(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(
      /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (!m) return null;
    const j = JSON.parse(m[1]!) as {
      props?: { pageProps?: Record<string, unknown> };
    };
    return j.props?.pageProps ?? null;
  } catch {
    return null;
  }
}

function walkPeople(
  node: unknown,
  out: TheOrgHit[],
  seen: Set<string>,
  team?: string,
) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const x of node) walkPeople(x, out, seen, team);
    return;
  }
  if (typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const name = typeof o.fullName === "string" ? o.fullName : undefined;
  const role = typeof o.role === "string" ? o.role : undefined;
  const slug = typeof o.slug === "string" ? o.slug : undefined;
  if (name && slug && name.split(/\s+/).length >= 2 && !seen.has(slug)) {
    seen.add(slug);
    out.push({
      name,
      title: role,
      slug,
      url: `https://theorg.com/org/_/p/${slug}`,
      team,
    });
  }
  const nestedTeam =
    typeof o.name === "string" && o.__typename === "Team" ? o.name : team;
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") walkPeople(v, out, seen, nestedTeam);
  }
}

function slugCandidates(domain: string, companyName: string): string[] {
  const host = domain.replace(/^www\./, "");
  const brand = host.split(".")[0] ?? host;
  const dotted = host.replace(/\./g, "-");
  const name = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return [...new Set([dotted, `${brand}-com`, brand, name, `${name}-com`])].filter(
    (s) => s.length >= 2,
  );
}

export async function theOrgPeople(
  domain: string,
  companyName: string,
): Promise<{ hits: TheOrgHit[]; positions: number; teams: number; slug?: string }> {
  let props: Record<string, unknown> | null = null;
  let slug: string | undefined;
  for (const s of slugCandidates(domain, companyName)) {
    props = await nextProps(`https://theorg.com/org/${s}`);
    if (props?.initialCompany) {
      slug = s;
      break;
    }
  }
  if (!props || !slug) return { hits: [], positions: 0, teams: 0 };

  const hits: TheOrgHit[] = [];
  const seen = new Set<string>();
  walkPeople(props, hits, seen);

  const company = props.initialCompany as {
    stats?: { positionCount?: number; teamsCount?: number };
    offices?: Array<{ slug?: string }>;
  };
  const teams = (props.initialTeams as Array<{ slug?: string }> | undefined) ?? [];
  const extra = new Set<string>();
  for (const t of teams) if (t.slug) extra.add(`/org/${slug}/teams/${t.slug}`);
  for (const o of company.offices ?? []) {
    if (o.slug) extra.add(`/org/${slug}/offices/${o.slug}`);
  }

  const { decodoShards } = await import("./decodo-serp");
  const teamQueries = [
    `site:theorg.com/org/${slug}/teams/`,
    `site:theorg.com/org/${slug}/teams/ engineer`,
    `site:theorg.com/org/${slug}/teams/ water`,
    `site:theorg.com/org/${slug}/teams/ marketing`,
    `site:theorg.com/org/${slug}/teams/ finance`,
    `site:theorg.com/org/${slug}/teams/ sales`,
    `site:theorg.com/org/${slug}/teams/ digital`,
    `site:theorg.com/org/${slug}/offices/`,
  ];
  const guessed = [
    "advisory-services",
    "proposal-management",
    "risk-management",
    "executive-support",
    "hydrogeology-department",
    "consulting-services",
    "environmental-engineering",
    "environmental-team",
    "sustainability-services",
    "mechanical-engineering",
    "structural-engineering",
    "geotechnical",
    "water",
    "transportation",
    "digital",
    "finance",
    "human-resources",
    "marketing",
    "legal",
    "information-technology",
    "operations",
    "health-safety",
    "asset-management",
    "architecture",
    "planning",
    "coastal",
    "marine",
    "power",
    "mining",
    "buildings",
  ];
  for (const g of guessed) extra.add(`/org/${slug}/teams/${g}`);
  try {
    const pages = await decodoShards(teamQueries);
    for (const rows of pages) {
      for (const row of rows) {
        const m = (row.link ?? "").match(
          /theorg\.com(\/org\/[^/]+\/(?:teams|offices)\/[a-z0-9\-]+)/i,
        );
        if (m) extra.add(m[1]!);
      }
    }
  } catch {
    /* optional */
  }

  const paths = [...extra].slice(0, 36);
  let i = 0;
  const width = 6;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (i < paths.length) {
        const path = paths[i++]!;
        const page = await nextProps(`https://theorg.com${path}`);
        if (page) walkPeople(page, hits, seen);
      }
    }),
  );

  return {
    hits,
    positions: company.stats?.positionCount ?? 0,
    teams: company.stats?.teamsCount ?? 0,
    slug,
  };
}
