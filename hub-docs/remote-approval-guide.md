# 远程审批设置指南

> 在手机上通过 Telegram、微信或其他 IM 通道审批 Claude Code 的权限请求。

**读者**：想在手机上审批 Claude Code 工具调用的 Forge Hub 用户。
**预期时长**：≤ 5 分钟从开始读到跑通。
**前置**：Forge Hub 已安装并运行，至少一个 IM 通道已配好。

---

## 原理

Claude Code 要执行工具（bash、写文件等），Hub 把请求转发到你手机，你回复一个短码，Claude Code 继续执行。

```
你（Telegram）              Hub                     Claude Code
                                                    ← 想执行: bash
                            ← 权限请求
📱 "yes abcde / no fghij"    
"yes abcde" →               验证身份 + ID →         ✅ 工具执行
```

---

## 设置

### 1. 配置审批通道

编辑 `~/.forge-hub/hub-config.json`：

```json
{
  "approval_channels": ["telegram"]
}
```

多通道并发推送——所有通道都收到，第一个有效回复生效：

```json
{
  "approval_channels": ["telegram", "wechat"],
  "approval_push_mode": "parallel"
}
```

### 2. 设置审批人

只有审批人能批准/拒绝请求。设置自己为审批人：

```bash
fh hub owner telegram <你的chat_id>
```

还没加白名单的话先加：

```bash
fh hub allow telegram <你的chat_id> 你的名字
fh hub owner telegram <你的chat_id>
```

> **找 chat ID**：给你的 Telegram bot 发条消息，然后 `fh hub security evidence` 查看最近的条目，里面有你的 chat ID。或者直接看 `~/.forge-hub/hub.log`。

### 3. 启动 Claude Code

```bash
claude --dangerously-load-development-channels server:hub
```

用 [forge-launcher](https://github.com/LinekForge/forge-launcher) 启动的话会自动带这个参数。

### 4. 验证

让 Claude Code 做一件需要权限的事（比如跑 shell 命令）。几秒内你的 Telegram 应该收到审批提示。

---

## 你在手机上看到什么

```
Claude wants to run bash: npm install
Reply "yes abcde" to approve
Reply "no fghij" to deny
```

照着回复就行——5 个字母的短码不区分大小写，但必须对上。`yes abcde` 批准，`no fghij` 拒绝。

---

## 超时

| 事件 | 时间 |
|------|------|
| 未回复时发提醒 | 30 分钟 |
| 仍未回复则自动拒绝 | 4 小时 |

---

## 常见问题

| 现象 | 原因 | 解决 |
|------|------|------|
| Hub 返回 503 | `approval_channels` 未配置 | 在 hub-config.json 加 `"approval_channels": ["telegram"]` |
| 手机收不到审批提示 | 通道离线或配置错误 | `fh hub channels` 查通道状态；`fh hub status` 查实例 |
| 回复后提示"instance offline" | 发出请求的 Claude Code 窗口已关 | 审批已失效，CC 会重新请求 |
| "No approval found with ID xxxxx" | 超时（4 小时）或 Hub 重启了 | CC 会自动重新请求 |
| "non-owner reply, ignored" | 你不是审批人 | `fh hub owner telegram <你的chat_id>` |
| "Mismatch: you said yes but ID is bound to deny" | 用错了短码 | 每次审批有两个不同的短码——一个给 yes，一个给 no |

---

## 安全

- **仅审批人可回复**：只有 `approval_owner_id` 的回复被接受，其他人的回复被静默忽略。
- **一次性短码**：每次审批生成两个唯一的 5 字符短码（`[a-km-z]`，不含 `l` 避免混淆）。yes 码和 no 码是绑定的——不能拿 yes 的码去拒绝。
- **审计记录**：所有批准、拒绝、超时都记录在 `~/.forge-hub/audit.jsonl`。
- **限频**：Hub 限制每个实例每分钟的请求数，防刷。
- **不可重放**：短码随审批过期（4 小时 TTL 或 Hub 重启）。

---

## 配置参考

| 配置项 | 位置 | 用途 |
|--------|------|------|
| `approval_channels` | `hub-config.json` | 审批推送到哪些 IM 通道 |
| `approval_push_mode` | `hub-config.json` | `"parallel"`（默认，并发推）或 `"sequential"` |
| `approval_owner_id` | `state/{通道名}/allowlist.json` | 谁能在这个通道上回复审批 |

详见 [配置.md](../配置.md) § 远程审批通道选择。
