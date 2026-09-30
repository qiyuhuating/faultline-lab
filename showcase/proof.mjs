// Portable, side-effect-free acceptance checks. Both live server and trace player
// use the same assertions; these are evidence checks, not scheduling decisions.
export const SCENARIOS = {
  retry: { name: 'Transient failure', question: '前两次失败，第三次是否提交？' },
  crash: { name: 'Process crash', question: '进程消失后，是否换人接管？' },
  duplicate: { name: 'Repeated intent', question: '三次请求，是否只创建一个任务？' },
  dead: { name: 'Dead letter', question: '重试预算是否真的有边界？' },
  fence: { name: 'Zombie worker', question: '过期的 Worker 苏醒后，是否被拒绝？' },
  'response-loss': { name: 'Lost response', question: '写入成功但响应丢失，是否可以确认原结果？' },
  burst: { name: 'Concurrent load', question: '并发领取是否丢失或重复？' }
};

export function evaluateExperiment(experiment, jobs, now = Date.now()) {
  const checks = [];
  const check = (id, label, passed, pending = false, detail = '') => checks.push({ id, label, status: passed ? 'pass' : pending ? 'pending' : 'fail', detail });
  const settled = jobs.every(job => ['succeeded', 'dead', 'cancelled'].includes(job.state));
  const first = jobs[0];
  const attempts = jobs.flatMap(job => job.attempts.filter(a => a.generation === 0));
  const receipts = jobs.flatMap(job => job.receipts.filter(r => r.generation === 0));
  check('exists', '任务记录完整', jobs.length === experiment.jobIds.length && jobs.length > 0);
  check('unique', '每个任务每轮最多一张收据', jobs.every(job => new Set(job.receipts.map(r => r.generation)).size === job.receipts.length));
  check('fencing', '收据来自获胜租约', jobs.every(job => job.receipts.every(r => job.attempts.some(a => a.generation === r.generation && a.token === r.token && a.state === 'succeeded'))));
  if (experiment.scenario === 'duplicate') {
    check('dedupe', '三次提交只产生一个任务', experiment.submissions === 3 && jobs.length === 1, false, `${experiment.submissions} requests / ${jobs.length} job`);
    check('result', '单次执行，单张收据', attempts.length === 1 && receipts.length === 1, !settled, `${attempts.length} attempt / ${receipts.length} receipt`);
  } else if (experiment.scenario === 'retry') {
    check('retry', '两次失败后成功', attempts.map(a => a.state).join(',') === 'failed,failed,succeeded', !settled, attempts.map(a => a.state).join(' → '));
    check('result', '成功结果仅提交一次', receipts.length === 1, !settled);
  } else if (experiment.scenario === 'crash' || experiment.scenario === 'fence') {
    check('reclaim', '过期尝试被新 Worker 接管', attempts.length >= 2 && attempts[0].state === 'expired' && attempts[0].worker_id !== attempts[1].worker_id, !settled);
    check('token', '新租约 token 严格递增', attempts.length >= 2 && attempts[1].token > attempts[0].token, !settled, attempts.map(a => `T${a.token}`).join(' → '));
    check('result', '恢复后只提交一张收据', receipts.length === 1, !settled);
    if (experiment.scenario === 'fence') {
      const rejected = first?.events.find(e => e.type === 'commit.rejected' && e.data.token === attempts[0]?.token && e.data.currentToken > e.data.token);
      check('rejected', '旧 Worker 的真实写入被拒绝', Boolean(rejected), !rejected && now - experiment.createdAt < 15000 && first?.state !== 'cancelled', rejected ? `T${rejected.data.token} rejected / current T${rejected.data.currentToken}` : '等待旧进程苏醒并尝试提交');
    } else {
      check('kill', '记录了实际 SIGKILL 进程退出', Boolean(first?.events.some(e => e.type === 'worker.stopped' && e.data.reason === 'signal:SIGKILL')), !settled);
    }
  } else if (experiment.scenario === 'dead') {
    const enteredDead = first?.events.some(e => e.type === 'job.dead' && e.data.generation === 0);
    check('budget', '三次失败耗尽预算', attempts.length === 3 && attempts.every(a => a.state === 'failed') && Boolean(enteredDead), !settled && first?.generation === 0);
    check('no-result', '失败轮次没有成功收据', receipts.length === 0);
    if (first?.generation > 0) check('replay', '重放生成新轮次并保留旧历史', first.receipts.some(r => r.generation === first.generation), !settled, `generation ${first.generation}`);
  } else if (experiment.scenario === 'response-loss') {
    check('loss', '服务端落盘后主动断开响应', Boolean(first?.events.some(e => e.type === 'response.dropped')), now - experiment.createdAt < 15000);
    check('result', '保留原任务与唯一结果', jobs.length === 1 && attempts.length === 1 && receipts.length === 1, !settled);
  } else if (experiment.scenario === 'burst') {
    check('batch', '24 个独立任务全部保留', jobs.length === 24);
    check('result', '24 个任务各执行并提交一次', attempts.length === 24 && receipts.length === 24 && jobs.every(job => job.state === 'succeeded'), !settled, `${receipts.length} / 24 receipts`);
  } else check('scenario', '已知实验类型', false);
  const status = checks.some(c => c.status === 'fail') ? 'fail' : checks.some(c => c.status === 'pending') ? 'running' : 'pass';
  return { status, checks, scenario: SCENARIOS[experiment.scenario] ?? { name: experiment.scenario, question: '' } };
}
