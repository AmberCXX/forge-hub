import fs from "node:fs";
import path from "node:path";

const DAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

export interface EnginePaths {
  engineDir: string;
  engineScheduleDir: string;
  engineLogFile: string;
  engineConfigFile: string;
}

export interface EngineScheduleSummary {
  file: string;
  line: string;
}

export interface EngineMatch {
  file: string;
  prompt: string;
  time: string;
}

export type EngineRemoveQueryValidation =
  | { ok: true }
  | { ok: false; reason: string };

export function getEnginePaths(
  home = process.env.HOME ?? "~",
  dataDir = process.env.FORGE_ENGINE_DATA,
): EnginePaths {
  const engineDir = dataDir ?? path.join(home, ".forge-hub", "engine-data");
  return {
    engineDir,
    engineScheduleDir: path.join(engineDir, "engine.d"),
    engineLogFile: path.join(engineDir, "engine-trigger-log.md"),
    engineConfigFile: path.join(engineDir, "engine-config.json"),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function formatScheduleEntry(
  file: string,
  s: Record<string, unknown>,
): EngineScheduleSummary[] {
  if (s.expand === "random") {
    return [{
      file,
      line: `${file} — 随机心跳（${s.active_start}:00-${s.active_end}:00，每天${s.daily_count}条）`,
    }];
  }

  const hour = s.hour as number ?? 0;
  const minute = s.minute as number ?? 0;
  const second = s.second as number | undefined;
  const time = `${pad2(hour)}:${pad2(minute)}${second ? `:${pad2(second)}` : ""}`;
  const tags: string[] = [];
  if (s.one_shot) tags.push("一次性");
  const weekdays = s.weekdays as number[] | undefined;
  const days = s.days as number[] | undefined;
  const months = s.months as number[] | undefined;
  if (weekdays?.length) tags.push(`每${weekdays.map((d) => `周${DAY_NAMES[d]}`).join("、")}`);
  if (days?.length) tags.push(`每月${days.join("、")}号`);
  if (months?.length) tags.push(`每年${months.map((m) => `${m}月`).join("、")}`);
  if (s.start_date) tags.push(`从${s.start_date}`);
  if (s.end_date) tags.push(`到${s.end_date}`);
  if (s.source === "ai") tags.push("动态");
  const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
  const prompt = s.prompt ? ` — ${String(s.prompt).slice(0, 60)}` : "";
  return [{
    file,
    line: `${file} @ ${time}${tagStr}${prompt}`,
  }];
}

function listSemanticFile(file: string, data: Record<string, unknown>): EngineScheduleSummary[] {
  const type = data.type as string;

  if (type === "heartbeat") {
    return [{
      file,
      line: `${file} — 心跳（起床 ${data.wakeup}，睡觉 ${data.sleep}，${data.active_start ?? 9}-${data.active_end ?? 24}时，每天${data.daily_count ?? 10}条）`,
    }];
  }

  if (type === "oneshot") {
    const prompt = String(data.prompt ?? "").slice(0, 60);
    return [{
      file,
      line: `${file} @ ${data.time} ${data.date} [一次性] — ${prompt}`,
    }];
  }

  if (type === "reminder" || type === "instruction") {
    const tasks = (data.tasks as Record<string, unknown>[] | undefined)
      ?? (data.time && data.prompt ? [data] : []);
    return tasks.map((t) => {
      const tags: string[] = [];
      const weekdays = (t.weekdays ?? data.weekdays) as number[] | undefined;
      const days = (t.days ?? data.days) as number[] | undefined;
      const months = (t.months ?? data.months) as number[] | undefined;
      const startDate = (t.start_date ?? data.start_date) as string | undefined;
      const endDate = (t.end_date ?? data.end_date) as string | undefined;
      if (weekdays?.length) tags.push(`每${weekdays.map((d) => `周${DAY_NAMES[d]}`).join("、")}`);
      if (days?.length) tags.push(`每月${days.join("、")}号`);
      if (months?.length) tags.push(`每年${months.map((m) => `${m}月`).join("、")}`);
      if (startDate) tags.push(`从${startDate}`);
      if (endDate) tags.push(`到${endDate}`);
      if (t.source === "ai" || data.source === "ai") tags.push("动态");
      const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      const label = t.label ? ` (${t.label})` : "";
      const prompt = t.prompt ? ` — ${String(t.prompt).slice(0, 60)}` : "";
      return {
        file,
        line: `${file} @ ${t.time}${label}${tagStr}${prompt}`,
      };
    });
  }

  return [{ file, line: `${file} — 未知类型: ${type}` }];
}

export function listEngineSchedules(
  scheduleDir: string,
): EngineScheduleSummary[] {
  if (!fs.existsSync(scheduleDir)) return [];

  const files = fs.readdirSync(scheduleDir).filter((f) => f.endsWith(".json")).sort();
  const lines: EngineScheduleSummary[] = [];

  for (const file of files) {
    try {
      const data = readJsonFile(path.join(scheduleDir, file)) as Record<string, unknown>;

      if (data.type) {
        lines.push(...listSemanticFile(file, data));
      } else {
        for (const raw of (data.schedules as Record<string, unknown>[] ?? [])) {
          lines.push(...formatScheduleEntry(file, raw));
        }
      }
    } catch {
      lines.push({ file, line: `${file} — 读取失败` });
    }
  }

  return lines;
}

export function validateEngineRemoveQuery(query: string): EngineRemoveQueryValidation {
  if (!query.trim()) {
    return { ok: false, reason: "任务名不能为空" };
  }
  if (query.includes("/") || query.includes("\\") || query.includes("..")) {
    return { ok: false, reason: "任务名不能包含路径分隔符或 .." };
  }
  return { ok: true };
}

export function findExactEngineScheduleFile(
  scheduleDir: string,
  query: string,
): string | null {
  if (!fs.existsSync(scheduleDir)) return null;
  const files = fs.readdirSync(scheduleDir).filter((f) => f.endsWith(".json")).sort();
  return files.includes(query) ? query : null;
}

function matchEntry(file: string, q: string, prompt?: string, label?: string, time?: string): EngineMatch | null {
  const p = (prompt ?? "").toLowerCase();
  const l = (label ?? "").toLowerCase();
  if (p.includes(q) || l.includes(q)) {
    return { file, prompt: prompt ?? label ?? "", time: time ?? "00:00" };
  }
  return null;
}

export function findEngineRemoveMatches(
  scheduleDir: string,
  query: string,
): EngineMatch[] {
  if (!fs.existsSync(scheduleDir)) return [];

  const q = query.toLowerCase();
  const files = fs.readdirSync(scheduleDir).filter((f) => f.endsWith(".json")).sort();
  const matches: EngineMatch[] = [];

  for (const file of files) {
    try {
      const data = readJsonFile(path.join(scheduleDir, file)) as Record<string, unknown>;

      if (typeof data.type === "string") {
        const tasks = data.tasks as Record<string, unknown>[] | undefined;
        if (tasks) {
          for (const t of tasks) {
            const m = matchEntry(file, q, t.prompt as string, t.label as string, t.time as string);
            if (m) matches.push(m);
          }
        } else {
          const m = matchEntry(file, q, data.prompt as string, data.label as string, data.time as string);
          if (m) matches.push(m);
        }
      } else {
        for (const raw of (data.schedules as Record<string, unknown>[] ?? [])) {
          const s = raw as { prompt?: string; label?: string; hour?: number; minute?: number };
          const m = matchEntry(file, q, s.prompt, s.label, `${pad2(s.hour ?? 0)}:${pad2(s.minute ?? 0)}`);
          if (m) matches.push(m);
        }
      }
    } catch {
      // ignore unreadable files for fuzzy matching
    }
  }

  return matches;
}

export function updateEnginePauseConfig(
  current: Record<string, unknown>,
  minutes: number,
): Record<string, unknown> {
  const next = { ...current };
  if (minutes <= 0) {
    next.enabled = true;
    delete next.pause_until;
    return next;
  }
  next.enabled = false;
  next.pause_until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  return next;
}

export function buildEngineLogEntry(
  text: string,
  now = new Date(),
): string {
  const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const timeStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  return `\n## ${dateStr} ${timeStr} — [手动]\n- ${text}\n`;
}

export function formatLocalTimestamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
