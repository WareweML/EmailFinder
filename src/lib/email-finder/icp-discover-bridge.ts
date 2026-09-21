import type { IcpDiscoverQuery } from "./icp-to-discover";

const KEY = "mailgraph-icp-discover";
export const ICP_DISCOVER_EVENT = "mailgraph:open-discover";

export function writeIcpDiscoverQuery(q: IcpDiscoverQuery, opts?: { open?: boolean }) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(q));
  } catch {
    /* */
  }
  if (opts?.open !== false && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(ICP_DISCOVER_EVENT, { detail: q }));
  }
}

export function readIcpDiscoverQuery(): IcpDiscoverQuery | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as IcpDiscoverQuery;
  } catch {
    return null;
  }
}

export function clearIcpDiscoverAutoSearch() {
  const q = readIcpDiscoverQuery();
  if (!q?.autoSearch) return;
  writeIcpDiscoverQuery({ ...q, autoSearch: false }, { open: false });
}
