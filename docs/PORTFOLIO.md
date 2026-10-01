# Portfolio guide

## 三分钟演示

1. **0:00–0:30**：`npm start`，打开实验台，说明三个 Worker 是三个独立进程，SQLite 保存真实任务。
2. **0:30–1:15**：点击 Crash，进入追踪。展示首次尝试 expired、新 Worker、新 token 和唯一结果收据。打开事件流中的 signal:SIGKILL。
3. **1:15–1:40**：点击 Dedupe，展示三次调用、一个任务和两条去重事件。区分内部实验调用与独立 HTTP 并发测试。
4. **1:40–2:20**：点击 Dead letter，等待死信后清除故障并重放。展示 generation 变化与保留的历史。
5. **2:20–3:00**：导出事件证据，用 CLI 校验；打开真实测试与微基准结果，说明单机与外部副作用边界。

## 可用于简历的项目介绍

**Faultline — 异步任务执行与故障恢复实验台**

技术栈：Node.js、JavaScript ESM、SQLite WAL、HTTP/SSE、原生前端、Node Test Runner。

- 实现多进程任务执行引擎，通过事务领取、租约续约及递增 fencing token，拒绝过期 Worker 的结果提交。
- 实现持久化请求幂等、指数退避、死信重放与版本冲突处理；内置任务结果和成功状态使用同一数据库事务提交。
- 构建实时故障实验台与可导出事件链，完成 48 项核心自动化验证，覆盖 240 任务 / 4 进程竞争及真实 SIGKILL 后接管。

需要展示性能时，可以补充：在记录的本机测试环境中，4 Worker 完成 500 个轻量摘要任务，用时 714 ms、生成 500 张结果收据。注明这是本机微基准，不写成生产 QPS 或性能 SLA。

## 可以回答和展示后再使用

这是 AI 辅助完成的工程项目。把它用于简历前，亲自运行实验、读懂 `queue.mjs` 的事务边界、完成 INTERVIEW.md 的练习并记录自己的修改。对生成式工具的使用、自己的贡献和实际测试证据如实描述。

## 不写到简历里的夸大说法

- 分布式调度集群、生产高可用、千万级任务。
- 所有外部副作用 exactly-once。
- 不可伪造的审计系统。
- 700 生产 QPS（该数值是本机内部提交与轻量处理微基准）。

## GitHub 展示建议

建议仓库名 `faultline-lab`，介绍：`Break the worker. Keep the promise. A local task engine with real crash recovery, fenced commits and verifiable execution traces.`

Topics：`task-queue`、`fault-injection`、`sqlite`、`nodejs`、`idempotency`、`observability`。

将源码与测试包合并后作为完整 Git 仓库提交；CI 需要 tests/。可独立发布源码 ZIP 和测试 ZIP。README 先展示封面与三分钟演示，再链接具体设计、真实验收结果与边界。独立仓库已创建，公开页提供真实实验轨迹回放，本地引擎用于实际制造故障。

## 完整展示入口

- 仓库：https://github.com/qiyuhuating/faultline-lab
- 在线轨迹：https://qiyuhuating.github.io/faultline-lab/
- 实际执行：下载源码，Node 24.x 下 npm start

## 新增面试演示

先展示 Zombie worker：新租约已完成，旧进程后来实际提交，被数据库以 STALE_LEASE 拒绝。随后展示 Lost response：POST 已经落盘但客户端拿不到响应，通过同一个请求键只读确认。最后解释报告为什么需要统一的 SQLite 读快照。

可以补充到简历：构建真实故障实验和交互式证据回放器，通过 Chromium、Firefox、WebKit 自动化验收，覆盖刷新草稿、离线恢复、丢失响应、畸形快照、移动布局及篡改证据停止回放。测试数量和 CI 链接以 VERIFICATION.md 的最终记录为准。
