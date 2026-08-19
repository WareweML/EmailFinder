/** Common disposable / free-mail domains — reject as professional targets. */
const DISPOSABLE = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "throwaway.email",
  "yopmail.com",
  "trashmail.com",
  "getnada.com",
  "sharklasers.com",
  "maildrop.cc",
  "discard.email",
  "fakeinbox.com",
  "mailnesia.com",
  "moakt.com",
  "tempail.com",
  "dispostable.com",
  "mailcatch.com",
]);

const FREE_PERSONAL = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
]);

const ROLE_LOCALS = new Set([
  "admin",
  "administrator",
  "info",
  "contact",
  "support",
  "help",
  "sales",
  "hello",
  "hi",
  "team",
  "office",
  "billing",
  "accounts",
  "finance",
  "hr",
  "jobs",
  "careers",
  "press",
  "media",
  "marketing",
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "postmaster",
  "webmaster",
  "hostmaster",
  "abuse",
  "security",
  "privacy",
  "legal",
  "compliance",
  "enquiries",
  "inquiry",
  "reception",
  "service",
  "customerservice",
  "customer-service",
]);

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE.has(domain.toLowerCase());
}

export function isFreePersonalDomain(domain: string): boolean {
  return FREE_PERSONAL.has(domain.toLowerCase());
}

export function isRoleBasedLocal(local: string): boolean {
  const base = local.toLowerCase().split("+")[0] ?? local;
  return ROLE_LOCALS.has(base);
}

export function isRoleBasedEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  return isRoleBasedLocal(email.slice(0, at));
}
