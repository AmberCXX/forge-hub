# TODO

## 架构优化

### 通道插件 class 化

当前四个通道（wechat/telegram/feishu/imessage）的状态全部挂在模块顶层变量上。一个文件 = 一个实例，写死了。

改成 class 后每个通道是一个独立实例对象，能解锁：
- 多账号（同类型通道跑两个实例）
- 通道重启时状态干净（扔掉旧实例 new 一个新的，不存在定时器/Map 残留）
- 测试隔离（每个 test case 独立实例）

改动范围：
- 4 个通道文件：module 变量 → class 属性，所有引用加 `this.`（约 300 处）
- channel-loader.ts：`m.default` → `new m.default()`
- 闭包里的 this 绑定是重点验证项

优先级：**低**。当前架构能跑，没有用户提出多账号需求。等有真实需求再做。

## 代码质量

### endpoints.ts 路由拆分

endpoints.ts 仍有 1157 行，所有 HTTP 路由在一个 if/else 链里。send 三兄弟已去重，但 dashboard 静态文件、审批 API、实例管理、homeland 端点混在一起。

可以按功能域拆成 `routes/approval.ts`、`routes/send.ts`、`routes/dashboard.ts` 等。不影响功能，纯可维护性。

### 关键模块补测试

以下模块零测试覆盖：
- `endpoints.ts` — 所有出站逻辑入口
- `instance-manager.ts` — WebSocket 实例生命周期
- `rate-limit.ts` — 速率限制
- `write-queue.ts` — 异步写队列

### iMessage 轮询自适应间隔

当前每秒查一次 SQLite，没消息时纯浪费。可以在连续 N 次空结果后延长到 5s，收到消息后回到 1s。
