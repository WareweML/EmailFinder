/** Spawn the proven curl_cffi + CaptchaAI flow on the 30-min Okk sticky session. */

import { spawn } from "node:child_process";

export type StickyHit = {
  name: string;
  title?: string;
  slug: string;
  url: string;
};

export function googleStickySearch(
  query: string,
  company: string,
): Promise<StickyHit[]> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["scripts/google-sticky.py", query, company], {
      cwd: "/workspace",
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", () => resolve([]));
    child.on("close", () => {
      try {
        const j = JSON.parse(out.trim().split("\n").pop() ?? "[]") as StickyHit[];
        resolve(Array.isArray(j) ? j : []);
      } catch {
        resolve([]);
      }
    });
  });
}
