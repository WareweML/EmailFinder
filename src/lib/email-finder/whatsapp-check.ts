/**
 * Validate a number we already found — not a last-4 brute.
 * Official Cloud API has no existence check. These are unofficial session/proxy APIs.
 * "on WhatsApp" is a liveness tag, not identity (India professional WA penetration is high).
 *
 * Env (any one):
 *   WHAPI_TOKEN                 gate.whapi.cloud
 *   GREENAPI_ID + GREENAPI_TOKEN
 *   WHATSAPP_CHECK_KEY + WHATSAPP_CHECK_URL  (whatsabot / checkleaked / opendata)
 */

import { readFileSync } from "node:fs";

function env(k: string): string {
  if (process.env[k]) return process.env[k]!;
  try {
    const m = readFileSync("/workspace/.env", "utf8").match(new RegExp(`^${k}=(.*)$`, "m"));
    return m?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function e164digits(n: string): string {
  return n.replace(/\D/g, "").replace(/^0+/, "");
}

export type WaCheck = { exists: boolean | null; provider: string; name?: string; error?: string };

export function waConfigured(): boolean {
  return !!(env("WHAPI_TOKEN") || (env("GREENAPI_ID") && env("GREENAPI_TOKEN")) || (env("WHATSAPP_CHECK_KEY") && env("WHATSAPP_CHECK_URL")));
}

async function jsonFetch(url: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(12000) });
  return res.json().catch(() => ({ _http: res.status }));
}

async function viaWhapi(phone: string): Promise<WaCheck> {
  const token = env("WHAPI_TOKEN");
  const data = await jsonFetch("https://gate.whapi.cloud/contacts", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ blocking: "wait", force_check: true, contacts: [phone] }),
  });
  const row = data?.contacts?.[0] ?? data;
  if (row?.status === "valid" || row?.status === "invalid") {
    return { exists: row.status === "valid", provider: "whapi", name: row.notify ?? row.name };
  }
  return { exists: null, provider: "whapi", error: data?.error?.message || data?.message || "no status" };
}

async function viaGreen(phone: string): Promise<WaCheck> {
  const id = env("GREENAPI_ID");
  const tok = env("GREENAPI_TOKEN");
  const host = env("GREENAPI_URL") || "https://api.green-api.com";
  const data = await jsonFetch(`${host}/waInstance${id}/checkWhatsapp/${tok}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phoneNumber: Number(phone) }),
  });
  if (typeof data?.existsWhatsapp === "boolean") {
    return { exists: data.existsWhatsapp, provider: "green-api", name: data.username || undefined };
  }
  return { exists: null, provider: "green-api", error: data?.message || JSON.stringify(data).slice(0, 120) };
}

async function viaGeneric(phone: string): Promise<WaCheck> {
  const key = env("WHATSAPP_CHECK_KEY");
  const base = env("WHATSAPP_CHECK_URL").replace(/\/$/, "");
  const url = base.includes("{phone}") ? base.replace("{phone}", phone) : `${base}${base.includes("?") ? "&" : "?"}phone=${phone}`;
  const data = await jsonFetch(url, { headers: { "x-api-key": key, Authorization: `Bearer ${key}`, Accept: "application/json" } });
  const exists =
    data?.result?.exist ??
    data?.exists ??
    data?.isExist ??
    (data?.status === "valid" ? true : data?.status === "invalid" ? false : null);
  if (typeof exists === "boolean") return { exists, provider: "generic", name: data?.name };
  return { exists: null, provider: "generic", error: data?.message || data?.error || "no boolean" };
}

/** One number, one call. Never a 10k last-4 scan. */
export async function checkWhatsApp(number: string): Promise<WaCheck> {
  const phone = e164digits(number);
  if (phone.length < 10) return { exists: null, provider: "none", error: "short" };
  if (!waConfigured()) return { exists: null, provider: "none", error: "not configured" };
  try {
    if (env("WHAPI_TOKEN")) return viaWhapi(phone);
    if (env("GREENAPI_ID") && env("GREENAPI_TOKEN")) return viaGreen(phone);
    return viaGeneric(phone);
  } catch (e) {
    return { exists: null, provider: "error", error: e instanceof Error ? e.message : "fail" };
  }
}
