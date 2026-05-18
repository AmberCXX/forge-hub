import { isSearchEnabled, searchHistory } from "../search.js";

export function handleSearch(req: Request): Response {
  if (!isSearchEnabled()) {
    return Response.json({ success: false, error: "search_index 未启用。在 hub-config.json 中设置 search_index: true" }, { status: 503 });
  }

  const url = new URL(req.url);
  const query = url.searchParams.get("q");
  if (!query) return Response.json({ success: false, error: "缺少 q 参数" }, { status: 400 });

  const channel = url.searchParams.get("channel") ?? undefined;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);
  const sinceTs = url.searchParams.get("since") ?? undefined;

  const results = searchHistory(query, { channel, limit, sinceTs });
  return Response.json({ results, count: results.length });
}
