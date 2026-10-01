import { mkdirSync, writeFileSync } from 'node:fs';

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error('Run this collector in GitHub Actions with a repository-scoped token.');
const base = `https://api.github.com/repos/${repository}`;
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function get(path) {
  const response = await fetch(`${base}${path}`, { headers });
  if (!response.ok) throw new Error(`GitHub metadata returned ${response.status}.`);
  return response.json();
}
const through = Number(process.env.VERIFY_RUN_ID);
const { workflow_runs: runs } = await get('/actions/workflows/verify.yml/runs?per_page=100');
const current = runs.find(run => run.id === through);
if (!current || current.conclusion !== 'success') throw new Error('Release requires a successful verification run.');
const selected = runs.filter(run => run.run_number <= current.run_number && run.head_branch === 'main' && run.status === 'completed');
let bytes = 0;
for (const run of selected) {
  const directory = new URL(`../tests/evidence/ci-run-${String(run.run_number).padStart(4, '0')}/`, import.meta.url);
  mkdirSync(directory, { recursive: true });
  const { jobs } = await get(`/actions/runs/${run.id}/jobs?per_page=100`);
  const { artifacts } = await get(`/actions/runs/${run.id}/artifacts?per_page=100`);
  const metadata = { runId: run.id, runNumber: run.run_number, commit: run.head_sha, url: run.html_url, conclusion: run.conclusion, jobs: jobs.map(job => ({ name: job.name, conclusion: job.conclusion, steps: job.steps.map(step => ({ name: step.name, conclusion: step.conclusion })) })), artifacts: [] };
  for (const artifact of artifacts) {
    if (!/^[\w.-]+$/.test(artifact.name)) throw new Error('Unsafe artifact name.');
    const record = { name: artifact.name, id: artifact.id, bytes: artifact.size_in_bytes, expired: artifact.expired, digest: artifact.digest };
    if (artifact.expired || bytes + artifact.size_in_bytes > 100000000) {
      record.omitted = artifact.expired ? 'expired upstream' : '100 MB evidence budget';
    } else {
      const response = await fetch(`${base}/actions/artifacts/${artifact.id}/zip`, { headers });
      if (!response.ok) throw new Error(`Artifact download returned ${response.status}.`);
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(new URL(`${artifact.name}.zip`, directory), buffer);
      bytes += buffer.length;
      record.saved = true;
    }
    metadata.artifacts.push(record);
  }
  writeFileSync(new URL('run.json', directory), `${JSON.stringify(metadata, null, 2)}\n`);
}
console.log(`Collected ${selected.length} completed CI batches and ${bytes} artifact bytes into the independent test package.`);
