import { describe, expect, test } from "bun:test";
import { parseTime, expandSemantic } from "./config-loader.js";
import type { HeartbeatConfig, ReminderConfig, InstructionConfig, OneshotConfig } from "./types.js";

describe("parseTime", () => {
  test("HH:MM", () => {
    expect(parseTime("5:30")).toEqual({ hour: 5, minute: 30, second: 0 });
    expect(parseTime("18:55")).toEqual({ hour: 18, minute: 55, second: 0 });
  });

  test("HH:MM:SS", () => {
    expect(parseTime("5:00:30")).toEqual({ hour: 5, minute: 0, second: 30 });
  });

  test("zero-padded", () => {
    expect(parseTime("05:05")).toEqual({ hour: 5, minute: 5, second: 0 });
  });

  test("midnight", () => {
    expect(parseTime("0:00")).toEqual({ hour: 0, minute: 0, second: 0 });
  });

  test("non-numeric input falls back to 0", () => {
    expect(parseTime("abc")).toEqual({ hour: 0, minute: 0, second: 0 });
    expect(parseTime("9:30am")).toEqual({ hour: 9, minute: 0, second: 0 });
    expect(parseTime("")).toEqual({ hour: 0, minute: 0, second: 0 });
  });
});

describe("expandSemantic — heartbeat", () => {
  const cfg: HeartbeatConfig = {
    type: "heartbeat",
    wakeup: "5:30",
    sleep: "22:00",
    active_start: 9,
    active_end: 24,
    daily_count: 50,
    min_per_hour: 1,
  };

  test("expands into 3 entries: wakeup + sleep + random", () => {
    const entries = expandSemantic(cfg, "heartbeat.json");
    expect(entries.length).toBe(3);

    expect(entries[0].hour).toBe(5);
    expect(entries[0].minute).toBe(30);
    expect(entries[0].label).toBe("起床");
    expect(entries[0].sender).toBe("heartbeat");

    expect(entries[1].hour).toBe(22);
    expect(entries[1].minute).toBe(0);
    expect(entries[1].label).toBe("睡觉");

    expect(entries[2].expand).toBe("random");
    expect(entries[2].active_start).toBe(9);
    expect(entries[2].active_end).toBe(24);
    expect(entries[2].daily_count).toBe(50);
  });

  test("uses default values when optional fields omitted", () => {
    const minimal: HeartbeatConfig = { type: "heartbeat", wakeup: "6:00", sleep: "23:00" };
    const entries = expandSemantic(minimal, "hb.json");
    expect(entries[2].active_start).toBe(9);
    expect(entries[2].active_end).toBe(24);
    expect(entries[2].daily_count).toBe(10);
    expect(entries[2].min_per_hour).toBe(1);
  });
});

describe("expandSemantic — reminder", () => {
  test("single reminder", () => {
    const cfg: ReminderConfig = {
      type: "reminder",
      time: "14:00",
      prompt: "Take a break.",
    };
    const entries = expandSemantic(cfg, "reminders.json");
    expect(entries.length).toBe(1);
    expect(entries[0].hour).toBe(14);
    expect(entries[0].minute).toBe(0);
    expect(entries[0].prompt).toBe("Take a break.");
    expect(entries[0].sender).toBe("reminder");
    expect(entries[0].template).toContain("[提醒]");
  });

  test("multiple reminders via tasks", () => {
    const cfg: ReminderConfig = {
      type: "reminder",
      tasks: [
        { time: "8:00", prompt: "Morning review" },
        { time: "12:00", prompt: "Lunch break" },
      ],
    };
    const entries = expandSemantic(cfg, "meals.json");
    expect(entries.length).toBe(2);
    expect(entries[0].prompt).toBe("Morning review");
    expect(entries[1].prompt).toBe("Lunch break");
  });

  test("inherits weekdays from top level", () => {
    const cfg: ReminderConfig = {
      type: "reminder",
      weekdays: [1, 2, 3, 4, 5],
      tasks: [
        { time: "14:00", prompt: "Standup" },
      ],
    };
    const entries = expandSemantic(cfg, "r.json");
    expect(entries[0].weekdays).toEqual([1, 2, 3, 4, 5]);
  });

  test("task-level weekdays override top level", () => {
    const cfg: ReminderConfig = {
      type: "reminder",
      weekdays: [1, 2, 3, 4, 5],
      tasks: [
        { time: "14:00", prompt: "Standup", weekdays: [1, 3, 5] },
      ],
    };
    const entries = expandSemantic(cfg, "r.json");
    expect(entries[0].weekdays).toEqual([1, 3, 5]);
  });
});

describe("expandSemantic — instruction", () => {
  test("single instruction", () => {
    const cfg: InstructionConfig = {
      type: "instruction",
      time: "8:00",
      prompt: "Morning check-in.",
    };
    const entries = expandSemantic(cfg, "checkin.json");
    expect(entries.length).toBe(1);
    expect(entries[0].sender).toBe("instruction");
    expect(entries[0].template).toContain("[指令]");
  });

  test("multiple instructions", () => {
    const cfg: InstructionConfig = {
      type: "instruction",
      tasks: [
        { time: "8:00", prompt: "Daily check-in" },
        { time: "8:00", prompt: "Weekly review", weekdays: [0] },
      ],
    };
    const entries = expandSemantic(cfg, "checkin.json");
    expect(entries.length).toBe(2);
    expect(entries[1].weekdays).toEqual([0]);
  });
});

describe("expandSemantic — oneshot", () => {
  test("expands into one_shot entry with date", () => {
    const cfg: OneshotConfig = {
      type: "oneshot",
      time: "15:30",
      date: "2026-05-23",
      prompt: "Call the dentist.",
    };
    const entries = expandSemantic(cfg, "oneshot_abc.json");
    expect(entries.length).toBe(1);
    expect(entries[0].hour).toBe(15);
    expect(entries[0].minute).toBe(30);
    expect(entries[0].one_shot).toBe(true);
    expect(entries[0].start_date).toBe("2026-05-23");
    expect(entries[0].end_date).toBe("2026-05-23");
    expect(entries[0].source).toBe("ai");
  });
});
