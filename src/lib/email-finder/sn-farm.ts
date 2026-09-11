/**
 * Dedicated Sales Nav farm — competitor pattern.
 * Own seats on sticky residential IPs. NEVER the operator's personal
 * LinkedIn. Personal cookies from a different IP log that human out.
 *
 * Accounts live in data/sn-farm.json:
 * [{ "liAt": "AQED...", "liA": "AQJ2...", "jsession": "ajax:...", "label": "seat-1" }]
 * Enable with LI_USE_SESSION=1 AND LI_FARM=1.
 */

import { readFileSync } from "node:fs";

export type FarmSeat = {
  liAt: string;
  liA?: string;
  jsession: string;
  label?: string;
};

export function farmSeats(): FarmSeat[] {
  if (process.env.LI_FARM !== "1") return [];
  try {
    const j = JSON.parse(readFileSync("/workspace/data/sn-farm.json", "utf8"));
    const rows = Array.isArray(j) ? j : j.seats;
    return (rows ?? []).filter(
      (s: FarmSeat) =>
        s.liAt &&
        s.jsession &&
        s.liAt.startsWith("AQED"),
    );
  } catch {
    return [];
  }
}

export function farmReady(): boolean {
  return farmSeats().length > 0;
}
