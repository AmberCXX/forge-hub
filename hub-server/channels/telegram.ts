/**
 * Telegram 通道插件 — Forge Hub
 *
 * 直接调 Telegram Bot API，不依赖 grammy。
 * 长轮询 + 看门狗 + 指数退避 + 错误分类。
 */

import { ChannelStartSkipError } from "../types.js";
import type { ChannelPlugin, HubAPI, SendResult } from "../types.js";
import { ChannelHealth } from "../channel-health.js";
import { isNetworkError, SEND_RETRY_DELAY_MS } from "../send-retry.js";
import { recordUnauthorizedEvidence } from "../evidence.js";
import fsMod from "node:fs";
import pathMod from "node:path";
import { assertRealPathInsideDir, sanitizeMediaFileName } from "../media-path.js";
import { writeResponseToFileWithMediaLimit } from "../media-policy.js";
import { STATE_DIR } from "../config.js";

// ── Module State ────────────────────────────────────────────────────────────

let hub: HubAPI;
let botToken = "";

// redteam r2 L1 defense-in-depth: 本 channel plugin 内所有 log / error 字符串
// 过一遍 redactToken 再喂 hub.logError。当前 Bun fetch / Telegram API error
// message 不含 bot token（verified），但 Bun/Node 更新可能改 error format,
// Error.cause / AggregateError 未来也可能带 URL——defense-in-depth 把窗口锁死。
// C1 的 recordChannelError 守护 lastError 下游；本函数守护 plugin 本地 log 文件。
function redactToken(s: string): string {
  return botToken ? s.split(botToken).join("<REDACTED_TOKEN>") : s;
}

// ── Telegram API ────────────────────────────────────────────────────────────

// Telegram 代理：读 https_proxy / http_proxy env。以前硬编码 127.0.0.1:7897 作为用户本机的 Clash 默认，
// 开源后别人不一定有这个代理，所以 default 留空——空字符串 = 不设 proxy，直连 Telegram API。
// 用户本机的代理通过 launchd plist 的 EnvironmentVariables 注入。
const PROXY_URL = process.env.https_proxy || process.env.http_proxy || "";

async function tgApi(method: string, body?: Record<string, unknown>): Promise<any> {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const opts: RequestInit & { proxy?: string; signal?: AbortSignal } = {
    signal: AbortSignal.timeout(15_000),
  };
  if (body) {
    opts.method = "POST";
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  if (PROXY_URL) opts.proxy = PROXY_URL;
  const res = await fetch(url, opts);
  const data = await res.json() as { ok: boolean; result?: any; description?: string };
  if (!data.ok) throw new Error(data.description ?? `API error: ${method}`);
  return data.result;
}

// Fetch with hard timeout + AbortController — for getUpdates only
let pollAbortController: AbortController | null = null;

async function tgApiPolling(body: Record<string, unknown>, timeoutMs: number): Promise<any> {
  pollAbortController = new AbortController();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([pollAbortController.signal, timeoutSignal]);

  const url = `https://api.telegram.org/bot${botToken}/getUpdates`;
  const fetchOpts: Record<string, unknown> = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: combined,
    timeout: false, // Disable Bun's built-in 5-min idle timeout
  };
  if (PROXY_URL) fetchOpts.proxy = PROXY_URL;
  const res = await fetch(url, fetchOpts as any);

  const data = await res.json() as {
    ok: boolean; result?: any; description?: string;
    error_code?: number; parameters?: { retry_after?: number };
  };
  if (!data.ok) {
    const err = new Error(data.description ?? "getUpdates error") as any;
    err.error_code = data.error_code;
    err.parameters = data.parameters;
    throw err;
  }
  return data.result;
}

// ── Allowlist ───────────────────────────────────────────────────────────────


// ── Media Download ──────────────────────────────────────────────────────────

const TG_MEDIA_DIR = pathMod.join(STATE_DIR, "telegram", "media");

async function downloadTgFile(fileId: string, fileName: string): Promise<string | null> {
  try {
    const file = await tgApi("getFile", { file_id: fileId }) as { file_path?: string };
    if (!file.file_path) return null;
    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const res = await fetch(url, (PROXY_URL ? { proxy: PROXY_URL } : {}) as any);
    if (!res.ok) return null;
    await fsMod.promises.mkdir(TG_MEDIA_DIR, { recursive: true });
    const safeName = sanitizeMediaFileName(fileName);
    const filePath = pathMod.join(TG_MEDIA_DIR, safeName);
    await writeResponseToFileWithMediaLimit(res, filePath, `Telegram 媒体 ${safeName}`);
    await assertRealPathInsideDir(TG_MEDIA_DIR, filePath);
    hub.log(`📎 下载: ${safeName}`);
    return filePath;
  } catch (err) {
    hub.logError(`媒体下载失败: ${redactToken(String(err))}`);
    return null;
  }
}

// ── Polling Constants ──────────────────────────────────────────────────────

const POLL_TIMEOUT_S = 30;              // Telegram long-poll timeout
const FETCH_HARD_TIMEOUT_MS = 45_000;   // Must exceed POLL_TIMEOUT_S * 1000
const WATCHDOG_INTERVAL_MS = 60_000;    // Check liveness every 60s
const WATCHDOG_STALL_MS = 90_000;       // 90s no success → force restart
const HEARTBEAT_EVERY_N = 50;           // Log heartbeat every N polls (~25 min)

// ── Polling State ──────────────────────────────────────────────────────────

let polling = false;
let shouldStop = false;
let offset = 0;
let pollCount = 0;
let msgCount = 0;
let lastSuccessfulPollAt = 0;
let lastError = "";
let disconnectedAt = 0;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let health: ChannelHealth;

// ── Error Classification ───────────────────────────────────────────────────

interface ClassifiedError {
  type: "network" | "conflict" | "auth" | "ratelimit" | "server" | "unknown";
  retryable: boolean;
  retryAfter?: number;
}

function classifyError(err: unknown): ClassifiedError {
  const errObj = err as any;
  const code = errObj?.error_code;
  const msg = String(err).toLowerCase();

  // conflict (409): 另一个 polling 实例在跑。不硬停——等 35s 后重试，
  // 对方停后我们接上；两台抢的 case 用户从 log 看到"一直 conflict"去排查。
  if (code === 409) return { type: "conflict", retryable: true, retryAfter: 35 };
  if (code === 401) return { type: "auth", retryable: false };
  if (code === 429) {
    return { type: "ratelimit", retryable: true, retryAfter: errObj?.parameters?.retry_after ?? 5 };
  }
  if (code && code >= 500) return { type: "server", retryable: true };
  if (msg.includes("abort") || msg.includes("socket") || msg.includes("connect") ||
      msg.includes("network") || msg.includes("fetch") || msg.includes("econnr") ||
      msg.includes("timeout") || msg.includes("failed to fetch") ||
      msg.includes("unable to connect")) {
    return { type: "network", retryable: true };
  }
  return { type: "unknown", retryable: true };
}

// ── Watchdog ───────────────────────────────────────────────────────────────

function startWatchdog(): void {
  stopWatchdog();
  watchdogTimer = setInterval(() => {
    if (!polling || shouldStop) return;
    const since = Date.now() - lastSuccessfulPollAt;
    if (lastSuccessfulPollAt > 0 && since > WATCHDOG_STALL_MS) {
      hub.logError(`🐕 看门狗: ${Math.round(since / 1000)}s 无成功轮询，强制中断`);
      pollAbortController?.abort();
    }
  }, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog(): void {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

// ── Polling Loop ────────────────────────────────────────────────────────────

async function startPolling(): Promise<void> {
  polling = true;
  shouldStop = false;
  lastSuccessfulPollAt = Date.now();

  hub.log("开始 Telegram 长轮询...");
  startWatchdog();

  while (!shouldStop) {
    try {
      const updates = await tgApiPolling({
        offset,
        timeout: POLL_TIMEOUT_S,
        allowed_updates: ["message"],
      }, FETCH_HARD_TIMEOUT_MS) as any[];

      // ── Success ────────────────────────────────────────────
      lastSuccessfulPollAt = Date.now();
      health.onSuccess();
      disconnectedAt = 0;
      pollCount++;

      if (pollCount % HEARTBEAT_EVERY_N === 0) {
        hub.log(`💓 轮询正常 · 累计 ${pollCount} 次轮询，${msgCount} 条消息`);
      }

      for (const update of updates) {
        offset = update.update_id + 1;

        const msg = update.message;
        if (!msg) continue;

        const chatId = String(msg.chat.id);
        const from = msg.from;
        const rawDisplayName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || chatId;

        if (!hub.isAllowed(chatId)) {
          const contentType = msg.text ? "text" : msg.photo ? "photo" : msg.document ? "document"
            : msg.voice ? "voice" : msg.sticker ? "sticker" : msg.video ? "video"
            : msg.animation ? "animation" : msg.contact ? "contact" : msg.location ? "location" : "unknown";
          const contentMeta: Record<string, unknown> = { content_type: contentType };
          if (msg.document) {
            contentMeta.file_id = msg.document.file_id;
            contentMeta.file_unique_id = msg.document.file_unique_id;
            contentMeta.file_name = msg.document.file_name;
            contentMeta.mime_type = msg.document.mime_type;
            contentMeta.file_size = msg.document.file_size;
          } else if (msg.photo) {
            const largest = msg.photo[msg.photo.length - 1];
            contentMeta.file_id = largest.file_id;
            contentMeta.file_unique_id = largest.file_unique_id;
            contentMeta.file_size = largest.file_size;
          } else if (msg.voice) {
            contentMeta.file_id = msg.voice.file_id;
            contentMeta.file_unique_id = msg.voice.file_unique_id;
            contentMeta.mime_type = msg.voice.mime_type;
            contentMeta.file_size = msg.voice.file_size;
          } else if (msg.sticker) {
            contentMeta.file_id = msg.sticker.file_id;
            contentMeta.file_unique_id = msg.sticker.file_unique_id;
            contentMeta.emoji = msg.sticker.emoji;
          } else if (msg.video) {
            contentMeta.file_id = msg.video.file_id;
            contentMeta.file_unique_id = msg.video.file_unique_id;
            contentMeta.mime_type = msg.video.mime_type;
            contentMeta.file_size = msg.video.file_size;
          }
          if (msg.caption) contentMeta.caption_length = msg.caption.length;
          if (msg.forward_origin) contentMeta.has_forward_origin = true;
          if (msg.reply_to_message) contentMeta.has_reply = true;
          if (msg.media_group_id) contentMeta.media_group_id = msg.media_group_id;

          recordUnauthorizedEvidence({
            channel: "telegram",
            ingestMode: "getUpdates",
            updateId: String(update.update_id),
            chatId,
            messageId: msg.message_id ? String(msg.message_id) : null,
            sourceUserId: from?.id ? String(from.id) : null,
            contentType,
            contentMeta,
            rawJson: JSON.stringify(update),
            displayName: rawDisplayName,
            logError: (m) => hub.logError(redactToken(m)),
          });
          continue;
        }

        let content = "";
        if (msg.text) {
          content = msg.text;
        } else if (msg.photo) {
          const filePath = await downloadTgFile(msg.photo[msg.photo.length - 1].file_id, `photo_${Date.now()}.jpg`);
          content = filePath ? `${msg.caption ?? "[图片]"}\n[图片] ${filePath}` : msg.caption ?? "[图片]";
        } else if (msg.document) {
          const fileName = msg.document.file_name ?? "file";
          const filePath = await downloadTgFile(msg.document.file_id, fileName);
          content = filePath ? `${msg.caption ?? ""}\n[文件] ${filePath}`.trim() : msg.caption ?? `[文件: ${fileName}]`;
        } else if (msg.voice) {
          const filePath = await downloadTgFile(msg.voice.file_id, `voice_${Date.now()}.ogg`);
          if (filePath) {
            // Hub 层 ASR：plugin 自带 > FORGE_HUB_ASR_HOOK > null。没识别到 text 就给 path 占位让 agent 知道是语音
            const text = await hub.resolveAsr(filePath);
            content = text ? `[语音] ${text}` : `[语音] ${filePath}`;
          } else {
            content = "[语音消息]";
          }
        } else if (msg.sticker) {
          content = `[贴纸: ${msg.sticker.emoji ?? ""}]`;
        } else {
          continue;
        }

        msgCount++;
        hub.log(`← ${rawDisplayName}: ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`);

        hub.pushMessage({
          channel: "telegram",
          from: rawDisplayName,
          fromId: chatId,
          content,
          raw: { message_id: msg.message_id, username: from?.username ?? "" },
        });
      }
    } catch (err) {
      if (shouldStop) break;

      const classified = classifyError(err);
      lastError = redactToken(String(err));
      if (disconnectedAt === 0) disconnectedAt = Date.now();

      if (!classified.retryable) {
        hub.logError(`❌ 不可恢复错误（类型: ${classified.type}）: ${lastError}`);
        plugin.stoppedReason = classified.type === "auth" ? "auth" : "config";
        break;
      }

      // Rate limit / conflict: respect Telegram's retry_after
      if (classified.type === "ratelimit" || classified.type === "conflict") {
        const tgDelay = (classified.retryAfter ?? 35) * 1000;
        if (classified.type === "conflict") {
          hub.logError("  → 另一个 Bot 实例在轮询同一个 token，等待后重试");
        }
        hub.logError(`轮询异常（类型: ${classified.type}）: ${lastError}`);
        hub.logError(`  → ${Math.round(tgDelay / 1000)}s 后重试`);
        await new Promise((r) => setTimeout(r, tgDelay));
        continue;
      }

      if (!health.isDormant()) {
        hub.logError(`轮询异常（类型: ${classified.type}）: ${lastError}`);
      }

      const delay = await health.onFailure();
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  stopWatchdog();
  pollAbortController?.abort();
  pollAbortController = null;
  polling = false;
  hub.log("Telegram 轮询已停止");
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const plugin: ChannelPlugin = {
  name: "telegram",
  displayName: "Telegram",
  aliases: ["tg"],
  capabilities: ["text", "file", "image", "voice"],
  // Telegram chat_id 是纯数字（user / group 都是）。5+ 位避开单位数 typo
  isNativeId(to) { return /^-?\d{5,}$/.test(to); },

  async start(hubAPI) {
    hub = hubAPI;

    const config = hub.getState("config") as { bot_token?: string } | null;
    botToken = config?.bot_token ?? "";
    if (!botToken) {
      hub.logError("未找到 Telegram bot token。请编辑 ~/.forge-hub/state/telegram/config.json");
      throw new ChannelStartSkipError("未配置 Telegram bot token");
    }

    health = new ChannelHealth({
      name: "telegram",
      onRestart: async () => {
        hub.log("[telegram] 完整重启：stop polling → restart");
        shouldStop = true;
        pollAbortController?.abort();
        let wait = 0;
        while (polling && wait < 10) { await new Promise(r => setTimeout(r, 500)); wait++; }
        startPolling();
      },
      log: (msg) => hub.log(msg),
    });

    try {
      const me = await tgApi("getMe");
      hub.log(`Bot: @${me.username} (${me.first_name})`);
    } catch (err) {
      hub.logError(`Bot 验证失败: ${redactToken(String(err))}。将在轮询中重试。`);
    }

    startPolling();
  },

  async send({ to, content, type, filePath }): Promise<SendResult> {
    if (!botToken) return { success: false, error: "bot 未初始化" };

    try {
      if (type === "text") {
        await tgApi("sendMessage", { chat_id: to, text: content });
        hub.log(`→ ${to}: ${content.slice(0, 60)}`);
        return { success: true };
      }

      if (type === "file" && filePath) {
        if (filePath.startsWith("http")) {
          await tgApi("sendDocument", { chat_id: to, document: filePath, caption: content || undefined });
        } else {
          const fileBuffer = await fsMod.promises.readFile(filePath);
          const form = new FormData();
          form.append("chat_id", to);
          form.append("document", new Blob([fileBuffer]), filePath.split("/").pop());
          if (content) form.append("caption", content);
          const docOpts: Record<string, unknown> = { method: "POST", body: form };
          if (PROXY_URL) docOpts.proxy = PROXY_URL;
          const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, docOpts as any);
          const data = await res.json() as { ok: boolean; description?: string };
          if (!data.ok) throw new Error(data.description ?? "upload failed");
        }
        hub.log(`→ 文件: ${filePath.slice(0, 60)}`);
        return { success: true };
      }

      if (type === "voice" && filePath) {
        const voiceBuffer = await fsMod.promises.readFile(filePath);
        const form = new FormData();
        form.append("chat_id", to);
        form.append("voice", new Blob([voiceBuffer]), "voice.ogg");
        const voiceOpts: Record<string, unknown> = { method: "POST", body: form };
        if (PROXY_URL) voiceOpts.proxy = PROXY_URL;
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendVoice`, voiceOpts as any);
        const data = await res.json() as { ok: boolean; description?: string };
        if (!data.ok) throw new Error(data.description ?? "sendVoice failed");
        hub.log(`→ 语音: "${content.slice(0, 30)}..."`);
        return { success: true };
      }

      return { success: false, error: `不支持的类型: ${type}` };
    } catch (err) {
      const raw = String(err);

      if (isNetworkError(raw)) {
        hub.logError(`发送失败（网络），${SEND_RETRY_DELAY_MS / 1000}s 后重试: ${redactToken(raw)}`);
        await new Promise(r => setTimeout(r, SEND_RETRY_DELAY_MS));
        try {
          if (type === "text") {
            await tgApi("sendMessage", { chat_id: to, text: content });
          } else if (type === "file" && filePath) {
            await tgApi("sendDocument", { chat_id: to, document: filePath, caption: content || undefined });
          } else if (type === "voice" && filePath) {
            const voiceBuffer = await fsMod.promises.readFile(filePath);
            const form = new FormData();
            form.append("chat_id", to);
            form.append("voice", new Blob([voiceBuffer]), "voice.ogg");
            const voiceOpts: Record<string, unknown> = { method: "POST", body: form };
            if (PROXY_URL) voiceOpts.proxy = PROXY_URL;
            const res = await fetch(`https://api.telegram.org/bot${botToken}/sendVoice`, voiceOpts as any);
            const data = await res.json() as { ok: boolean; description?: string };
            if (!data.ok) throw new Error(data.description ?? "sendVoice failed");
          }
          hub.log(`→ 重试成功`);
          return { success: true };
        } catch (retryErr) {
          hub.logError(`重试也失败: ${redactToken(String(retryErr))}`);
          return { success: false, error: `[Telegram 通道] 发送失败——Hub 到 Telegram API 的连接中断。已重试 1 次仍未恢复，建议稍后重试。` };
        }
      }

      hub.logError(`发送失败 (type=${type}, to=${to}): ${redactToken(raw)}`);
      return { success: false, error: `[Telegram 通道] 发送失败——${redactToken(raw)}` };
    }
  },

  async stop() {
    shouldStop = true;
    pollAbortController?.abort(); // Instantly cancel in-flight getUpdates
    hub.log("停止 Telegram 轮询...");
    const deadline = Date.now() + 5000;
    while (polling && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  },
};

export default plugin;
