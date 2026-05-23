/**
 * 配置加载 + 热加载
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  CONFIG_FILE,
  SCHEDULE_DIR,
  STATE_DIR,
  DIR,
  log,
  logError,
} from "./config.js";
import type {
  ForgeConfig,
  RawScheduleEntry,
  ScheduleFile,
  ContactChannel,
  SemanticConfig,
  HeartbeatConfig,
  ReminderConfig,
  InstructionConfig,
  OneshotConfig,
} from "./types.js";

// ── Config Hashes (for change detection) ────────────────────────────────────

const configHashes = new Map<string, string>();

function fileHash(filePath: string): string {
  try {
    return crypto
      .createHash("md5")
      .update(fs.readFileSync(filePath, "utf-8"))
      .digest("hex");
  } catch {
    return "";
  }
}

function hasChanged(filePath: string): boolean {
  const newHash = fileHash(filePath);
  const oldHash = configHashes.get(filePath);

  // File deleted: had a hash before, now empty
  if (!newHash && oldHash) {
    configHashes.delete(filePath);
    return true;
  }
  // File doesn't exist and never did
  if (!newHash) return false;
  // Content unchanged
  if (oldHash === newHash) return false;
  // Content changed or new file
  configHashes.set(filePath, newHash);
  return true;
}

// ── Ensure Directories ──────────────────────────────────────────────────────

export function ensureDirs(): void {
  for (const dir of [DIR, SCHEDULE_DIR, STATE_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* ignore unsupported chmod */ }
  }
}

// ── Init Default Config ─────────────────────────────────────────────────────

export function initDefaultConfig(): void {
  if (fs.existsSync(CONFIG_FILE)) return;

  const defaultConfig: ForgeConfig = {
    enabled: true,
    scan_dir: true,
    contacts: {},
  };

  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(defaultConfig, null, 2),
    "utf-8",
  );
  log("生成默认 engine-config.json（编辑 contacts 添加联系人）");
}

// ── Load Config ─────────────────────────────────────────────────────────────

export function loadForgeConfig(): ForgeConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      configHashes.set(CONFIG_FILE, fileHash(CONFIG_FILE));
      return config;
    }
  } catch (err) {
    logError(`读取 engine-config.json 失败: ${String(err)}`);
  }
  return { enabled: true, scan_dir: true, contacts: {} };
}

// ── Time Parsing ───────────────────────────────────────────────────────────

export function parseTime(s: string): { hour: number; minute: number; second: number } {
  const parts = s.split(":").map(Number);
  const hour = Number.isFinite(parts[0]) ? parts[0] : 0;
  const minute = Number.isFinite(parts[1]) ? parts[1] : 0;
  const second = Number.isFinite(parts[2]) ? parts[2] : 0;
  return { hour, minute, second };
}

// ── Semantic Config → RawScheduleEntry[] ───────────────────────────────────

const DEFAULT_TEMPLATES: Record<string, string> = {
  heartbeat: "[heartbeat] {time}（{label}）\n\n{contacts}",
  reminder: "[提醒] {time}。{prompt}",
  instruction: "[指令] {prompt}",
  oneshot: "[提醒] {time}。{prompt}",
};

function expandHeartbeat(cfg: HeartbeatConfig, origin: string): RawScheduleEntry[] {
  const template = cfg.template ?? DEFAULT_TEMPLATES.heartbeat;
  const entries: RawScheduleEntry[] = [];

  const wakeup = parseTime(cfg.wakeup);
  entries.push({
    hour: wakeup.hour, minute: wakeup.minute, second: wakeup.second,
    template, label: "起床", sender: "heartbeat", _origin: origin, _entry_index: 0,
  });

  const sleep = parseTime(cfg.sleep);
  entries.push({
    hour: sleep.hour, minute: sleep.minute, second: sleep.second,
    template, label: "睡觉", sender: "heartbeat", _origin: origin, _entry_index: 1,
  });

  entries.push({
    hour: 0, minute: 0,
    expand: "random",
    active_start: cfg.active_start ?? 9,
    active_end: cfg.active_end ?? 24,
    daily_count: cfg.daily_count ?? 10,
    min_per_hour: cfg.min_per_hour ?? 1,
    template, sender: "heartbeat", _origin: origin, _entry_index: 2,
  });

  return entries;
}

interface TaskLike {
  time?: string;
  prompt?: string;
  label?: string;
  template?: string;
  sender?: string;
  handler?: string;
  weekdays?: number[];
  days?: number[];
  months?: number[];
  start_date?: string;
  end_date?: string;
  source?: "manual" | "ai";
  permission?: "auto" | "inform" | "confirm" | "strict";
}

function expandTaskList(
  cfg: ReminderConfig | InstructionConfig,
  origin: string,
): RawScheduleEntry[] {
  const type = cfg.type;
  const defaultTemplate = DEFAULT_TEMPLATES[type];
  const defaultSender = type === "instruction" ? "instruction" : "reminder";

  const items: TaskLike[] = cfg.tasks
    ? cfg.tasks
    : (cfg.time && cfg.prompt) ? [cfg as TaskLike] : [];

  return items.map((t, i) => {
    const time = parseTime(t.time ?? "0:00");
    return {
      hour: time.hour, minute: time.minute, second: time.second,
      template: t.template ?? defaultTemplate,
      sender: t.sender ?? defaultSender,
      handler: t.handler,
      prompt: t.prompt,
      label: t.label,
      weekdays: t.weekdays ?? cfg.weekdays,
      days: t.days ?? cfg.days,
      months: t.months ?? cfg.months,
      start_date: t.start_date ?? cfg.start_date,
      end_date: t.end_date ?? cfg.end_date,
      source: t.source ?? cfg.source,
      permission: t.permission,
      _origin: origin,
      _entry_index: i,
    } as RawScheduleEntry;
  });
}

function expandOneshot(cfg: OneshotConfig, origin: string): RawScheduleEntry[] {
  const time = parseTime(cfg.time);
  return [{
    hour: time.hour, minute: time.minute, second: time.second,
    template: cfg.template ?? DEFAULT_TEMPLATES.oneshot,
    sender: cfg.sender ?? "reminder",
    prompt: cfg.prompt,
    label: cfg.label,
    start_date: cfg.date,
    end_date: cfg.date,
    one_shot: true,
    source: cfg.source ?? "ai",
    _origin: origin,
    _entry_index: 0,
  }];
}

export function expandSemantic(data: SemanticConfig, origin: string): RawScheduleEntry[] {
  switch (data.type) {
    case "heartbeat": return expandHeartbeat(data, origin);
    case "reminder": return expandTaskList(data, origin);
    case "instruction": return expandTaskList(data, origin);
    case "oneshot": return expandOneshot(data, origin);
    default:
      logError(`未知 type "${(data as Record<string, unknown>).type}" in ${origin}，跳过`);
      return [];
  }
}

// ── Load Schedule Dir ───────────────────────────────────────────────────────

export function loadScheduleDir(): RawScheduleEntry[] {
  const entries: RawScheduleEntry[] = [];

  try {
    if (!fs.existsSync(SCHEDULE_DIR)) return entries;

    const files = fs
      .readdirSync(SCHEDULE_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();

    for (const file of files) {
      const filePath = path.join(SCHEDULE_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

        if (data.type) {
          for (const entry of expandSemantic(data as SemanticConfig, file)) {
            entries.push(entry);
          }
        } else {
          for (const [index, entry] of ((data as ScheduleFile).schedules ?? []).entries()) {
            entry._origin = file;
            entry._entry_index = index;
            entries.push(entry);
          }
        }

        configHashes.set(filePath, fileHash(filePath));
      } catch (err) {
        logError(`读取 ${file} 失败: ${String(err)}`);
      }
    }
  } catch (err) {
    logError(`扫描 engine.d/ 失败: ${String(err)}`);
  }

  return entries;
}

// ── Format Contacts ─────────────────────────────────────────────────────────

export function formatContacts(
  contacts: Record<string, Record<string, ContactChannel>>,
): string {
  const lines: string[] = ["可用通道："];

  for (const [name, channels] of Object.entries(contacts)) {
    for (const [channelName, info] of Object.entries(channels)) {
      lines.push(
        `- ${channelName}: 使用 ${info.tool} 工具，sender_id = "${info.sender_id}"`,
      );
    }
  }

  return lines.join("\n");
}

// ── Get primary sender_id ───────────────────────────────────────────────────

export function getPrimarySenderId(
  contacts: Record<string, Record<string, ContactChannel>>,
): string {
  for (const channels of Object.values(contacts)) {
    for (const info of Object.values(channels)) {
      return info.sender_id;
    }
  }
  return "";
}

// ── Config Watcher ──────────────────────────────────────────────────────────

export function startConfigWatcher(
  onReload: (changedOrigin: string | null) => void,
): void {
  // Watch engine-config.json → null means global config changed, full reload
  try {
    fs.watch(DIR, (_event, filename) => {
      if (!filename || filename !== "engine-config.json") return;
      if (!hasChanged(CONFIG_FILE)) return;
      log("🔄 hot-reload: engine-config.json 已变更");
      onReload(null);
    });
  } catch (err) {
    logError(`fs.watch DIR 失败: ${String(err)}`);
  }

  // Watch engine.d/ → pass changed filename so scheduler only re-schedules that origin
  try {
    fs.watch(SCHEDULE_DIR, (_event, filename) => {
      if (!filename || !filename.endsWith(".json")) return;
      const filePath = path.join(SCHEDULE_DIR, filename);
      if (!hasChanged(filePath)) return;
      log(`🔄 hot-reload: engine.d/${filename} 已变更`);
      onReload(filename);
    });
  } catch (err) {
    logError(`fs.watch engine.d/ 失败: ${String(err)}`);
  }

  log("👁 fs.watch: 监听配置变更");
}
