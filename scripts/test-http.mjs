import { resilientFetch } from "../src/lib/email-finder/http.ts";

for (const url of [
  "https://www.companydetails.in/company/warewe-consultancy-private-limited",
  "https://warewe.com/contact-us/",
  "https://github.com/warewe",
  "https://www.bing.com/search?q=site%3Alinkedin.com%2Fin+warewe",
]) {
  const r = await resilientFetch(url, { preferBot: true, maxAttempts: 4 });
  console.log({
    status: r.status,
    ok: r.ok,
    attempts: r.attempts,
    ua: r.ua.slice(0, 55),
    len: r.body.length,
    url: url.slice(0, 60),
  });
}
