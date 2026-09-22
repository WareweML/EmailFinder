/** Job-title cleanup. No Node APIs — safe for any importer. */

export const TECH_NOT_COMPANY =
  /^(k8s|kubernetes|gpu|aws|azure|gcp|linux|docker|terraform|python|java|react|node\.?js|ai|ml|cloud|devops)$/i;
export const SLOGAN =
  /\b(passionate|helping|love to|enthusiast|ninja|guru|is my|advocate|geek|wizard|i help|we help)\b/i;
export const ROLE_WORD =
  /\b(manager|director|engineer|officer|lead(?:er)?|vp|head|founder|writer|specialist|consultant|analyst|executive|designer|marketer|strategist|intern|associate|partner|owner|ceo|cto|cfo|coo|president|architect|admin(?:istrator)?|assurance)\b/i;
const CERT_ONLY =
  /\b(certified|istqb|pmp\b|cissp|itil|scrum master|aws certified)\b/i;

export function cleanRoleTitle(
  raw?: string,
  companyHint?: string,
): string | undefined {
  if (!raw) return undefined;
  const compactEq = (a: string, b: string) =>
    a.toLowerCase().replace(/[^a-z0-9]+/g, "") ===
    b.toLowerCase().replace(/[^a-z0-9]+/g, "");
  let t = raw
    .replace(/[^\w\s.&+/()#'-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*[-–|]\s*LinkedIn\b.*$/i, "")
    .replace(/\s*\|\s*LinkedIn.*$/i, "")
    .trim();
  if (!t || t.length < 3) return undefined;
  if (/^linkedin$/i.test(t)) return undefined;
  if (TECH_NOT_COMPANY.test(t)) return undefined;
  if (companyHint && compactEq(t, companyHint)) return undefined;
  if (/^(i|we)\s/i.test(t) && !ROLE_WORD.test(t)) return undefined;
  if (t.split(/\s+/).length > 8 && !ROLE_WORD.test(t)) return undefined;
  const at = t.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
  if (at) {
    const role = at[1]!.trim();
    const co = at[2]!.replace(/\s*[-–|].*$/, "").trim();
    if (TECH_NOT_COMPANY.test(co)) return role || undefined;
    if (SLOGAN.test(role) && !/\b(manager|director|engineer|officer|lead|vp|head|founder)\b/i.test(role)) {
      return undefined;
    }
    if (companyHint && compactEq(role, companyHint)) return undefined;
    return role || undefined;
  }
  if (SLOGAN.test(t)) {
    const strongRole =
      /\b(manager|director|engineer|officer|lead|vp|head|founder|cto|ceo|analyst|consultant)\b/i.test(
        t,
      );
    if (!strongRole) return undefined;
  }
  if (companyHint) {
    const esc = companyHint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t
      .replace(new RegExp(`\\s+at\\s+${esc}.*$`, "i"), "")
      .replace(new RegExp(`^${esc}\\s*[-–|]\\s*`, "i"), "")
      .replace(new RegExp(`\\s*[-–|]\\s*${esc}$`, "i"), "")
      .trim();
    if (!t || compactEq(t, companyHint)) return undefined;
  }
  return t.slice(0, 120) || undefined;
}

export function pickJobTitle(
  raw?: string,
  companyHint?: string,
  experience?: Array<{ title?: string; current?: boolean }>,
): string | undefined {
  const fromExp = experience?.find((e) => e.current && e.title)?.title
    || experience?.find((e) => e.title)?.title;
  const expClean = cleanRoleTitle(fromExp, companyHint);
  const parts = (raw ?? "")
    .split(/\s*[|/·•:]\s*/)
    .flatMap((s) => s.split(/\s*,\s*/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
  let best: { title: string; score: number } | undefined;
  for (const part of parts) {
    const c = cleanRoleTitle(part, companyHint);
    if (!c) continue;
    let score = 1;
    if (ROLE_WORD.test(c)) score += 3;
    if (/\b(director|manager|lead|architect|engineer|officer|head|founder)\b/i.test(c))
      score += 2;
    if (CERT_ONLY.test(c) && !/\b(lead|manager|engineer|architect)\b/i.test(c)) score -= 3;
    if (SLOGAN.test(c)) score -= 4;
    if (!best || score > best.score) best = { title: c, score };
  }
  if (expClean && (!best || best.score <= 1)) return expClean;
  if (best && best.score > 0) return best.title;
  return expClean;
}

export function companyFromHeadline(raw?: string): string | undefined {
  if (!raw) return undefined;
  const at = raw.match(/\s+(?:at|@)\s+([A-Z][\w.&' -]{1,40})/i);
  if (/\b(featured|published|interviewed|quoted|mentioned|appeared|covered)\s+at\b/i.test(raw)) {
    return undefined;
  }
  const co = at?.[1]?.replace(/\s*[-–|].*$/, "").trim();
  if (!co || TECH_NOT_COMPANY.test(co) || /linkedin/i.test(co)) return undefined;
  if (SLOGAN.test(co)) return undefined;
  return co;
}
