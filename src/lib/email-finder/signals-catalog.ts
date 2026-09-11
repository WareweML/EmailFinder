export type SignalKind =
  | "topic_intent"
  | "job_change"
  | "new_hire"
  | "job_posting"
  | "promotion"
  | "news_fundraising"
  | "openmart"
  | "maps"
  | "store_leads"
  | "pitchbook"
  | "rss"
  | "google_search"
  | "phantombuster"
  | "apify";

export type SignalTarget = "companies" | "people";

export type SignalMonitor = {
  id: string;
  name: string;
  kind: SignalKind;
  target: SignalTarget;
  entities: string[];
  topics?: string[];
  query?: string;
  url?: string;
  location?: string;
  createdAt: number;
  lastRunAt?: number;
};

export type SignalEvent = {
  id: string;
  monitorId: string;
  kind: SignalKind;
  entity: string;
  title: string;
  url: string;
  snippet: string;
  source: string;
  topic?: string;
  happenedAt?: string;
  score?: number;
  spike?: boolean;
};

export const SIGNAL_CATALOG: Array<{
  id: SignalKind;
  group: string;
  label: string;
  hint: string;
  cost: string;
}> = [
  { id: "topic_intent", group: "People & companies", label: "Topic intent", hint: "Spike from GDELT + Wikipedia pageviews + OpenAlex/Crossref papers + HN + GitHub + news/Reddit — not a paid intent pixel.", cost: "live" },
  { id: "job_change", group: "People & companies", label: "Job change", hint: "SEC 8-K Item 5.02 + PR wires + news + HN.", cost: "live" },
  { id: "new_hire", group: "People & companies", label: "New hire", hint: "Appointed / joins as — SEC 8-K + wires + news.", cost: "live" },
  { id: "job_posting", group: "People & companies", label: "Job posting", hint: "Greenhouse/Lever/Ashby/SmartRecruiters + jobs-api ATS ledger + LinkedIn guest + RemoteOK.", cost: "live" },
  { id: "promotion", group: "People & companies", label: "Promotion", hint: "SEC 8-K + promoted/named VP across news and HN.", cost: "live" },
  { id: "news_fundraising", group: "People & companies", label: "News & fundraising", hint: "SEC Form D/S-1 + TechCrunch/Crunchbase news + GDELT + HN.", cost: "live" },
  { id: "openmart", group: "Company sourcing", label: "Monitor local businesses (OpenMart-style)", hint: "OSM / Maps local businesses in a city.", cost: "0.5" },
  { id: "maps", group: "Company sourcing", label: "Monitor local businesses (Google Maps)", hint: "Same Maps pull you already use in Finder.", cost: "~1" },
  { id: "store_leads", group: "Company sourcing", label: "Monitor companies with Store Leads", hint: "Tech / install signals from live site headers + jobs.", cost: "1" },
  { id: "pitchbook", group: "Company sourcing", label: "Monitor companies from PitchBook-style search", hint: "Public funding news (Crunchbase / TechCrunch / Google News). PitchBook itself is paid.", cost: "1" },
  { id: "rss", group: "Other", label: "Monitor RSS feed", hint: "Any Atom/RSS URL.", cost: "0" },
  { id: "google_search", group: "Other", label: "Monitor Google Search results", hint: "Live SERP for a saved query.", cost: "0" },
  { id: "phantombuster", group: "Other", label: "Monitor leads from Phantombuster", hint: "Poll a Phantom result JSON URL.", cost: "0" },
  { id: "apify", group: "Other", label: "Monitor data from Apify actor", hint: "Poll an Apify dataset or webhook JSON URL.", cost: "0" },
];
