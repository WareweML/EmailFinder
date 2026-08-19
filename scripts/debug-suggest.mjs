import { suggestCompanies } from "../src/lib/email-finder/company-suggest.ts";

// inline debug by importing internals? can't. reimplement complete
function compact(s){return s.toLowerCase().replace(/[^a-z0-9]+/g,"");}
const n = compact("32dentalso");
const words = ["solutions","solution","consultancy","consulting","technologies","systems","services"];
const set = new Set([n]);
for (const w of words) {
  for (let i = 2; i < w.length; i++) {
    const pref = w.slice(0,i);
    if (n.endsWith(pref) && !n.endsWith(w)) {
      set.add(n.slice(0, -pref.length) + w);
    }
  }
}
console.log("slugs", [...set]);

// probe the expected domain
for (const d of ["32dentalsolutions.com","32dentalsolutions.in","32dentalso.com"]) {
  const t=Date.now();
  try {
    const r = await fetch("https://"+d+"/", {signal: AbortSignal.timeout(5000), redirect:"follow", headers:{Accept:"text/html","User-Agent":"Mozilla/5.0"}});
    console.log(d, r.status, r.url, Date.now()-t+"ms");
  } catch(e) {
    console.log(d, "ERR", e.message, Date.now()-t+"ms");
  }
}

console.log("related 32dentalsolutions.com?", (() => {
  const brand="32dentalsolutions";
  const q=n;
  return brand.startsWith(q) && q.length>=5;
})());
