import { SCENARIOS, evaluateExperiment } from './proof.mjs';
import { verifyEvidence } from './evidence.mjs';

const $ = id => document.getElementById(id);
const element = (tag, className = '', text = '') => { const e = document.createElement(tag); e.className = className; e.textContent = text; return e; };
const svg = (tag, attributes, text = '') => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [name, value] of Object.entries(attributes)) e.setAttribute(name, String(value)); e.textContent = text; return e; };
const short = id => id ? id.slice(0, 8) : '—';
let bundle, report, events = [], frame = 0, timer = null;
const statusNames = { queued: 'QUEUED', running: 'RUNNING', retry_wait: 'RETRY WAIT', succeeded: 'SUCCEEDED', dead: 'DEAD LETTER', cancelled: 'CANCELLED' };

function pause() { clearInterval(timer); timer = null; $('play-button').textContent = '▶ 播放'; $('play-button').setAttribute('aria-label', '播放轨迹'); }
function play() {
  if (timer) { pause(); return; }
  if (frame >= events.length - 1) frame = 0;
  $('play-button').textContent = 'Ⅱ 暂停';
  $('play-button').setAttribute('aria-label', '暂停轨迹');
  timer = setInterval(() => { frame++; renderFrame(); if (frame >= events.length - 1) pause(); }, Number($('speed').value));
}

function selectReport(next) {
  pause(); report = next; frame = 0;
  events = report.jobs.flatMap(job => job.events).sort((a, b) => a.seq - b.seq);
  $('scrub').max = String(Math.max(0, events.length - 1));
  $('scenario-tag').textContent = SCENARIOS[report.experiment.scenario].name.toUpperCase();
  $('scenario-question').textContent = SCENARIOS[report.experiment.scenario].question;
  const verdict = evaluateExperiment(report.experiment, report.jobs, report.serverTime);
  $('final-verdict').textContent = `FINAL ${verdict.status.toUpperCase()}`;
  $('final-verdict').className = `pill ${verdict.status}`;
  document.querySelectorAll('[data-scenario]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.scenario === report.experiment.scenario)));
  const checks = verdict.checks.map(check => {
    const root = element('article', `check ${check.status}`);
    root.append(element('span', 'check-mark', check.status === 'pass' ? '✓' : '×'), element('strong', '', check.label), element('small', '', check.detail || check.status.toUpperCase()));
    return root;
  });
  $('checks').replaceChildren(...checks);
  renderFrame();
}

function renderFrame() {
  const current = events[frame];
  if (!current) return;
  $('scrub').value = String(frame);
  $('frame-number').textContent = `${String(frame + 1).padStart(2, '0')} / ${events.length}`;
  $('frame-time').textContent = `+${((current.at - report.experiment.createdAt) / 1000).toFixed(2)}s`;
  const currentJobs = new Map();
  let attempts = 0, receipts = 0, token = 0, owner = '—', status = 'queued';
  for (const event of events.slice(0, frame + 1)) {
    const job = currentJobs.get(event.jobId) ?? { state: 'queued', token: 0, owner: null };
    if (event.type === 'lease.claimed') { attempts++; job.state = 'running'; job.token = event.data.token; job.owner = event.data.workerId; }
    else if (event.type === 'job.succeeded') { receipts++; job.state = 'succeeded'; job.owner = null; }
    else if (event.type === 'job.dead') { job.state = 'dead'; job.owner = null; }
    else if (event.type === 'lease.expired') { job.state = event.data.nextState; job.owner = null; }
    else if (event.type === 'job.retry_scheduled') { job.state = 'retry_wait'; job.owner = null; }
    else if (event.type === 'job.cancelled') { job.state = 'cancelled'; job.owner = null; }
    else if (event.type === 'job.replayed') { job.state = 'queued'; job.owner = null; }
    if (event.jobId) currentJobs.set(event.jobId, job);
  }
  const focused = currentJobs.get(current.jobId) ?? [...currentJobs.values()].at(-1);
  if (focused) { ({ state: status, token, owner } = focused); }
  $('frame-state').textContent = current.type === 'commit.rejected' ? 'STALE COMMIT REJECTED' : statusNames[status] ?? status.toUpperCase();
  $('frame-state').className = status;
  $('frame-attempts').textContent = String(attempts);
  $('frame-token').textContent = `T${token}`;
  $('frame-receipts').textContent = String(receipts);
  $('frame-owner').textContent = owner ? owner.split('-').slice(0, 2).join('-') : '—';
  const focusedSeq = $('event-rows').contains(document.activeElement) ? document.activeElement.dataset.seq : null;
  const rows = events.map((event, i) => {
    const row = element('button', `event-row${i === frame ? ' selected' : ''}${i > frame ? ' future' : ''}`);
    row.type = 'button'; row.dataset.seq = event.seq;
    row.setAttribute('aria-current', i === frame ? 'step' : 'false');
    row.append(element('code', '', `#${event.seq}`), element('span', 'event-name', event.type), element('span', 'event-detail', event.data.token ? `T${event.data.token}` : short(event.jobId)), element('time', '', `+${((event.at - report.experiment.createdAt) / 1000).toFixed(2)}s`));
    row.addEventListener('click', () => { pause(); frame = i; renderFrame(); });
    return row;
  });
  $('event-rows').replaceChildren(...rows);
  if (focusedSeq) rows.find(row => row.dataset.seq === focusedSeq)?.focus({ preventScroll: true });
  drawLanes(current.at);
}

function drawLanes(at) {
  const all = report.jobs.flatMap(job => job.attempts).slice(0, 4);
  const origin = report.experiment.createdAt;
  const end = Math.max(origin + 1, ...events.map(e => e.at), ...all.map(a => a.ended_at ?? a.started_at));
  const scale = value => 140 + Math.max(0, Math.min(1, (value - origin) / (end - origin))) * 650;
  const children = [];
  for (let i = 0; i <= 4; i++) {
    const x = 140 + i * 162.5;
    children.push(svg('line', { x1: x, x2: x, y1: 12, y2: 155, class: 'grid-line' }), svg('text', { x, y: 175, class: 'axis-text', 'text-anchor': 'middle' }, `${((end - origin) * i / 4000).toFixed(1)}s`));
  }
  all.forEach((attempt, i) => {
    const y = 18 + i * 34;
    children.push(svg('text', { x: 0, y: y + 15, class: 'lane-label' }, `ATTEMPT ${attempt.number} / T${attempt.token}`));
    if (at < attempt.started_at) return;
    const x = scale(attempt.started_at), width = Math.max(3, scale(Math.min(at, attempt.ended_at ?? end)) - x);
    const ended = attempt.ended_at && at >= attempt.ended_at;
    children.push(svg('rect', { x, y, width, height: 24, rx: 4, class: `attempt-bar ${ended ? attempt.state : 'running'}` }));
    if (ended && width > 90) children.push(svg('text', { x: x + 9, y: y + 16, class: 'bar-label' }, attempt.state.toUpperCase()));
  });
  children.push(svg('line', { x1: scale(at), x2: scale(at), y1: 8, y2: 157, class: 'playhead' }));
  $('lanes').replaceChildren(...children);
}

$('play-button').addEventListener('click', play);
$('reset-button').addEventListener('click', () => { pause(); frame = 0; renderFrame(); });
$('scrub').addEventListener('input', () => { pause(); frame = Number($('scrub').value); renderFrame(); });
$('speed').addEventListener('change', () => { if (timer) { pause(); play(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
$('download-button').addEventListener('click', () => {
  const a = element('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })); a.download = 'faultline-recorded-traces.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

try {
  const response = await fetch('./traces.json');
  if (!response.ok) throw new Error('无法载入真实实验记录。');
  bundle = await response.json();
  if (bundle.format !== 'faultline-recorded-traces-v1' || !Array.isArray(bundle.reports) || bundle.reports.length !== 6) throw new Error('轨迹格式不完整。');
  const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  await verifyEvidence(bundle.evidence, hash);
  // Every displayed event must match the chain-verified original, rather than
  // trusting a second unverified copy in the convenience report structure.
  const originals = new Map(bundle.evidence.events.map(e => [e.seq, JSON.stringify(e)]));
  for (const r of bundle.reports) for (const job of r.jobs) for (const event of job.events) if (originals.get(event.seq) !== JSON.stringify(event)) throw new Error('报告事件与哈希链记录不一致。');
  $('chain-status').textContent = `${bundle.evidence.events.length} EVENTS / CHAIN VERIFIED`;
  $('recording-date').textContent = `RECORDED ${new Date(bundle.recordedAt).toISOString().slice(0, 10)} / ${bundle.environment.node}`;
  const buttons = bundle.reports.map((r, index) => {
    const button = element('button', 'scenario'); button.dataset.scenario = r.experiment.scenario;
    button.append(element('span', 'scenario-number', String(index + 1).padStart(2, '0')), element('strong', '', SCENARIOS[r.experiment.scenario].name), element('small', '', SCENARIOS[r.experiment.scenario].question), element('span', 'scenario-link', '查看真实轨迹 ↗'));
    button.addEventListener('click', () => selectReport(r)); return button;
  });
  $('scenarios').replaceChildren(...buttons);
  selectReport(bundle.reports[0]);
} catch (error) {
  $('load-error').hidden = false; $('load-error').textContent = `记录无法校验，停止回放。${error.message}`;
  $('chain-status').textContent = 'VERIFICATION FAILED';
  for (const id of ['play-button', 'reset-button', 'scrub', 'download-button']) $(id).disabled = true;
}
