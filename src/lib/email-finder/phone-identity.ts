/**
 * US 12,554,878 B2 (WhatsApp LLC) — phone-number obfuscation.
 * Internal supplemental ID (LID) is 1:1 with the phone on the server and
 * unidentifiable to any entity outside that server. Display name ≠ phone.
 *
 * PASS = we may emit a number (legacy graph / broker / user published it).
 * FAIL = username / peer id / member URN / BSUID is not the phone; do not unmask.
 */

export type PhoneIdModel = "pass" | "fail";

/** Platform identity model. FAIL = LID-class. PASS = still maps to a phone. */
export const PHONE_ID_MODEL: Record<string, PhoneIdModel> = {
  whatsapp: "fail",
  signal: "fail",
  telegram: "fail",
  instagram: "fail",
  messenger: "fail",
  facebook: "fail",
  x: "fail",
  twitter: "fail",
  linkedin: "fail",
  snapchat: "fail",
  imessage: "fail",
  zoominfo: "pass",
  rocketreach: "pass",
  truecaller: "pass",
  getcontact: "pass",
  gravatar: "pass",
  jsonld: "pass",
  "employer-site": "pass",
  "about.me": "pass",
  vcf: "pass",
};

export function isLidPlatform(network: string): boolean {
  return PHONE_ID_MODEL[network.toLowerCase()] === "fail";
}

/** LID / peer / member ids look numeric and are not E.164 mobiles. */
export function looksLikeInternalId(digits: string): boolean {
  const n = digits.replace(/\D/g, "");
  if (n.length >= 15) return true; // snowflake / WA LID / IG pk
  if (n.length >= 8 && n.length <= 19 && !/^[6-9]\d{9}$/.test(n) && !/^1\d{10}$/.test(n) && !/^91[6-9]\d{9}$/.test(n))
    return true;
  return false;
}
