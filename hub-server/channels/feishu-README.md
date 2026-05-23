# 飞书通道 · 连接模式说明

## 两种模式

| 模式 | 依赖 | 连接方式 | 推荐 |
|------|------|---------|------|
| **SDK 直连** | `@larksuiteoapi/node-sdk` | 进程内 WebSocket | 推荐 |
| **lark-cli** | lark-cli 二进制 | 子进程 + NDJSON | 向后兼容 |

Hub 启动时自动判断：配了 SDK 凭证走 SDK，没配自动 fallback 到 lark-cli。

## SDK 直连模式（推荐）

进程内直连飞书 WebSocket，无子进程，无幽灵连接问题。

### 配置

在 `~/.forge-hub/state/feishu/config.json` 写入 app_id：

```json
{
  "app_id": "cli_xxxxxxxxxxxxxxxx"
}
```

app_secret 的查找顺序：
1. `config.json` 里的 `app_secret` 字段（明文，不推荐）
2. 环境变量 `FORGE_FEISHU_APP_SECRET`
3. macOS Keychain（和 lark-cli 共享，service=`lark-cli/appsecret`）

如果你之前用过 `lark-cli auth login`，Keychain 里已经有 secret——只需要建 config.json 写 app_id 就行。

### 环境变量替代

```bash
FORGE_FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FORGE_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
```

设在 plist 的 EnvironmentVariables 里或 shell profile 里。

## lark-cli 模式（向后兼容）

不需要任何额外配置。如果你已经通过 `lark-cli auth login` 认证，Hub 检测不到 SDK 凭证时自动走这条路径。

### 已知限制

- **幽灵连接**：Hub 重启时 lark-cli 子进程可能没干净退出，飞书服务端认为旧连接还在，导致新连接被拒绝（`another event bus already connected`）。通常需要等几分钟飞书服务端超时
- **进程管理**：Hub 需要 spawn/pkill/pgrep 管理 lark-cli 进程

SDK 模式没有这两个问题。

## 从 lark-cli 迁移到 SDK

1. 建 `~/.forge-hub/state/feishu/config.json`，写入 `{"app_id": "你的app_id"}`
2. 重启 Hub
3. 日志里看到"飞书通道已启动（SDK WebSocket 直连）"就成功了

app_id 在飞书开发者后台或 `lark-cli auth status` 的输出里找。
