/**
 * Have I Been Pwned — official API only.
 * HIBP returns breach *names* and data-classes for an email/phone you already have.
 * It never returns the stolen phone / password / dump row.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type HibpBreach = {
  name: string;
  title: string | null;
  domain: string | null;
  breachDate: string | null;
  dataClasses: string[];
};

export type HibpHit = {
  pwned: boolean | null;
  count: number;
  breaches: HibpBreach[];
  dataClasses: string[];
  latest: string | null;
  pastes: number | null;
  source: string;
};

function env(key: string): string {
  if (process.env[key]) return process.env[key]!;
  try {
    const m = readFileSync("/workspace/.env", "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
    return m?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

const UA = "Mailgraph/1.0 (HIBP; research@warewe.com)";

function key(): string {
  return env("HIBP_API_KEY") || env("HAVEIBEENPWNED_API_KEY");
}

export function hibpConfigured(): boolean {
  return Boolean(key());
}

async function hibpGet(path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`https://haveibeenpwned.com/api/v3${path}`, {
    signal: AbortSignal.timeout(10000),
    headers: {
      "User-Agent": UA,
      "hibp-api-key": key(),
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

function asBreaches(raw: unknown): HibpBreach[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((b) => {
    if (typeof b === "string") {
      return { name: b, title: b, domain: null, breachDate: null, dataClasses: [] };
    }
    const o = b as Record<string, unknown>;
    return {
      name: String(o.Name ?? o.name ?? ""),
      title: (o.Title as string) ?? (o.title as string) ?? null,
      domain: (o.Domain as string) ?? null,
      breachDate: (o.BreachDate as string) ?? null,
      dataClasses: Array.isArray(o.DataClasses) ? (o.DataClasses as string[]) : [],
    };
  }).filter((b) => b.name);
}

async function accountBreaches(account: string): Promise<HibpBreach[]> {
  const enc = encodeURIComponent(account.trim());
  const { status, json } = await hibpGet(`/breachedaccount/${enc}?truncateResponse=false&includeUnverified=true`);
  if (status === 404) return [];
  if (status === 200) return asBreaches(json);
  return [];
}

async function accountPastes(account: string): Promise<number | null> {
  const enc = encodeURIComponent(account.trim());
  const { status, json } = await hibpGet(`/pasteaccount/${enc}`);
  if (status === 404) return 0;
  if (status === 200 && Array.isArray(json)) return json.length;
  return null;
}

export async function lookupPwned(accounts: string[]): Promise<HibpHit> {
  const empty: HibpHit = {
    pwned: null,
    count: 0,
    breaches: [],
    dataClasses: [],
    latest: null,
    pastes: null,
    source: "haveibeenpwned",
  };
  if (!key()) return empty;
  const uniq = [...new Set(accounts.map((a) => a.trim()).filter(Boolean))].slice(0, 4);
  if (!uniq.length) return empty;
  const seen = new Map<string, HibpBreach>();
  let pastes: number | null = 0;
  for (const acc of uniq) {
    try {
      const rows = await accountBreaches(acc);
      for (const b of rows) if (!seen.has(b.name.toLowerCase())) seen.set(b.name.toLowerCase(), b);
      const p = await accountPastes(acc);
      if (typeof p === "number") pastes = (pastes ?? 0) + p;
    } catch {
      /* rate limit / 401 */
    }
  }
  const breaches = [...seen.values()].sort((a, b) => (b.breachDate ?? "").localeCompare(a.breachDate ?? ""));
  const classes = [...new Set(breaches.flatMap((b) => b.dataClasses))];
  return {
    pwned: breaches.length > 0,
    count: breaches.length,
    breaches,
    dataClasses: classes,
    latest: breaches[0]?.breachDate ?? null,
    pastes,
    source: "haveibeenpwned",
  };
}

export type GravatarHit = {
  username: string | null;
  displayName: string | null;
  location: string | null;
  about: string | null;
  profileUrl: string | null;
  thumbnailUrl: string | null;
  accounts: Array<{ domain: string; url: string; username: string | null }>;
  phones: string[];
};

export async function lookupGravatar(email: string): Promise<GravatarHit | null> {
  const hash = createHash("md5").update(email.trim().toLowerCase()).digest("hex");
  try {
    const res = await fetch(`https://www.gravatar.com/${hash}.json`, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { entry?: Array<Record<string, unknown>> };
    const e = j.entry?.[0];
    if (!e) return null;
    const accounts = Array.isArray(e.accounts)
      ? (e.accounts as Array<Record<string, unknown>>).map((a) => ({
          domain: String(a.domain ?? a.shortname ?? ""),
          url: String(a.url ?? ""),
          username: (a.username as string) ?? null,
        }))
      : [];
    const phones = Array.isArray(e.phoneNumbers)
      ? (e.phoneNumbers as Array<Record<string, unknown> | string>).map((p) =>
          typeof p === "string" ? p : String((p as Record<string, unknown>).value ?? ""),
        ).filter(Boolean)
      : [];
    return {
      username: (e.preferredUsername as string) ?? null,
      displayName: (e.displayName as string) ?? null,
      location: (e.currentLocation as string) ?? null,
      about: (e.aboutMe as string) ?? null,
      profileUrl: (e.profileUrl as string) ?? `https://gravatar.com/${hash}`,
      thumbnailUrl: (e.thumbnailUrl as string) ?? null,
      accounts,
      phones,
    };
  } catch {
    return null;
  }
}
