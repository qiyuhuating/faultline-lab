const $ = id => document.getElementById(id);
const put = (id, value) => { const node = $(id); if (node.textContent !== String(value)) node.textContent = value; };
const node = (tag, className = '', text = '') => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== '') element.textContent = text;
  return element;
};
const names = { queued: '等待领取', running: '运行中', retry_wait: '等待重试', succeeded: '已成功', dead: '死信', cancelled: '已取消' };
const state = { token: '', snapshot: null, filter: '', before: null, source: null, detailId: null, detailRequest: 0, serverAt: 0, localAt: 0, failures: 0, nextRead: 0, etags: new Map(), bodies: new Map(), intents: new Map() };
const jobRows = new Map();
const eventRows = new Map();
let reading = false;
let readAgain = false;
let debounce = null;
let toastTimer = null;
let connecting = false;

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}

function clock() { return state.serverAt + (performance.now() - state.localAt); }
function syncTime(serverTime) { state.serverAt = serverTime; state.localAt = performance.now(); }
const short = value => value ? value.slice(0, 8) : '—';
const time = value => new Date(value).toLocaleTimeString('en-GB', { hour12: false });

function connection(online) {
  put('connection', online ? 'LIVE CONNECTION' : 'RECONNECTING');
  $('connection').classList.toggle('offline', !online);
}

function banner(message = '') {
  $('error-banner').textContent = message;
  $('error-banner').hidden = !message;
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try { return await fetch(path, { ...options, signal: controller.signal, cache: 'no-store' }); }
  finally { clearTimeout(timeout); }
}

async function bootstrap() {
  if (connecting) return;
  connecting = true;
  try {
    const response = await request('/api/bootstrap');
    if (!response.ok) throw new Error('引擎暂时不可用。');
    const data = await response.json();
    if (typeof data.controlToken !== 'string' || typeof data.serverTime !== 'number') throw new Error('引擎返回的配置不完整。');
    state.token = data.controlToken;
    syncTime(data.serverTime);
    state.failures = 0;
    await refresh();
    connectStream();
  } catch (error) { failedRead(error); }
  finally { connecting = false; }
}

function failedRead(error) {
  state.failures++;
  state.nextRead = performance.now() + Math.min(20000, 1000 * 2 ** Math.min(state.failures, 5));
  connection(false);
  banner(`连接中断，正在尝试恢复。已显示的记录保留。${error.message ?? ''}`);
}

async function write(path, body) {
  if (!state.token) throw new Error('请等待引擎连接后再提交。');
  const signature = `${path}:${JSON.stringify(body)}`;
  let intent = state.intents.get(signature);
  if (!intent) { intent = crypto.randomUUID(); state.intents.set(signature, intent); }
  let response;
  try {
    response = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Control-Token': state.token, 'Idempotency-Key': intent }, body: JSON.stringify(body) });
    const data = await response.json();
    if (response.status >= 500) throw new Error('UNKNOWN_OUTCOME');
    if (!response.ok) {
      if (data.error?.code === 'CONTROL_TOKEN_REQUIRED') {
        state.token = '';
        bootstrap();
      } else state.intents.delete(signature);
      const error = new Error(data.error?.message ?? '提交未完成。');
      error.confirmed = true;
      throw error;
    }
    state.intents.delete(signature);
    scheduleRead();
    return data;
  } catch (error) {
    if (error.confirmed) throw error;
    throw new Error('结果未确认，请核对任务状态。再次提交相同内容会复用本次幂等键。');
  }
}

function scheduleRead() {
  clearTimeout(debounce);
  debounce = setTimeout(() => refresh(), 120);
}

async function refresh() {
  if (document.hidden) return;
  if (reading) { readAgain = true; return; }
  reading = true;
  const filter = state.filter;
  const before = state.before;
  const query = new URLSearchParams();
  if (filter) query.set('state', filter);
  if (before) query.set('before', String(before));
  const path = `/api/snapshot${query.size ? `?${query}` : ''}`;
  try {
    const headers = {};
    if (state.etags.has(path)) headers['If-None-Match'] = state.etags.get(path);
    const response = await request(path, { headers });
    if (response.status === 304) {
      if (filter !== state.filter || before !== state.before) { readAgain = true; return; }
      const cached = state.bodies.get(path);
      if (cached) { state.snapshot = cached; render(cached); }
      state.failures = 0;
      connection(true);
      banner();
      if (state.detailId && $('detail-dialog').open) await refreshDetail(state.detailId);
      return;
    }
    if (!response.ok) throw new Error('无法读取最新状态。');
    const snapshot = await response.json();
    if (!Array.isArray(snapshot.jobs) || !Array.isArray(snapshot.workers) || !snapshot.counts || typeof snapshot.serverTime !== 'number') throw new Error('状态数据不完整。');
    if (filter !== state.filter || before !== state.before) { readAgain = true; return; }
    const etag = response.headers.get('ETag');
    if (etag) state.etags.set(path, etag);
    state.bodies.set(path, snapshot);
    syncTime(snapshot.serverTime);
    state.snapshot = snapshot;
    state.failures = 0;
    connection(true);
    banner();
    render(snapshot);
    if (state.detailId && $('detail-dialog').open) await refreshDetail(state.detailId);
  } catch (error) { failedRead(error); }
  finally {
    reading = false;
    if (readAgain) { readAgain = false; scheduleRead(); }
  }
}

function connectStream() {
  state.source?.close();
  if (document.hidden || !state.snapshot) return;
  const source = new EventSource(`/api/events?after=${state.snapshot.revision}`);
  state.source = source;
  source.addEventListener('ready', () => { connection(true); scheduleRead(); });
  source.addEventListener('change', scheduleRead);
  source.addEventListener('reset', () => { state.etags.clear(); scheduleRead(); });
  source.onerror = () => connection(false);
}

function badge(job) { return node('span', `state-badge ${job.state}`, names[job.state] ?? job.state); }

function renderJobs(jobs) {
  const ids = new Set(jobs.map(job => job.id));
  for (const [id, row] of jobRows) if (!ids.has(id)) { row.root.remove(); jobRows.delete(id); }
  let rowIndex = 0;
  for (const job of jobs) {
    let row = jobRows.get(job.id);
    if (!row) {
      const root = node('tr');
      root.dataset.jobId = job.id;
      const first = node('td');
      const label = node('span', 'job-name');
      const meta = node('span', 'job-id');
      first.append(label, meta);
      const status = node('td');
      const attempt = node('td', 'attempt-count');
      const owner = node('td', 'worker-id');
      const actions = node('td');
      const button = node('button', 'detail-button', '追踪 ↗');
      button.type = 'button';
      button.addEventListener('click', () => openDetail(job.id));
      actions.append(button);
      root.append(first, status, attempt, owner, actions);
      row = { root, label, meta, status, attempt, owner, signature: '' };
      jobRows.set(job.id, row);
    }
    const signature = JSON.stringify([job.label, job.state, job.attempt, job.generation, job.owner, job.revision]);
    if (signature !== row.signature) {
      row.label.textContent = job.label;
      row.label.title = job.label;
      row.meta.textContent = `${short(job.id)} · ${job.kind === 'digest' ? 'TEXT DIGEST' : 'NUMERIC SERIES'} · G${job.generation}`;
      row.status.replaceChildren(badge(job));
      row.attempt.textContent = `${job.attempt} / ${job.maxAttempts}`;
      row.owner.textContent = job.owner ? job.owner.split('-').slice(0, 2).join('-') : '—';
      row.signature = signature;
    }
    const position = $('job-rows').children[rowIndex++];
    if (position !== row.root) $('job-rows').insertBefore(row.root, position ?? null);
  }
  $('empty-state').hidden = jobs.length > 0;
}

function renderWorkers(workers) {
  const latest = new Map();
  for (const worker of workers) if (!latest.has(worker.slot) || latest.get(worker.slot).started_at < worker.started_at) latest.set(worker.slot, worker);
  const ordered = [...latest.values()].sort((a, b) => a.slot - b.slot);
  const elements = ordered.map(worker => {
    const row = node('div', 'worker-row');
    const indicator = node('span', `worker-indicator${worker.online ? ' online' : ''}`);
    const label = node('div');
    label.append(node('span', 'worker-name', `worker-${worker.slot}`), node('small', '', `PID ${worker.pid} · ${worker.id.split('-').at(-1)}`));
    row.append(indicator, label, node('span', 'worker-phase', worker.online ? worker.phase.toUpperCase() : 'OFFLINE'));
    return row;
  });
  $('worker-list').replaceChildren(...elements);
  const online = ordered.filter(w => w.online).length;
  put('worker-count', `${online} ONLINE`);
  document.querySelectorAll('.worker-light').forEach((light, i) => light.classList.toggle('on', Boolean(ordered[i]?.online)));
}

const descriptions = {
  'job.created': ['created', data => data.label],
  'lease.claimed': ['claimed', data => `${data.workerId} · attempt ${data.attempt} · token ${data.token}`],
  'job.succeeded': ['committed', data => `结果已落盘 · attempt ${data.attempt} · token ${data.token}`],
  'job.retry_scheduled': ['retry_wait', data => `attempt ${data.attempt} 失败 · ${data.error?.code}`],
  'job.dead': ['dead_letter', data => `重试预算耗尽 · ${data.error?.code}`],
  'lease.expired': ['reclaimed', data => `租约过期 · ${data.workerId} · token ${data.token}`],
  'worker.started': ['worker_up', data => `${data.workerId} · PID ${data.pid}`],
  'worker.stopped': ['worker_down', data => `${data.workerId} · ${data.reason}`],
  'request.deduplicated': ['deduplicated', data => `${data.operation} · 已复用原请求结果`],
  'experiment.started': ['experiment', data => `${data.name} · ${data.submissions} 次提交 / ${data.uniqueJobs} 个任务`],
  'job.replayed': ['replayed', data => `开始第 ${data.generation} 次重放 · 保留之前的执行历史`],
  'job.cancelled': ['cancelled', () => '旧租约已撤销，后续提交将被拒绝'],
  'queue.paused': ['paused', () => '停止领取新任务 · 在途任务继续完成'],
  'queue.resumed': ['resumed', () => '恢复领取新任务']
};

function renderEvents(events) {
  const shown = [...events].reverse().slice(0, 8);
  const ids = new Set(shown.map(event => event.seq));
  for (const [id, element] of eventRows) if (!ids.has(id)) { element.remove(); eventRows.delete(id); }
  for (const event of shown) {
    let row = eventRows.get(event.seq);
    if (!row) {
      const [label, description] = descriptions[event.type] ?? [event.type, () => ''];
      row = node('div', 'event-row');
      const type = node('span', `event-type${/expired|stopped|retry|dead/.test(event.type) ? ' failure' : ''}`, label);
      const message = node('span', 'event-message', description(event.data));
      message.title = message.textContent;
      row.append(node('span', 'event-seq', `#${String(event.seq).padStart(4, '0')}`), type, message, node('span', 'event-time', time(event.at)));
      eventRows.set(event.seq, row);
    }
    $('event-list').append(row);
  }
  $('event-empty').hidden = shown.length > 0;
}

function render(snapshot) {
  put('metric-active', snapshot.counts.queued + snapshot.counts.running);
  put('metric-done', snapshot.counts.succeeded);
  put('metric-retry', snapshot.counts.retry_wait);
  put('metric-receipts', snapshot.metrics.receipts);
  put('metric-dedupe', snapshot.metrics.deduplicated);
  put('map-queued', snapshot.counts.queued + snapshot.counts.retry_wait);
  put('total-count', Object.values(snapshot.counts).reduce((a, b) => a + b, 0));
  put('pause-button', snapshot.paused ? '恢复领取' : '暂停领取');
  $('pause-button').setAttribute('aria-pressed', String(snapshot.paused));
  $('older-button').hidden = !snapshot.nextBefore;
  $('latest-button').hidden = !state.before;
  put('page-note', state.before ? '历史分页 · 按创建顺序' : '最近 40 条 · 服务端分页');
  put('throughput-value', snapshot.metrics.completedLastMinute);
  put('average-ms', `${snapshot.metrics.averageExecutionMs} ms`);
  const max = Math.max(1, ...snapshot.series.map(sample => sample.completed));
  const bars = snapshot.series.map(sample => {
    const bar = node('div', `bar${sample.completed ? ' live' : ''}`);
    bar.style.height = `${Math.max(3, Math.round(sample.completed / max * 50))}px`;
    bar.title = `${time(sample.at)} · ${sample.completed} completions`;
    return bar;
  });
  $('throughput-bars').replaceChildren(...bars);
  renderJobs(snapshot.jobs);
  renderWorkers(snapshot.workers);
  renderEvents(snapshot.events);
}

async function openDetail(id) {
  state.detailId = id;
  put('detail-title', '正在读取执行记录…');
  $('detail-content').replaceChildren();
  $('detail-actions').replaceChildren();
  $('detail-dialog').showModal();
  await refreshDetail(id);
}

async function refreshDetail(id) {
  const sequence = ++state.detailRequest;
  try {
    const response = await request(`/api/jobs/${id}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? '详情读取失败。');
    if (sequence !== state.detailRequest || state.detailId !== id || !$('detail-dialog').open) return;
    renderDetail(data.job);
  } catch (error) { if (state.detailId === id) toast(error.message); }
}

let detailSignature = '';
function renderDetail(job) {
  const signature = JSON.stringify(job);
  if (detailSignature === signature && $('detail-content').childElementCount) return;
  detailSignature = signature;
  put('detail-title', job.label);
  const meta = node('div', 'detail-meta');
  meta.append(badge(job), node('code', '', job.id));
  const stats = node('div', 'trace-stats');
  for (const [label, value] of [['ATTEMPTS', `${job.attempt} / ${job.maxAttempts}`], ['REVISION / TOKEN', `${job.revision} / ${job.token}`], ['GENERATION', String(job.generation)]]) {
    const part = node('div');
    part.append(node('span', '', label), node('strong', '', value));
    stats.append(part);
  }
  const timeline = node('div');
  timeline.append(node('h3', 'trace-title', 'ATTEMPT HISTORY'));
  if (!job.attempts.length) timeline.append(node('p', 'receipt-note', '任务尚未被领取。'));
  for (const attempt of job.attempts) {
    const row = node('div', 'attempt-row');
    const body = node('div');
    body.append(node('strong', '', `G${attempt.generation} · ATTEMPT ${attempt.number} · TOKEN ${attempt.token}`));
    body.append(node('p', '', `${attempt.worker_id} · ${time(attempt.started_at)}${attempt.ended_at ? ` → ${time(attempt.ended_at)}` : ' → running'}`));
    if (attempt.error) body.append(node('p', '', JSON.parse(attempt.error).message));
    row.append(node('span', `attempt-dot ${attempt.state}`), body, node('span', 'attempt-state', attempt.state.toUpperCase()));
    timeline.append(row);
  }
  const payload = node('details');
  payload.append(node('summary', '', '查看任务输入与故障配置'), node('pre', '', JSON.stringify(job.definition, null, 2)));
  const children = [meta, stats, timeline, node('h3', 'trace-title', 'COMMIT RECEIPT')];
  const receipts = job.receipts.filter(receipt => receipt.generation === job.generation);
  children.push(node('p', 'receipt-note', `本轮 ${receipts.length} 张持久化结果收据 · 全部历史 ${job.receipts.length} 张`));
  if (job.result) children.push(node('pre', '', JSON.stringify(job.result, null, 2)));
  else if (job.error) children.push(node('pre', '', JSON.stringify(job.error, null, 2)));
  children.push(payload);
  $('detail-content').replaceChildren(...children);
  const actions = [];
  if (['queued', 'running', 'retry_wait'].includes(job.state)) {
    const cancel = node('button', 'secondary', '取消任务');
    cancel.addEventListener('click', () => transition(job, 'cancel', cancel));
    actions.push(cancel);
  }
  if (['dead', 'cancelled'].includes(job.state)) {
    const replay = node('button', 'primary', '清除故障并重放 →');
    replay.addEventListener('click', () => transition(job, 'replay', replay));
    actions.push(replay);
  }
  $('detail-actions').replaceChildren(...actions);
}

async function transition(job, action, button) {
  button.disabled = true;
  try {
    await write(`/api/jobs/${job.id}/transitions`, { action, expectedRevision: job.revision, clearFaults: action === 'replay' });
    toast(action === 'replay' ? '已清除模拟故障，开始新一轮执行。' : '任务已取消，旧 Worker 无法提交结果。');
    await refreshDetail(job.id);
  } catch (error) { toast(error.message); await refreshDetail(job.id); }
  finally { if (button.isConnected) button.disabled = false; }
}

for (const button of document.querySelectorAll('[data-scenario]')) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await write('/api/experiments', { scenario: button.dataset.scenario });
      toast(result.submissions > result.jobIds.length ? `${result.submissions} 次提交，仅创建 ${result.jobIds.length} 个任务。` : '实验已开始，点击任务「追踪」查看真实执行过程。');
      state.filter = '';
      state.before = null;
      updateFilters();
      scheduleRead();
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
}

$('burst-button').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  try { await write('/api/experiments', { scenario: 'burst' }); toast('已提交 24 个真实任务。'); }
  catch (error) { toast(error.message); }
  finally { $('burst-button').disabled = false; }
});

$('pause-button').addEventListener('click', async event => {
  if (!state.snapshot) return;
  event.currentTarget.disabled = true;
  try { await write('/api/control', { paused: !state.snapshot.paused }); toast(state.snapshot.paused ? '已恢复任务领取。' : '已暂停新任务领取；在途任务继续执行。'); }
  catch (error) { toast(error.message); }
  finally { $('pause-button').disabled = false; }
});

function updateFilters() {
  for (const button of document.querySelectorAll('[data-state]')) {
    const active = button.dataset.state === state.filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}
for (const button of document.querySelectorAll('[data-state]')) button.addEventListener('click', () => {
  state.filter = button.dataset.state;
  state.before = null;
  updateFilters();
  refresh();
});
$('older-button').addEventListener('click', () => { state.before = state.snapshot?.nextBefore ?? null; refresh(); });
$('latest-button').addEventListener('click', () => { state.before = null; refresh(); });
$('create-button').addEventListener('click', () => $('create-dialog').showModal());
$('how-button').addEventListener('click', () => $('how-dialog').showModal());
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
$('detail-dialog').addEventListener('close', () => { state.detailId = null; state.detailRequest++; });

$('create-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!$('create-form').reportValidity()) return;
  const form = new FormData(event.currentTarget);
  const body = { label: form.get('label'), kind: form.get('kind'), text: form.get('text'), delayMs: Number(form.get('delayMs')), maxAttempts: Number(form.get('maxAttempts')), priority: Number(form.get('priority')), fault: { failFirst: Number(form.get('failFirst')) } };
  if (new TextEncoder().encode(body.text).length > 12000) { put('form-error', '任务输入不能超过 12 KB。'); return; }
  $('submit-button').disabled = true;
  put('form-error', '');
  try {
    const result = await write('/api/jobs', body);
    $('create-dialog').close();
    toast(`任务 ${short(result.jobId)} 已登记。`);
    state.filter = '';
    state.before = null;
    updateFilters();
    scheduleRead();
  } catch (error) { put('form-error', error.message); }
  finally { $('submit-button').disabled = false; }
});

$('export-button').addEventListener('click', async () => {
  $('export-button').disabled = true;
  try {
    const response = await request('/api/evidence');
    if (!response.ok) throw new Error('执行证据导出失败。');
    const evidence = await response.json();
    const link = node('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json' }));
    link.download = 'faultline-evidence.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast(`已导出 ${evidence.integrity.count} 条事件，哈希链${evidence.integrity.valid ? '校验通过' : '校验失败'}。`);
  } catch (error) { toast(error.message); }
  finally { $('export-button').disabled = false; }
});

setInterval(() => {
  if (state.serverAt) put('server-clock', `${time(clock())} / SERVER`);
}, 1000);
setInterval(() => {
  if (!document.hidden && performance.now() >= state.nextRead) {
    if (!state.token) bootstrap();
    else refresh();
  }
}, 3000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { state.source?.close(); state.source = null; }
  else bootstrap();
});
window.addEventListener('pageshow', event => { if (event.persisted) bootstrap(); });
window.addEventListener('pagehide', () => state.source?.close());
window.addEventListener('online', () => bootstrap());
window.addEventListener('offline', () => { connection(false); banner('网络已断开，输入草稿与已显示记录会保留。'); });
updateFilters();
bootstrap();
