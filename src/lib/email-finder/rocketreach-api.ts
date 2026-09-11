/**
 * RocketReach API — cheapest plan that includes phones is **Pro**.
 * Essentials = email only. Unlimited lookups (annual) still cap **exports**;
 * every API /person/lookup burns an export. Global ceiling: 10 req/s.
 *
 * Set ROCKETREACH_API_KEY + ROCKETREACH_PLAN=pro|ultimate|custom
 */

import { readFileSync } from "node:fs";

const PUBLIC_KEY = "3e7k0123456789abcdef0123456789abcdef";
const BASE = "https://api.rocketreach.co/api/v2";

/** Official /rate-limits — person lookup per minute. */
const LOOKUP_PER_MIN: Record<string, number> = {
  essentials: 15,
  pro: 50,
  ultimate: 100,
  custom: 250,
  sandbox: 5,
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

function envKey(): string {
  return env("ROCKETREACH_API_KEY") || PUBLIC_KEY;
}

export function rrPlan(): string {
  const p = (env("ROCKETREACH_PLAN") || (envKey() === PUBLIC_KEY ? "sandbox" : "pro")).toLowerCase();
  return LOOKUP_PER_MIN[p] ? p : "pro";
}

export function isPaidRrKey(): boolean {
  const k = envKey();
  return !!k && k !== PUBLIC_KEY;
}

let lastAt = 0;
const minuteHits: number[] = [];

async function gateLookup(): Promise<void> {
  const minGap = 110; // 10 rps global + margin
  const wait = lastAt + minGap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const cap = LOOKUP_PER_MIN[rrPlan()] ?? 50;
  const now = Date.now();
  while (minuteHits.length && now - minuteHits[0]! > 60_000) minuteHits.shift();
  if (minuteHits.length >= cap) {
    const sleep = 60_000 - (now - minuteHits[0]!) + 50;
    await new Promise((r) => setTimeout(r, sleep));
  }
  lastAt = Date.now();
  minuteHits.push(lastAt);
}

async function rrFetch(url: string, init: RequestInit, lookup: boolean): Promise<any> {
  if (lookup) await gateLookup();
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(25000) });
    if (res.status === 429) {
      const sec = Number(res.headers.get("Retry-After") || "2");
      await new Promise((r) => setTimeout(r, Math.min(30, Math.max(1, sec)) * 1000));
      continue;
    }
    return res.json().catch(() => ({ detail: `http ${res.status}` }));
  }
  return { detail: "rate limited" };
}

async function rrGet(path: string, params: Record<string, string>, lookup = false): Promise<any> {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return rrFetch(u.toString(), { headers: { "Api-Key": envKey(), Accept: "application/json" } }, lookup);
}

async function rrPost(path: string, body: unknown): Promise<any> {
  return rrFetch(
    BASE + path,
    {
      method: "POST",
      headers: { "Api-Key": envKey(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
    false,
  );
}

export type RrPhone = { number: string; type?: string; premium?: boolean };

export async function rrAccount(): Promise<{ remainingLookups: number | "inf"; phonePlan: boolean; raw: any }> {
  const raw = await rrGet("/account/", {}, false);
  const credits: Array<{ credit_type: string; remaining: number | string }> = raw?.credit_usage ?? [];
  const phone = credits.find((c) => /phone|premium/i.test(c.credit_type));
  const exportC = credits.find((c) => /export|lookup/i.test(c.credit_type) && !/company/i.test(c.credit_type));
  const remaining = exportC?.remaining ?? phone?.remaining ?? 0;
  return {
    remainingLookups: remaining === "inf" || remaining === Infinity ? "inf" : Number(remaining) || 0,
    phonePlan: credits.some((c) => /phone|premium/i.test(c.credit_type) && Number(c.allocated) > 0) || isPaidRrKey(),
    raw,
  };
}

export async function rocketSearch(name: string, company?: string): Promise<{
  id?: number;
  teasers: string[];
  error?: string;
}> {
  const query: Record<string, string[]> = { name: [name] };
  if (company) query.current_employer = [company];
  const data = await rrPost("/person/search", { query });
  if (data?.error || data?.detail) return { teasers: [], error: data.error || data.detail };
  const p = data?.profiles?.[0];
  const teasers = ((p?.teaser?.phones ?? []) as Array<{ number?: string }>)
    .map((x) => x.number ?? "")
    .filter(Boolean);
  return { id: p?.id, teasers };
}

export async function rocketLookup(opts: {
  id?: number | string;
  name?: string;
  company?: string;
  linkedinUrl?: string;
}): Promise<{ phones: RrPhone[]; emails: string[]; error?: string; name?: string }> {
  const params: Record<string, string> = { lookup_type: "phone" };
  if (opts.id) params.id = String(opts.id);
  if (opts.name) params.name = opts.name;
  if (opts.company) params.current_employer = opts.company;
  if (opts.linkedinUrl) params.linkedin_url = opts.linkedinUrl;
  let data = await rrGet("/person/lookup", params, true);
  if (data?.detail) return { phones: [], emails: [], error: data.detail };
  const id = data?.id;
  if (id && data?.status && data.status !== "complete") {
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 700));
      const st = await rrGet("/person/checkStatus", { ids: String(id) }, false);
      const row = Array.isArray(st) ? st[0] : st;
      if (row?.status === "complete") {
        data = row;
        break;
      }
    }
  }
  const phones = ((data?.phones ?? []) as RrPhone[]).filter((p) => p?.number && !/[X*]{2,}/i.test(p.number));
  const emails = ((data?.emails ?? []) as Array<{ email?: string }>).map((e) => e.email ?? "").filter(Boolean);
  return { phones, emails, name: data?.name };
}
