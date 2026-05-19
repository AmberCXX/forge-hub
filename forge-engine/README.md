# Forge Engine

**实验性定时行动引擎** — 按 schedule 给 Claude Code 发心跳、提醒、指令。让 agent 从"被动回应"变成"主动行动"。

独立的 channel MCP server，通过 [Channels 协议](https://code.claude.com/docs/en/channels-reference) 注入 Claude 上下文。和 Hub Server 配合：Hub 管通道（空间），Engine 管时间。

> [!IMPORTANT]
> Forge Engine 目前是 **experimental / manual setup**。源码、MCP server 和 CLI 都在仓库里，但 **`forge-hub install` 默认不会部署或注册它**。想用的话，按下面步骤单独配置。

## 架构

```
engine.d/*.json (schedule 文件)
        │
        ▼
  scheduler.ts  ──▶  engine-channel.ts (MCP server)  ──▶  Claude Code session
        │                                                         │
        └── config-loader.ts (热加载)                              │
        └── handler-loader.ts (插件)                               │
                                                                   ▼
                                                          agent 收到通知后行动
```

| 文件 | 职责 |
|------|------|
| `engine-channel.ts` | MCP server 入口 + `engine_add_task` 工具 |
| `scheduler.ts` | 核心调度——expandRandom / fire / 午夜重算 / 热加载 / PID lock / `stopScheduler` |
| `config-loader.ts` | 配置加载 + fs.watch 热加载 |
| `handler-loader.ts` | 可插拔 handler（`handlers/` 目录下的自定义逻辑） |
| `template.ts` | 模板变量渲染（`{time}` `{weekday}` `{contacts}` 等） |
| `state.ts` | 持久化状态（任务 + pause） |
| `types.ts` | TypeScript 类型定义 |
| `config.ts` | 路径常量 + 日志 |

## PID Lock / Passive Mode

同一台机器上可能有多个 Claude Code session 各自 spawn 自己的 engine MCP server 进程。为避免重复调度，engine 用 PID 文件（`engine-data/engine.pid`）做排他锁：

- **第一个启动的实例**拿到锁，成为 **active**——正常排程、fire 定时任务。
- **后续实例**检测到锁已被一个活着的进程持有，自动进入 **passive mode**——MCP 工具（`engine_add_task`）照常可用，但不启动任何定时器，不重复触发任务。
- 如果持锁进程已退出（stale PID），新实例接管锁并成为 active。

Passive mode 对 agent 透明：工具调用不受影响，只是定时排程由唯一的 active 实例负责。

## Graceful Shutdown

engine-channel.ts 注册了 `SIGTERM` 和 `SIGINT` 信号处理：

1. 调用 `stopScheduler()` — 清除所有定时器（task timers + 午夜重排 + 热加载 debounce）
2. 释放 PID lock（只删自己持有的 `engine.pid`）
3. `process.exit(0)`

这保证 Claude Code 关窗口（launchd 或 MCP 父进程发 SIGTERM）时不会留下残余定时器或 stale PID 文件。

## Trigger Log Rotation

`engine-trigger-log.md`（记录每次任务触发的日志）支持自动轮转：

- 每次写入前检查文件大小，超过 **512 KB** 自动轮转。
- 保留 **2 个**轮转文件（`engine-trigger-log.md.1`、`engine-trigger-log.md.2`），更旧的自动删除。
- 轮转采用重命名链：当前 → `.1` → `.2`，不丢数据。

## 快速开始

```bash
cd forge-engine
bun install
```

1. 创建配置 `~/.forge-hub/engine-data/engine-config.json`：
```json
{
  "enabled": true,
  "scan_dir": true,
  "contacts": {}
}
```

2. 创建 schedule `~/.forge-hub/engine-data/engine.d/heartbeat.json`：
```json
{
  "schedules": [
    {
      "hour": 9,
      "minute": 0,
      "template": "[heartbeat] Good morning! It's {time} on {weekday}.",
      "sender": "heartbeat",
      "label": "morning"
    }
  ]
}
```

3. 注册 engine 为 Claude Code 的 MCP server（二选一）：

   **方式 A（推荐）**：CLI 一行注册（user scope，所有 session 共享）
   ```bash
   claude mcp add --transport stdio --scope user engine -- bun /absolute/path/to/forge-engine/engine-channel.ts
   ```

   **方式 B**：手写到 `~/.claude.json` 的 `mcpServers`
   ```json
   {
     "mcpServers": {
       "engine": {
         "command": "bun",
         "args": ["/absolute/path/to/forge-engine/engine-channel.ts"]
       }
     }
   }
   ```

4. **启动 Claude Code 时把 engine 加入 channels 白名单**——这一步**必不可少**，否则 engine 的定时通知会被 Claude Code 静默丢弃：

```bash
claude --dangerously-load-development-channels server:engine
```

> [!IMPORTANT]
> Channels 是 research preview（详见 [Channels Reference](https://code.claude.com/docs/en/channels-reference)），自定义 channel server（包括 forge-engine、forge-hub 的 hub-channel）必须用 `--dangerously-load-development-channels server:<name>` 显式白名单才被识别。`claude mcp list` 显示 `✓ Connected` **只代表 MCP 子进程成功启动**，**不代表 channel 通知能投递**——后者还需要这一步。
>
> 和 forge-hub 一起用要带两个，**空格分隔**：`server:hub server:engine`（不是逗号）。如果你用 [forge-launcher](https://github.com/LinekForge/forge-launcher) 启动菜单栏会话管理器，它会自动带上这俩 flag。

5. 验证 channel 通知接通：在跑 Claude Code 的窗口里让 agent 调用 `engine_add_task` 工具（设 `delay_seconds: 30`）。30 秒后窗口收到 `<channel source="engine" ...>` 包裹的消息说明白名单生效；收不到 → 检查是否漏了 `server:engine`。

6. 用 `fh engine` 管理任务：
```bash
fh engine list
fh engine pause 30
fh engine remove heartbeat.json
fh engine log "今天 14:00 已人工处理"
```

## Schedule 格式

每个 `engine.d/*.json` 文件包含一个 `schedules` 数组，每条 entry：

| 字段 | 类型 | 说明 |
|------|------|------|
| `hour` | number | 小时（0-23） |
| `minute` | number | 分钟（0-59） |
| `template` | string | 消息模板，支持 `{time}` `{weekday}` `{label}` `{contacts}` `{prompt}` |
| `sender` | string | 消息来源标识（`heartbeat` / `reminder` / `instruction`） |
| `label` | string? | 可选标签 |
| `prompt` | string? | 可选 prompt（`{prompt}` 模板变量引用） |
| `expand` | `"random"`? | 设为 `"random"` 时按 `daily_count` + `active_start/end` 在一天内随机分布 |
| `weekdays` | number[]? | 限定星期几触发（0=周日，1=周一...6=周六） |

### 随机分布 schedule

```json
{
  "expand": "random",
  "hour": 0, "minute": 0,
  "active_start": 8,
  "active_end": 22,
  "daily_count": 5,
  "min_per_hour": 1,
  "template": "[heartbeat] It's {time}. Check in with the user.",
  "sender": "heartbeat"
}
```

每天 0:00 按 `daily_count` 在 `active_start`–`active_end` 范围内随机生成 N 个时间点。

## 工具

| 工具 | 说明 |
|------|------|
| `engine_add_task` | Claude 在 session 里动态添加定时任务（如"一小时后提醒我做 X"） |

> `engine_add_task` 只有在你按上面的步骤把 engine MCP server 单独注册进 Claude Code 之后才可用。

## Public API

| 导出 | 来源 | 说明 |
|------|------|------|
| `startScheduler(server)` | `scheduler.ts` | 启动调度（获取 PID lock、加载配置、排程、启动热加载） |
| `stopScheduler()` | `scheduler.ts` | 清除所有定时器（task timers + 午夜重排 + 热加载 debounce）、释放 PID lock。shutdown handler 内部调用 |

## Handler 插件

在 `handlers/` 目录下放 `.ts` 文件，export 一个 `ScheduleHandler` 接口实现。Engine 启动时自动扫描加载。

## License

[MIT](../LICENSE) — Linek & Forge
