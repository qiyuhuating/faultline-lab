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
| GET `/api/jobs/:id` | job 完整定义、attempts、receipts、最近 500 个事件及 serverTime |
| GET `/api/events?after=12` | SSE，事件 ID 为持久化 seq；支持 Last-Event-ID；游标过旧或超前返回 reset 事件 |
| GET `/api/evidence` | 保留事件的链校验结果与导出数据 |
| GET `/api/diagnostics` | 同一只读快照的语义诊断；HTTP 200 下仍可能 verdict=fail |
| POST `/api/jobs` | 新建任务；返回 jobId、deduplicated |
| POST `/api/jobs/:id/transitions` | action、expectedRevision、clearFaults；返回 jobId、revision、deduplicated |
| POST `/api/experiments` | scenario: retry / crash / duplicate / dead / burst / fence / response-loss |
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
| label | Untitled task；去除首尾空白后 1–80 个 UTF-16 代码单元；新任务名称必须是完整 Unicode 字符，未配对的代理项返回 VALIDATION |
| text | 内置示例文字；最多 12,000 UTF-8 bytes |
| priority | 0；0–5，越高越先领取，但不能绕过 due 时间 |
| maxAttempts | 4；1–5 |
| delayMs | 550；0–8,000，模拟异步耗时 |
| scheduleMs | 0；0–60,000，创建时换算为服务端 runAt |
| fault.failFirst | 0；0–10，前 N 次尝试故意失败 |
| fault.crashOnce | false；首次 generation 的首次领取时真实终止进程 |

未知字段、不合法类型、超大正文都拒绝，失败不创建任务。

`csv_summary` 接受 1–2,000 个绝对值不超过 10¹² 的有限数值。输入按 JavaScript Number 解析；`sum` 精确累计这些二进制浮点值，再舍入一次至最近值（中点取偶），因此不受输入顺序影响。`mean` 为该 `sum / count`。这不是任意精度十进制计算，例如 `0.1,0.2` 的和仍为 `0.30000000000000004`；既有收据不会重新计算。

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

## 实验与未知结果确认（v1.0.0）

POST `/api/experiments` 支持 retry、crash、duplicate、dead、burst、fence、response-loss。成功结果含 experimentId、jobIds、submissions、deduplicated。

GET `/api/experiments/:id` 返回 experiment、完整 jobs、verdict 和 serverTime。verdict.status 为 running/pass/fail；各 checks 含 id、label、status 和 detail。fence 的旧提交应在实验开始后 15 秒内出现，否则验收失败。人工取消或改变实验任务会改变验收结论，不会始终显示 PASS。

snapshot.experiments 仅包含最近 8 次实验的摘要和断言，不传完整输入、尝试和事件。需要详情时单独读取报告接口。完整任务详情保留最多 500 个任务关联事件；如果数据已被保留策略裁剪，不应将缺失证据视为完整历史。

GET `/api/requests/:idempotencyKey` 返回 `{found,result,serverTime}`。found=true 可确认原写入；found=false 不能证明一个正在传输的写入没有成功。查询不自动执行请求。当前前端在超时、网络异常或 5xx 后尝试这一只读确认；仍未确认则保留原键。

fault.stallOnce 默认 false，必须为 boolean；首次 generation 的首次执行停止续租，等待超过租约后真实尝试提交。clearFaults=true 会同时清除 failFirst、crashOnce 和 stallOnce。

所有 deadline 与状态判断由本机服务端拥有。展示时前端以 serverTime + performance.now() 的流逝估算时间，避免浏览器本身的 Date.now() 跳变影响呈现。主机时钟异常仍需独立运维策略。

## Storage and shutdown failures (v1.0.1)

| HTTP | Code | Client action |
| --- | --- | --- |
| 507 | STORAGE_FULL | Restore capacity, query the original request key, then explicitly retry the same intent if needed |
| 503 | STORAGE_BUSY | Retry-After: 1; back off reads and query the original write key; no automatic POST replay |
| 503 | SHUTTING_DOWN | Connection closes; reconnect after restart and resolve the original request key |

A task detail is assembled in one read transaction. Snapshot ETag is a weak hash of observable content; serverTime annotations alone do not invalidate it, while lease renewals, offline changes, metric windows, retention and proof changes do. revision continues to denote the persisted event sequence, not an all-fields snapshot version.

## Read-only diagnosis and evidence ranges (v1.2.0)

GET `/api/diagnostics` returns `format: faultline-diagnostics-v1`, `generatedAt`, `verdict: pass | warn | fail`, `counts: {jobs,attempts,receipts,events}`, `checks` and `notice`. Each check has an id, label, status and structured evidence. Any failed check makes verdict fail; otherwise a warning makes verdict warn. Identifiers are sampled up to 20, with `atLeast` explicitly denoting a lower bound rather than a total. Reports omit task inputs, control tokens and database paths. Expired leases and stopped owners are warnings and do not trigger recovery. This expensive inspection is manual, not part of snapshot polling.

An HTTP 200 means the report was obtained, not that data passed. Transport/storage failures use existing machine errors. Consumers must validate report format and distinguish transport failure from a domain verdict. The frontend preserves the last valid report if refresh fails.

`faultline-evidence-v1` remains compatible and gains optional `integrity.range: {anchorSequence, headSequence, source}`. New/stored ranges require consecutive events covering the exact interval `(anchorSequence, headSequence]`. Empty is valid only at equal boundaries. Source is `stored`, `genesis`, `legacy-inferred` or `unknown`; an unknown empty pruned range fails verification. Nonempty legacy recordings without range metadata remain accepted as consistency evidence. Inferred legacy boundaries are explicitly warnings in Doctor. No metadata is an independent authenticity signature.

Successful results must be JSON objects at runtime as well as in TypeScript. Stale ownership is rejected before accepting a result; invalid result objects roll back the still-current completion transaction.
