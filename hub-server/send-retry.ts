export function isNetworkError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes("socket") || lower.includes("fetch failed") ||
    lower.includes("econnreset") || lower.includes("econnrefused") ||
    lower.includes("etimedout") || lower.includes("epipe");
}

export function isILinkRejection(msg: string): boolean {
  return msg.includes("sendmessage 失败");
}

export const SEND_RETRY_DELAY_MS = 3000;
