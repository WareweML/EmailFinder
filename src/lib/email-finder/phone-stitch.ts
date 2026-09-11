/**
 * Reconstruct a mobile only when independent masks uniquely determine every digit.
 * First-6 (RocketReach) + last-4 stitches. First-6 + last-3 leaves 1 hole → miss
 * unless a name-locked exact-number SERP closes it.
 */

export type DigitMask = Array<number | null>;

function slotsOf(body: string, max = 10): DigitMask {
  const slots: DigitMask = [];
  const s = body.toUpperCase().replace(/•/g, "X").replace(/\./g, "X");
  for (const ch of s) {
    if (slots.length >= max) break;
    if (/\d/.test(ch)) slots.push(Number(ch));
    else if (ch === "X" || ch === "*") slots.push(null);
  }
  return slots;
}

/** Prospectoo `***252***` = last 3 of a 10-digit IN mobile (same-row teaser). */
export function parseInMask(raw: string): DigitMask | null {
  const s = raw.replace(/\u00a0/g, " ").trim();
  const cc91 = s.match(/\+91\s*([6-9][\dX*x•.\s-]{4,16})/);
  if (cc91) {
    const slots = slotsOf(cc91[1]!.replace(/[\s-]/g, ""));
    if (slots.length >= 4 && slots[0] != null && slots[0]! >= 6) {
      while (slots.length < 10) slots.push(null);
      return slots.slice(0, 10);
    }
  }
  const ez = s.match(/\b([6-9]\d{4})\*{3,6}/);
  if (ez) {
    const slots = slotsOf(ez[1]! + "*****");
    while (slots.length < 10) slots.push(null);
    return slots.slice(0, 10);
  }
  const bare = s.match(/\b([6-9]\d{4})\s*([X*]{3,5})\b/i);
  if (bare) {
    const slots = slotsOf(bare[1]! + bare[2]!);
    while (slots.length < 10) slots.push(null);
    return slots.slice(0, 10);
  }
  const last3 = s.match(/(?:^|[^\d])\*{2,3}(\d{3})\*{2,3}(?:[^\d]|$)/);
  if (last3) {
    const tail = last3[1]!;
    const slots: DigitMask = Array(10).fill(null);
    for (let i = 0; i < 3; i++) slots[7 + i] = Number(tail[i]);
    return slots;
  }
  const last4 = s.match(/\(\*{3}\)\s*\*{3}[\s-]*(\d{4})/);
  if (last4) {
    const tail = last4[1]!;
    const slots: DigitMask = Array(10).fill(null);
    for (let i = 0; i < 4; i++) slots[6 + i] = Number(tail[i]);
    return slots;
  }
  // Recovery / login hints: +91******3112, ending in 3112, ****3112, ••••••12
  const rec91 = s.match(/\+91[\s-]*[*xX•.]{4,8}[\s-]*(\d{2,4})\b/);
  if (rec91) {
    const tail = rec91[1]!;
    const slots: DigitMask = Array(10).fill(null);
    for (let i = 0; i < tail.length; i++) slots[10 - tail.length + i] = Number(tail[i]);
    return slots;
  }
  const ending = s.match(/\b(?:ending in|ends in|ends with|last\s*[234]\s*digits?)\s*[#:.]?\s*(\d{2,4})\b/i);
  if (ending) {
    const tail = ending[1]!;
    const slots: DigitMask = Array(10).fill(null);
    for (let i = 0; i < tail.length; i++) slots[10 - tail.length + i] = Number(tail[i]);
    return slots;
  }
  const starsLast = s.match(/(?:^|[^\d])[*xX•]{3,8}[\s-]*(\d{4})(?:[^\d]|$)/);
  if (starsLast) {
    const tail = starsLast[1]!;
    const slots: DigitMask = Array(10).fill(null);
    for (let i = 0; i < 4; i++) slots[6 + i] = Number(tail[i]);
    return slots;
  }
  const full = s.match(/\b([6-9]\d{9})\b/);
  if (full) return full[1]!.split("").map(Number);
  return null;
}

export function mergeMasks(masks: DigitMask[]): DigitMask | null {
  if (!masks.length) return null;
  const out: DigitMask = Array(10).fill(null);
  for (const m of masks) {
    for (let i = 0; i < 10; i++) {
      const d = m[i];
      if (d == null) continue;
      if (out[i] != null && out[i] !== d) return null;
      out[i] = d;
    }
  }
  return out;
}

export function uniqueNumber(mask: DigitMask): string | null {
  if (mask.some((d) => d == null)) return null;
  const n = mask.join("");
  if (!/^[6-9]\d{9}$/.test(n)) return null;
  return n;
}

export function holeCount(mask: DigitMask): number {
  return mask.filter((d) => d == null).length;
}

export function expandOneHole(mask: DigitMask): string[] {
  if (holeCount(mask) !== 1) return [];
  const idx = mask.findIndex((d) => d == null);
  const out: string[] = [];
  for (let d = 0; d <= 9; d++) {
    if (idx === 0 && d < 6) continue;
    const copy = mask.slice() as DigitMask;
    copy[idx] = d;
    const n = uniqueNumber(copy);
    if (n) out.push(n);
  }
  return out;
}

export function stitchMobiles(rawMasks: string[]): string | null {
  const parsed = rawMasks.map(parseInMask).filter((m): m is DigitMask => Boolean(m));
  if (!parsed.length) return null;
  const merged = mergeMasks(parsed);
  if (!merged) return null;
  return uniqueNumber(merged);
}

export function stitchState(rawMasks: string[]): { number: string | null; merged: DigitMask | null; candidates: string[] } {
  const parsed = rawMasks.map(parseInMask).filter((m): m is DigitMask => Boolean(m));
  const merged = parsed.length ? mergeMasks(parsed) : null;
  if (!merged) return { number: null, merged: null, candidates: [] };
  const number = uniqueNumber(merged);
  return { number, merged, candidates: number ? [] : expandOneHole(merged) };
}

/** Try each prefix against suffixes; accept only if exactly one number uniquely wins. */
export function stitchBest(prefixes: string[], suffixes: string[]): {
  number: string | null;
  candidates: string[];
  source: string;
} {
  const wins = new Set<string>();
  const holeCands = new Set<string>();
  for (const p of prefixes) {
    const pMask = parseInMask(p);
    if (!pMask || holeCount(pMask) === 0) continue;
    const together = stitchState([p, ...suffixes].filter(Boolean));
    if (together.number) wins.add(together.number);
    else if (together.candidates.length) together.candidates.forEach((c) => holeCands.add(c));
    for (const s of suffixes) {
      const sMask = parseInMask(s);
      if (!sMask) continue;
      const one = stitchState([p, s]);
      if (one.number) wins.add(one.number);
      else one.candidates.forEach((c) => holeCands.add(c));
    }
  }
  if (wins.size === 1) return { number: [...wins][0]!, candidates: [], source: "mask-stitch" };
  if (wins.size > 1) return { number: null, candidates: [], source: "conflict" };
  return { number: null, candidates: [...holeCands].slice(0, 10), source: "hole" };
}

export function prospectooMaskFor(html: string, fullName: string): string | null {
  const want = fullName.trim().toLowerCase();
  if (!want || !html) return null;
  const boxes = html.split(/gridBoxList/i);
  for (const b of boxes) {
    const fields = [...b.matchAll(/<div>([^<]*)<\/div>/gi)].map((x) => x[1]!.trim());
    if (!fields[0] || fields[0].toLowerCase() !== want) continue;
    const mask = fields.find((f) => /\*{2,3}\d{3}\*{2,3}/.test(f));
    if (mask) return mask;
  }
  return null;
}

/** First +91 *mask* on THIS person's RocketReach card. Full numbers are not prefixes. */
export function rocketMaskFor(
  title: string,
  desc: string,
  url: string,
  fullName: string,
): string | null {
  if (!/rocketreach\.co/i.test(url)) return null;
  const slug = (url.split("/").pop() ?? "").toLowerCase();
  const tokens = fullName.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const onSlug = tokens.every((t) => slug.includes(t.replace(/[^a-z]/g, "")));
  const onTitle = tokens.every((t) => title.toLowerCase().includes(t));
  if (!onSlug && !onTitle) return null;
  const blob = onTitle ? `${title} ${desc}` : desc;
  const m = blob.match(/\+91\s*[6-9][\dX*x•.\s-]{6,18}/);
  if (!m) return null;
  const parsed = parseInMask(m[0]);
  if (!parsed || holeCount(parsed) === 0) return null;
  return m[0];
}
