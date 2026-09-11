export type ApiParam = {
  name: string;
  in: "query" | "body";
  required?: boolean;
  type: string;
  description: string;
  example?: string;
};

export type ApiField = {
  field: string;
  type: string;
  description: string;
};

export type ApiEndpoint = {
  id: string;
  group: string;
  method: "GET" | "POST";
  path: string;
  title: string;
  summary: string;
  description: string;
  params: ApiParam[];
  response: ApiField[];
  curl: string;
};

export const API_BASE = "/api/v2";

export const API_ENDPOINTS: ApiEndpoint[] = [
  {
    id: "company-find",
    group: "Company",
    method: "GET",
    path: "/api/v2/companies/find",
    title: "Company enrich",
    summary: "Domain → full company profile (Hunter companies/find + extra live fields).",
    description:
      "Live enrichment from the company website, LinkedIn guest, ZoomInfo phone SERP, MX, tech headers, Wikidata, and jobs. No reseller keys. Pass a domain, not a company name.",
    params: [
      { name: "domain", in: "query", required: true, type: "string", description: "Company website domain", example: "warewe.com" },
    ],
    response: [
      { field: "data.id", type: "string", description: "Stable company id" },
      { field: "data.name / displayName / legalName", type: "string", description: "Brand + legal name" },
      { field: "data.domain / website", type: "string", description: "Canonical domain and URL" },
      { field: "data.site.phoneNumbers", type: "string[]", description: "Public phones (ZoomInfo mobile first, then site landline)" },
      { field: "data.site.emailAddresses", type: "string[]", description: "Public / role emails on site" },
      { field: "data.phone", type: "string | null", description: "Primary phone (mobile preferred)" },
      { field: "data.category / industry / tags", type: "object", description: "Sector, SIC/NAICS, tags" },
      { field: "data.geo / location / timeZone", type: "object", description: "HQ address + timezone" },
      { field: "data.linkedin / twitter / facebook / crunchbase / github", type: "object", description: "Social handles + URLs" },
      { field: "data.metrics", type: "object", description: "Headcount, revenue, funding, growth" },
      { field: "data.technologies", type: "object[]", description: "Detected stack with evidence" },
      { field: "data.jobs / similarCompanies", type: "object[]", description: "Open roles + lookalikes" },
      { field: "data.mx", type: "object", description: "MX provider, SPF, DMARC" },
      { field: "meta.sources / durationMs", type: "object", description: "Live sources used" },
    ],
    curl: `curl -s "https://{host}/api/v2/companies/find?domain=warewe.com"`,
  },
  {
    id: "company-suggest",
    group: "Company",
    method: "GET",
    path: "/api/v2/companies/suggest",
    title: "Company autocomplete",
    summary: "Name prefix → ranked domain suggestions.",
    description:
      "Typeahead used by the Finder company field. Expands a prefix against search logs, LinkedIn companies, and live domains. Returns name, domain, logo, confidence.",
    params: [
      { name: "query", in: "query", required: true, type: "string", description: "Company name prefix", example: "stripe" },
    ],
    response: [
      { field: "data[].name", type: "string", description: "Company display name" },
      { field: "data[].domain", type: "string", description: "Resolved website domain" },
      { field: "data[].confidence", type: "number", description: "0–1 match score" },
      { field: "data[].source", type: "string", description: "index | linkedin | web | seed | …" },
      { field: "data[].logoUrl", type: "string?", description: "Logo if known" },
    ],
    curl: `curl -s "https://{host}/api/v2/companies/suggest?query=stripe"`,
  },
  {
    id: "company-phones",
    group: "Company",
    method: "GET",
    path: "/api/v2/companies/phones",
    title: "Company phones",
    summary: "Domain → public phones (site + ZoomInfo).",
    description:
      "Extracts tel: links and contact-page numbers, then adds ZoomInfo company-page mobiles from SERP snippets. Mobiles rank above landlines.",
    params: [
      { name: "domain", in: "query", required: true, type: "string", description: "Company domain", example: "warewe.com" },
    ],
    response: [
      { field: "domain", type: "string", description: "Normalized domain" },
      { field: "phones[].phone", type: "string", description: "Display number" },
      { field: "phones[].e164ish", type: "string", description: "E.164-ish digits" },
      { field: "phones[].sourceUrl", type: "string", description: "Page the number came from" },
      { field: "phones[].confidence", type: "number", description: "0–100" },
    ],
    curl: `curl -s "https://{host}/api/v2/companies/phones?domain=warewe.com"`,
  },
  {
    id: "person-find",
    group: "Person",
    method: "GET",
    path: "/api/v2/people/find",
    title: "Person enrich",
    summary: "Name / email / LinkedIn → person profile (PDL-shaped keys, live sources).",
    description:
      "Identify with email, linkedin_url, full_name, or first_name+last_name. Domain or company disambiguates. Returns PDL starter/base keys; null stays. Phone is only emitted when a full public number exists (no masked prefixes).",
    params: [
      { name: "email", in: "query", type: "string", description: "Work or personal email", example: "scesca@kubex.ai" },
      { name: "linkedin_url", in: "query", type: "string", description: "Public LinkedIn profile URL" },
      { name: "full_name", in: "query", type: "string", description: "Full name", example: "Kumar Manaswi" },
      { name: "first_name", in: "query", type: "string", description: "Given name (use with last_name)" },
      { name: "last_name", in: "query", type: "string", description: "Family name" },
      { name: "domain", in: "query", type: "string", description: "Current company domain", example: "warewe.com" },
      { name: "company", in: "query", type: "string", description: "Current company name" },
      { name: "phone", in: "query", type: "string", description: "Known phone (optional seed)" },
    ],
    response: [
      { field: "data.full_name / first_name / last_name", type: "string", description: "Identity" },
      { field: "data.linkedin_url / linkedin_username", type: "string | null", description: "Public profile" },
      { field: "data.work_email / personal_emails / emails", type: "mixed", description: "Work + personal emails" },
      { field: "data.mobile_phone / phone_numbers", type: "string | string[]", description: "Full numbers only; never a mask. WhatsApp/Signal/Telegram/X usernames are LID (US12554878B2) — not unmasked. Phone comes from brokers/site JSON-LD or digits the user printed in a bio." },
      { field: "data.pwned / pwn_count / pwn_breaches / pwn_data_classes / pwn_latest / pwn_pastes", type: "mixed", description: "Have I Been Pwned official: whether this email/phone appeared in named breaches. Needs HIBP_API_KEY. Does not return stolen dump fields." },
      { field: "data.job_title / job_title_role / job_title_levels", type: "mixed", description: "Current title + LinkedIn function" },
      { field: "data.job_company_*", type: "mixed", description: "Current employer (name, domain, size — not a nested company enrich)" },
      { field: "data.location_*", type: "mixed", description: "Person location, not HQ leak" },
      { field: "data.experience[] / education[]", type: "object[]", description: "Career + schools" },
      { field: "data.skills / languages / profiles", type: "array", description: "Skills, langs, socials" },
      { field: "meta.sources / durationMs", type: "object", description: "Live sources used" },
    ],
    curl: `curl -s "https://{host}/api/v2/people/find?full_name=Kumar%20Manaswi&domain=warewe.com"`,
  },
  {
    id: "email-finder",
    group: "Person",
    method: "GET",
    path: "/api/v2/email-finder",
    title: "Email finder",
    summary: "Name + domain → most likely work email, waterfall + SMTP.",
    description:
      "Hunter-style email finder. Generates pattern candidates, checks public sources, verifies MX/SMTP, returns best + alternatives with confidence.",
    params: [
      { name: "full_name", in: "query", required: true, type: "string", description: "Person full name", example: "Kumar Manaswi" },
      { name: "domain", in: "query", required: true, type: "string", description: "Company domain", example: "warewe.com" },
      { name: "linkedin_url", in: "query", type: "string", description: "Optional LinkedIn URL to lock identity" },
      { name: "skip_smtp", in: "query", type: "boolean", description: "Skip SMTP probe (faster, less certain)" },
    ],
    response: [
      { field: "best.email", type: "string | null", description: "Top email" },
      { field: "best.confidence", type: "number", description: "0–100" },
      { field: "best.status", type: "string", description: "valid | catch_all | unknown | …" },
      { field: "alternatives[]", type: "object[]", description: "Other scored candidates" },
      { field: "domainIntel", type: "object", description: "MX, patterns, known emails" },
      { field: "waterfall[]", type: "object[]", description: "Provider trail" },
    ],
    curl: `curl -s "https://{host}/api/v2/email-finder?full_name=Kumar%20Manaswi&domain=warewe.com"`,
  },
  {
    id: "email-verifier",
    group: "Person",
    method: "GET",
    path: "/api/v2/email-verifier",
    title: "Email verifier",
    summary: "Email → syntax, MX, disposable, role, SMTP status.",
    description:
      "Hunter-style verifier. Checks syntax, MX, disposable/role lists, catch-all, and SMTP when possible.",
    params: [
      { name: "email", in: "query", required: true, type: "string", description: "Address to verify", example: "hello@warewe.com" },
      { name: "skip_smtp", in: "query", type: "boolean", description: "Skip SMTP (MX-only)" },
    ],
    response: [
      { field: "email", type: "string", description: "Normalized address" },
      { field: "status", type: "string", description: "valid | invalid | catch_all | unknown | disposable | role_based | no_mx | syntax_error" },
      { field: "syntaxValid / hasMx / isDisposable / isRoleBased / isCatchAll", type: "boolean", description: "Checks" },
      { field: "mxHosts / mxProvider", type: "mixed", description: "Mail hosts" },
      { field: "smtpCode / smtpMessage", type: "mixed", description: "SMTP result if probed" },
    ],
    curl: `curl -s "https://{host}/api/v2/email-verifier?email=hello@warewe.com"`,
  },
  {
    id: "domain-search",
    group: "Domain",
    method: "GET",
    path: "/api/v2/domain-search",
    title: "Domain search",
    summary: "Domain → people + emails at the company.",
    description:
      "Hunter-style domain search. Live LinkedIn + public sources for people at the domain. Optional title filter.",
    params: [
      { name: "domain", in: "query", required: true, type: "string", description: "Company domain", example: "warewe.com" },
      { name: "title", in: "query", type: "string", description: "Filter people by title/name substring", example: "founder" },
    ],
    response: [
      { field: "companyName / domain", type: "string", description: "Resolved company" },
      { field: "people[]", type: "object[]", description: "Name, title, linkedin, location" },
      { field: "emails[]", type: "object[]", description: "Discovered emails with sources" },
      { field: "durationMs", type: "number", description: "Wall time" },
    ],
    curl: `curl -s "https://{host}/api/v2/domain-search?domain=warewe.com"`,
  },
  {
    id: "discover-people",
    group: "Discover",
    method: "POST",
    path: "/api/v2/discover/people",
    title: "Discover people",
    summary: "Sales-nav style people search (keywords, HQ, industry, size…).",
    description:
      "Filter people the same way as the Discover tab. LinkedIn Sales Nav when the session is live, plus TheOrg and public shards. JSON body.",
    params: [
      { name: "keywords", in: "body", type: "string", description: "Title / keyword", example: "marketing" },
      { name: "hqGeoId", in: "body", type: "string", description: "Company HQ geo id (LinkedIn)" },
      { name: "industryId", in: "body", type: "string", description: "LinkedIn industry id" },
      { name: "sizeId", in: "body", type: "string", description: "Company size id" },
      { name: "companyName", in: "body", type: "string", description: "Current company name" },
      { name: "domain", in: "body", type: "string", description: "Current company domain" },
      { name: "count", in: "body", type: "number", description: "Page size (default 25)" },
      { name: "pages", in: "body", type: "number", description: "Pages to fetch" },
    ],
    response: [
      { field: "total", type: "number", description: "Reported match count" },
      { field: "hits[]", type: "object[]", description: "Name, title, company, domain, linkedin, location" },
      { field: "sources", type: "string[]", description: "sn / theorg / serp …" },
    ],
    curl: `curl -s -X POST "https://{host}/api/v2/discover/people" -H "content-type: application/json" -d '{"keywords":"marketing","hqGeoId":"103644278"}'`,
  },
  {
    id: "discover-companies",
    group: "Discover",
    method: "POST",
    path: "/api/v2/discover/companies",
    title: "Discover companies",
    summary: "Company search with HQ, industry, size, keywords.",
    description:
      "Same filters as the Discover companies tab. Returns name, domain, industry, size, HQ.",
    params: [
      { name: "keywords", in: "body", type: "string", description: "Company keywords" },
      { name: "hqGeoId", in: "body", type: "string", description: "HQ geo id" },
      { name: "industryId", in: "body", type: "string", description: "Industry id" },
      { name: "sizeId", in: "body", type: "string", description: "Size id" },
      { name: "count", in: "body", type: "number", description: "Page size" },
    ],
    response: [
      { field: "total", type: "number", description: "Reported match count" },
      { field: "hits[]", type: "object[]", description: "Name, domain, industry, size, location" },
    ],
    curl: `curl -s -X POST "https://{host}/api/v2/discover/companies" -H "content-type: application/json" -d '{"keywords":"saas","hqGeoId":"103644278"}'`,
  },
  {
    id: "maps-search",
    group: "Maps",
    method: "POST",
    path: "/api/v2/maps/search",
    title: "Maps leads",
    summary: "Local business search (name, phone, website, category, geo).",
    description:
      "Google-Maps-style local lead pull. Text query or place types + location. Returns up to 1000 when they exist.",
    params: [
      { name: "mode", in: "body", required: true, type: '"text" | "types"', description: "Search mode", example: "text" },
      { name: "query", in: "body", type: "string", description: "Text query (mode=text)", example: "dentists" },
      { name: "location", in: "body", required: true, type: "string", description: "City / area", example: "Gurugram" },
      { name: "includeTypes", in: "body", type: "string[]", description: "OSM/Maps types when mode=types" },
      { name: "limit", in: "body", type: "number", description: "Max results (default 200, cap 1000)" },
    ],
    response: [
      { field: "leads[]", type: "object[]", description: "Name, category, address, phone, website, domain, geo, rating" },
      { field: "total", type: "number", description: "Returned count" },
    ],
    curl: `curl -s -X POST "https://{host}/api/v2/maps/search" -H "content-type: application/json" -d '{"mode":"text","query":"dentists","location":"Gurugram","limit":50}'`,
  },
  {
    id: "signals-monitors",
    group: "Signals",
    method: "GET",
    path: "/api/v2/signals/monitors",
    title: "List signal monitors",
    summary: "Catalog + saved monitors (topic intent, job change, hire, posting, promotion, news, custom).",
    description:
      "Clay-style signal monitors. Topic intent uses Google News + Reddit volume. Jobs use LinkedIn jobs-guest. News/fundraising/job-change/promotion use live news + SERP. Custom: RSS, Google Search, Maps, Apify/Phantombuster JSON URLs.",
    params: [],
    response: [
      { field: "catalog[]", type: "object[]", description: "Monitor kinds" },
      { field: "monitors[]", type: "object[]", description: "Saved monitors" },
    ],
    curl: `curl -s "https://{host}/api/v2/signals/monitors"`,
  },
  {
    id: "signals-run",
    group: "Signals",
    method: "POST",
    path: "/api/v2/signals/run",
    title: "Run a signal monitor",
    summary: "Live pull for one saved monitor. Returns events (SPIKE tagged on topic intent).",
    description: "Pass the monitor id from POST /api/v2/signals/monitors.",
    params: [
      { name: "id", in: "body", required: true, type: "string", description: "Monitor id", example: "sig_xxx" },
    ],
    response: [
      { field: "events[]", type: "object[]", description: "entity, title, url, source, topic, spike, score" },
      { field: "ms", type: "number", description: "Runtime" },
    ],
    curl: `curl -s -X POST "https://{host}/api/v2/signals/run" -H "content-type: application/json" -d '{"id":"sig_xxx"}'`,
  },
  {
    id: "icp-find",
    group: "ICP",
    method: "POST",
    path: "/api/v2/icp/find",
    title: "ICP Finder (SparkToro-style)",
    summary: "Revenue-weighted audience report: hangouts, podcasts, keywords, titles — not a generic persona.",
    description:
      "Pass your website, a brief, paying customers (domain + ACV) and competitors. Weights every signal by who paid. Sources: customer/competitor crawl, LinkedIn jobs, tech headers, iTunes podcasts, Google autocomplete, HN, YouTube/Reddit/G2 via news, press overlap.",
    params: [
      { name: "website", in: "body", required: true, type: "string", description: "Your domain", example: "kubex.ai" },
      { name: "brief", in: "body", type: "string", description: "What you sell" },
      { name: "customers", in: "body", type: "object[]", description: "{ domain, acv, name? }" },
      { name: "competitors", in: "body", type: "string[]", description: "Competitor domains" },
    ],
    response: [
      { field: "segments[]", type: "object[]", description: "ACV-weighted clusters" },
      { field: "demographics", type: "object", description: "titles, seniority, locations" },
      { field: "websites / social / youtube / podcasts / reddit / keywords / apps / bioPhrases", type: "object[]", description: "Affinity rows with pct + 0-100 score" },
      { field: "takeAction[]", type: "string[]", description: "Where to show up" },
    ],
    curl: `curl -s -X POST "https://{host}/api/v2/icp/find" -H "content-type: application/json" -d '{"website":"kubex.ai","brief":"Kubernetes cost optimization","customers":[{"domain":"ghd.com","acv":80000}],"competitors":["cast.ai"]}'`,
  },
  {
    id: "catalog",
    group: "Meta",
    method: "GET",
    path: "/api/v2",
    title: "API catalog",
    summary: "Machine-readable list of every public v2 endpoint.",
    description: "Returns this catalog (groups, paths, params, response fields) as JSON.",
    params: [],
    response: [
      { field: "version", type: "string", description: "API version" },
      { field: "endpoints[]", type: "object[]", description: "Full catalog" },
    ],
    curl: `curl -s "https://{host}/api/v2"`,
  },
];

export const API_GROUPS = [...new Set(API_ENDPOINTS.map((e) => e.group))];
