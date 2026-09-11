/**
 * PDL / Apollo job-title taxonomy from the live title string.
 * Roles/levels match People Data Labs canonical enums.
 */

export type TitleTaxonomy = {
  role: string | null;
  subRole: string | null;
  levels: string[];
  titleClass: string | null;
  department: string | null;
  seniority: string | null;
  onetCode: string | null;
  onetMajor: string | null;
  onetSpecific: string | null;
};

const LEVELS: Array<[RegExp, string]> = [
  [/\b(founder|co-?founder|owner|proprietor)\b/i, "owner"],
  [/\b(managing partner|general partner|\bpartner\b)\b/i, "partner"],
  [/\b(chief|ceo|cto|cfo|coo|cio|cmo|ciso|cpo|chro|\bcxo\b)\b/i, "cxo"],
  [/\b(vice president|\bev[p]\b|\bsvp\b|\bvp\b)\b/i, "vp"],
  [/\b(director|head of|gm\b|general manager|leader|head)\b/i, "director"],
  [/\b(manager|lead|supervisor|principal)\b/i, "manager"],
  [/\b(senior|sr\.?|staff|principal engineer)\b/i, "senior"],
  [/\b(intern|internship|trainee|apprentice)\b/i, "intern"],
  [/\b(junior|jr\.?|associate|entry)\b/i, "entry"],
];

const ROLES: Array<[RegExp, string, string, string, string]> = [
  // role, sub_role, department, onet
  [/\b(software|full[- ]?stack|backend|front[- ]?end|sre|devops|platform engineer|ml engineer|data engineer)\b/i, "engineering", "software", "Information Technology", "15-1252.00"],
  [/\b(data scientist|machine learning|artificial intelligence|research scientist)\b/i, "engineering", "data", "Research", "15-2051.00"],
  [/\b(product manager|product owner|product lead)\b/i, "product", "product_management", "Product Management", "11-2021.00"],
  [/\b(sales|account executive|\bae\b|business development|revenue)\b/i, "sales", "account_executive", "Sales", "41-4011.00"],
  [/\b(marketing|growth|brand|demand gen|content marketer)\b/i, "marketing", "marketing", "Marketing", "11-2021.00"],
  [/\b(designer|ux|ui|product design|brand design)\b/i, "design", "product_design", "Arts and Design", "27-1024.00"],
  [/\b(finance|controller|treasur|accountant|fp&a)\b/i, "finance", "finance", "Finance", "13-2011.00"],
  [/\b(\bhr\b|people ops|talent|recruiter|human resources)\b/i, "human_resources", "recruiting", "Human Resources", "13-1071.00"],
  [/\b(counsel|attorney|legal|compliance)\b/i, "legal", "legal", "Legal", "23-1011.00"],
  [/\b(operations|delivery|program manager|project manager)\b/i, "operations", "project_management", "Operations", "11-1021.00"],
  [/\b(customer success|support|helpdesk|solutions consultant|implementation specialist|onboarding)\b/i, "support", "customer_success", "Support", "43-4051.00"],
  [/\b(consultant|advisor|advisory)\b/i, "professional_service", "consulting", "Consulting", "13-1111.00"],
  [/\b(teacher|professor|lecturer|principal|dean)\b/i, "education", "education", "Education", "25-1000.00"],
  [/\b(nurse|physician|doctor|clinical|pharmacist)\b/i, "health", "health", "Healthcare Services", "29-1141.00"],
  [/\b(realtor|broker|real estate)\b/i, "real_estate", "real_estate", "Real Estate", "41-9022.00"],
  [/\b(founder|co-?founder|owner|proprietor)\b/i, "operations", "general_management", "Entrepreneurship", "11-1011.00"],
  [/\b(ceo|chief executive|president|chairman)\b/i, "operations", "general_management", "Entrepreneurship", "11-1011.00"],
  [/\b(cto|chief technology|vp engineering|svp engineering)\b/i, "engineering", "engineering_management", "Information Technology", "11-3021.00"],
];

export function classifyTitle(title?: string | null): TitleTaxonomy {
  const t = (title ?? "").trim();
  if (!t) {
    return {
      role: null,
      subRole: null,
      levels: [],
      titleClass: null,
      department: null,
      seniority: null,
      onetCode: null,
      onetMajor: null,
      onetSpecific: null,
    };
  }
  const levels: string[] = [];
  for (const [re, lv] of LEVELS) if (re.test(t) && !levels.includes(lv)) levels.push(lv);
  let role: string | null = null;
  let subRole: string | null = null;
  let department: string | null = null;
  let onet = "";
  for (const [re, r, s, d, o] of ROLES) {
    if (re.test(t)) {
      role = r;
      subRole = s;
      department = d;
      onet = o;
      break;
    }
  }
  const seniority =
    levels.includes("cxo") || levels.includes("owner") || levels.includes("partner")
      ? "executive"
      : levels.includes("vp") || levels.includes("director")
        ? "director"
        : levels.includes("manager")
          ? "manager"
          : levels.includes("senior")
            ? "senior"
            : levels.includes("intern") || levels.includes("entry")
              ? "entry"
              : role
                ? "individual contributor"
                : null;
  const titleClass =
    seniority === "executive" || seniority === "director"
      ? "over_head"
      : role === "sales"
        ? "revenue"
        : role === "engineering" || role === "product" || role === "design"
          ? "r_and_d"
          : role
            ? "general"
            : null;
  return {
    role,
    subRole,
    levels,
    titleClass,
    department,
    seniority,
    onetCode: onet || null,
    onetMajor: onet ? onet.slice(0, 2) : null,
    onetSpecific: department,
  };
}

/** PDL-style inferred salary ranges from seniority × market. */
export function inferredSalary(
  levels: string[],
  country?: string | null,
): string | null {
  const c = (country ?? "").toLowerCase();
  let base = 90_000;
  if (levels.includes("intern") || levels.includes("entry")) base = 55_000;
  else if (levels.includes("senior") || levels.includes("manager")) base = 140_000;
  else if (levels.includes("director") || levels.includes("vp")) base = 200_000;
  else if (levels.includes("cxo") || levels.includes("owner") || levels.includes("partner"))
    base = 280_000;
  if (/india/.test(c)) base = Math.round(base * 0.28);
  else if (/united kingdom|england/.test(c)) base = Math.round(base * 0.75);
  else if (/canada/.test(c)) base = Math.round(base * 0.85);
  else if (/united states|usa/.test(c) === false && c) base = Math.round(base * 0.7);
  const lo = Math.round(base * 0.75 / 10_000) * 10_000;
  const hi = Math.round(base * 1.25 / 10_000) * 10_000;
  return `$${lo.toLocaleString()}-$${hi.toLocaleString()}`;
}
