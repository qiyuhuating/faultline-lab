# HTTP contract

Base: `http://127.0.0.1:8787`。所有响应为 JSON，SSE 与静态资源除外。

## 写入约定

先 GET `/api/bootstrap` 取得 `controlToken`。POST 需提供 `Content-Type: application/json`、`X-Control-Token`、`Idempotency-Key`。Key 为 8–128 个字母、数字、下划线、点、冒号或连字符。跨站 Origin 被拒绝。

控制令牌在引擎重启后变化；幂等记录保存在数据库中。没有账户、认证权限或多租户语义。令牌是本机跨站写入防护。

错误：`{"error":{"code":"REVISION_CONFLICT","message":"任务已变化，请读取最新版本再操作。"}}`。

| 方法 / 路径 | 输入或结果 |
| --- | --- |
| GET `/api/bootstrap` | version、controlToken、serverTime、leaseMs、workerCount、mode |
| GET `/api/snapshot?state=dead&before=123` | 最近 40 条 jobs、nextBefore、全库 counts、workers、metrics、series、最近事件、serverTime、revision；支持 ETag / 304 |
| GET `/api/jobs/:id` | job 完整定义、attempts、receipts、最近 100 个事件及 serverTime |
| GET `/api/events?after=12` | SSE，事件 ID 为持久化 seq；支持 Last-Event-ID；游标过旧或超前返回 reset 事件 |
| GET `/api/evidence` | 保留事件的链校验结果与导出数据 |
| POST `/api/jobs` | 新建任务；返回 jobId、deduplicated |
| POST `/api/jobs/:id/transitions` | action、expectedRevision、clearFaults；返回 jobId、revision、deduplicated |
| POST `/api/experiments` | scenario: retry / crash / duplicate / dead / burst |
| POST `/api/control` | paused: boolean；在途任务不被中止 |

## 新建任务

```json
{
  "kind": "digest",
  "label": "Compute a digest",
  "text": "hello",
  "priority": 0,
  "maxAttempts": 4,
  "delayMs": 550,
  "scheduleMs": 0,
  "fault": { "failFirst": 0, "crashOnce": false }
}
```

| 字段 | 默认与范围 |
| --- | --- |
| kind | digest；可选 csv_summary（只接受逗号/空白/分号分隔的有限数值，不是通用 CSV 解析器） |
| label | Untitled task；去除首尾空白后 1–80 字符 |
| text | 内置示例文字；最多 12,000 UTF-8 bytes |
| priority | 0；0–5，越高越先领取，但不能绕过 due 时间 |
| maxAttempts | 4；1–5 |
| delayMs | 550；0–8,000，模拟异步耗时 |
| scheduleMs | 0；0–60,000，创建时换算为服务端 runAt |
| fault.failFirst | 0；0–10，前 N 次尝试故意失败 |
| fault.crashOnce | false；首次 generation 的首次领取时真实终止进程 |

未知字段、不合法类型、超大正文都拒绝，失败不创建任务。

## 处置与并发

```json
{ "action": "replay", "expectedRevision": 5, "clearFaults": true }
```

cancel 只接受 queued/running/retry_wait；replay 只接受 dead/cancelled。succeeded 不可重放。过时 revision 返回 409；同一已成功请求的幂等重放先复用原结果，因此不会因为 revision 已变化而误报冲突。

## 常见机器错误

| HTTP | Code |
| --- | --- |
| 400 | VALIDATION、INVALID_JSON、IDEMPOTENCY_REQUIRED |
| 403 | HOST_REJECTED、ORIGIN_REJECTED、CONTROL_TOKEN_REQUIRED |
| 404 | NOT_FOUND |
| 409 | IDEMPOTENCY_CONFLICT、REVISION_CONFLICT、INVALID_TRANSITION、REPLAY_LIMIT |
| 413 | TOO_LARGE |
| 415 | CONTENT_TYPE |
| 429 | CAPACITY |
| 503 | STREAM_CAPACITY |
| 500 | SERVER_ERROR |

客户端对未收到完整成功/业务失败响应的写入应当视为“结果未确认”，读取状态并复用原幂等键进行显式重试，不可随机生成新键自动重发。
