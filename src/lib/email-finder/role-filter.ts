/** Role phrases the user types before a company search. Blank = no filter. */

const ALIASES: Record<string, string[]> = {
  cio: ["cio", "chief information officer", "chief information"],
  cto: ["cto", "chief technology officer", "chief technical officer", "chief technology"],
  cfo: ["cfo", "chief financial officer", "chief finance"],
  ceo: ["ceo", "chief executive officer", "chief executive", "managing director"],
  coo: ["coo", "chief operating officer", "chief operations"],
  cmo: ["cmo", "chief marketing officer", "chief marketing"],
  ciso: ["ciso", "chief information security officer", "chief security officer", "cso"],
  cpo: ["cpo", "chief product officer", "chief people officer"],
  founder: ["founder", "co-founder", "cofounder", "co founder", "owner", "managing partner"],
  "marketing head": [
    "head of marketing",
    "marketing director",
    "vp marketing",
    "vice president of marketing",
    "chief marketing",
    "cmo",
    "marketing head",
  ],
  "sales head": [
    "head of sales",
    "sales director",
    "vp sales",
    "chief revenue",
    "cro",
    "sales head",
  ],
};

export function parseRoleFilter(raw?: string | null): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,|;]+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 2);
}

export function expandRole(raw: string): string[] {
  const k = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (ALIASES[k]) return ALIASES[k];
  const singular = k.replace(/s\b/, "");
  if (ALIASES[singular]) return ALIASES[singular];
  const out = [raw.trim()];
  if (/\bheads?\b/i.test(k)) {
    const topic = k.replace(/\s*heads?\s*/gi, " ").trim();
    if (topic) {
      out.push(`head of ${topic}`, `${topic} director`, `vp ${topic}`, `chief ${topic}`);
    }
  }
  return out;
}

export function roleNeedles(roles: string[]): string[] {
  const out: string[] = [];
  for (const r of roles) out.push(...expandRole(r));
  return [...new Set(out.map((s) => s.toLowerCase()))];
}

export function titleMatchesRoles(title: string | undefined, roles: string[]): boolean {
  if (!roles.length) return true;
  const t = (title ?? "").toLowerCase();
  if (!t) return false;
  return roleNeedles(roles).some((n) => {
    if (/^[a-z]{2,4}$/.test(n)) return new RegExp(`\\b${n}\\b`, "i").test(t);
    return t.includes(n);
  });
}

export function serpRoleShards(company: string, domain: string, roles: string[]): string[] {
  const needles = roleNeedles(roles).slice(0, 8);
  const shards: string[] = [];
  for (const role of needles) {
    shards.push(`site:linkedin.com/in "at ${company}" "${role}"`);
    shards.push(`site:linkedin.com/in "${company}" "${role}"`);
  }
  shards.push(`site:linkedin.com/in "${domain}" (${needles.slice(0, 4).map((n) => `"${n}"`).join(" OR ")})`);
  return shards.slice(0, 14);
}
