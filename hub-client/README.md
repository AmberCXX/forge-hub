# Hub Client · hub-channel.ts

Claude Code 的 MCP server——让 CC 窗口通过 Hub 收发 IM 消息。

## 两种模式

| 模式 | 连 WebSocket？ | 能收消息？ | 能发消息？ |
|------|--------------|----------|----------|
| **channel** | 是 | 是 | 是 |
| **tools** | 否 | 否 | 是（通过 hub_reply 等 MCP tools） |

### 模式判定

启动时按以下优先级判定：

1. **有 session config**（启动器写了 `next-session.json`）→ 按 config 里的 `isChannel` 走，零等待
2. **无 session config**（直接 `claude` 或 `claude --resume`）→ 检测 CC 的 channel handler 是否注册（10 秒内），注册了走 channel 模式，没有走 tools 模式

channel handler 是否注册取决于 CC 启动时有没有 `--dangerously-load-development-channels server:hub`。

## 进程生命周期

### 启动

CC 启动时 spawn hub-channel.ts 作为子进程，通过 stdio 通信（MCP 协议）。

### 退出

CC 关窗口时发 SIGHUP（终端关闭信号）。hub-channel.ts 捕获后：
1. 写退出日志（含信号类型和 PID）
2. 调 `mcpServer.close()` 清理 MCP 资源（200ms 兜底超时）
3. `process.exit(0)`

同时监听 SIGINT、SIGTERM、stdin EOF 作为兜底。

### 日志

写到 `~/.forge-hub/hub-client.log`，格式：

```
[2026-05-10T07:27:56.561Z] [forge-70902] INFO MCP 连接就绪 (pid=70921)
[2026-05-10T07:27:56.562Z] [forge-70902] INFO Hub Client 已启动 · 工具模式（不注册 peer）
[2026-05-10T07:27:39.640Z] [forge-66745] INFO 收到退出信号 (SIGHUP)，关闭 MCP server... (pid=66764)
```

PID 同时记录在启动和退出日志中，方便用 `ps` 输出比对。

日志文件 1MB 自动轮转（保留 2 份历史：`.1`、`.2`），和 hub.log 同规格。

### 自动降级

无 session config 的实例走自动检测：先连 WebSocket，等待 Claude Code channel handler 注册（60s）。连续 2 次检测超时后自动降级到工具模式，停止重连。防止 MCP 日志误匹配导致 tools 实例进入无限重连循环。

### 诊断

```bash
fh hub ps
```

输出所有 hub-channel 进程的 PID、instance ID、模式、描述、通道订阅，以及 Hub server 状态。能检测孤儿进程。

## MCP Tools

| 工具 | 用途 |
|------|------|
| `hub_reply` | 发文字到 IM 通道 |
| `hub_send_file` | 发文件 |
| `hub_send_voice` | 发语音（需配 TTS hook） |
| `hub_replay_history` | 拉取历史消息 |

tools 模式和 channel 模式都可用——tools 走 HTTP 不依赖 WebSocket。

## 文件结构

```
hub-client/
  hub-channel.ts      ← 主入口：MCP server + WebSocket + tools
  session-config.ts   ← session config 读取 + 模式判定
```
