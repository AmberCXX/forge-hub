/**
 * Echo Channel · Forge Hub 最小示例插件
 *
 * 不依赖任何外部平台——起一个本地 HTTP server：
 *   POST /inbound    { fromId, from, content }   → hub.pushMessage
 *   send(...)        → 写 /tmp/echo-channel-out.log
 *
 * 目的：让外部贡献者在半小时内跑通"入站 → 出站"链路，
 * 无需申请 API key、无需连真实平台。
 *
 * 部署到运行时（文件名随意——loader 走 auto-detect plugin shape，
 * export default 不是完整 ChannelPlugin 会被视为 helper module）：
 *   cp examples/echo.ts ~/.forge-hub/channels/echo.ts
 *
 * 参考 hub-docs/channel-plugin-guide.md 的完整解释。
 */

import fs from "node:fs";
import type { ChannelPlugin, HubAPI, SendParams, SendResult } from "../hub-server/types.js";
import { recordUnauthorizedEvidence } from "../hub-server/evidence.js";

const PORT = 8787;
const OUT_LOG = "/tmp/echo-channel-out.log";

// 模块级状态——start 时赋值，stop 时清理。
// 热重载会 new 一个模块实例，旧的靠 stop() 释放 server / timer。
let hub: HubAPI;
let server: ReturnType<typeof Bun.serve> | null = null;

// ── Plugin ──────────────────────────────────────────────────────────────────
// Allowlist 读取不用自己写——HubAPI 提供 hub.isAllowed() 和 hub.getNickname()。
// schema 说明见 guide §4。

const plugin: ChannelPlugin = {
  name: "echo",
  displayName: "Echo",
  aliases: ["e"],
  capabilities: ["text", "file"],
  formatHints: "纯文本，不支持 Markdown 或富文本格式。",

  async start(hubAPI) {
    hub = hubAPI;

    // 起一个 bun HTTP server 模拟外部平台 webhook
    server = Bun.serve({
      port: PORT,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/inbound" && req.method === "POST") {
          let body: { fromId?: string; from?: string; content?: string };
          try {
            body = await req.json() as typeof body;
          } catch {
            return new Response("bad json", { status: 400 });
          }

          const senderId = body.fromId ?? "unknown";
          const displayName = body.from ?? senderId;
          const content = body.content ?? "";
          if (!content) return new Response("empty content", { status: 400 });

          // ── 非主人处理（evidence + security event + 静默丢弃）── 见 guide §4
          if (!hub.isAllowed(senderId)) {
            // 1. 写 evidence vault（磁盘落盘，fh hub security evidence 可查）
            const evidence = recordUnauthorizedEvidence({
              channel: plugin.name,
              ingestMode: "http",           // echo 通道的入站方式是 HTTP POST
              updateId: String(Date.now()), // echo 没有平台侧 update ID，用时间戳代替
              chatId: senderId,
              messageId: null,
              sourceUserId: senderId,
              contentType: "text",
              contentMeta: {},
              rawJson: JSON.stringify(body),
              displayName,
              logError: (m) => hub.logError(m),
            });

            // 2. 记录聚合安全事件（Hub 层限频，最多 1 条/小时极简提醒推给 agent）
            hub.recordSecurityEvent({
              sourceUserId: senderId,
              contentType: "text",
              evidenceId: evidence?.evidence_id ?? "",
            });

            // 3. 静默丢弃——不 pushMessage，不回复外部发送者
            return new Response("ok", { status: 200 });
          }

          const nick = hub.getNickname(senderId);
          hub.log(`← ${nick}: ${content.slice(0, 80)}`);
          hub.pushMessage({
            channel: "echo",
            from: nick,
            fromId: senderId,
            content,
            raw: { received_at: Date.now() },
          });
          return new Response("ok");
        }

        if (url.pathname === "/health") {
          return new Response(JSON.stringify({ channel: "echo", port: PORT }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("not found", { status: 404 });
      },
    });

    hub.log(`Echo server listening on :${PORT} (POST /inbound)`);
    hub.log(`出站会写入 ${OUT_LOG}`);
  },

  async send({ to, content, type, filePath }: SendParams): Promise<SendResult> {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        to,
        type,
        content: content.slice(0, 200),
        filePath: filePath ?? null,
      }) + "\n";

      if (type === "text" || type === "file") {
        fs.appendFileSync(OUT_LOG, line);
        hub.log(`→ ${to}: [${type}] ${content.slice(0, 60)}`);
        return { success: true };
      }

      return { success: false, error: `echo 不支持 type=${type}` };
    } catch (err) {
      hub.logError(`echo.send 失败: ${String(err)}`);
      return { success: false, error: String(err) };
    }
  },

  async stop() {
    if (server) {
      server.stop(true);
      server = null;
    }
    hub?.log("Echo server 已停止");
  },
};

export default plugin;
