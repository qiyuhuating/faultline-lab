import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error('Run this collector in GitHub Actions with a repository-scoped token.');
const base = `https://api.github.com/repos/${repository}`;
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const BUDGET = 100000000;
let bytes = 0;
async function get(path) {
  const response = await fetch(`${base}${path}`, { headers });
  if (!response.ok) throw new Error(`GitHub metadata returned ${response.status}.`);
  return response.json();
}
async function all(path, property) {
  const values = [];
  for (let page = 1; ; page++) {
    const result = await get(`${path}?per_page=100&page=${page}`);
    const items = result[property];
    if (!Array.isArray(items)) throw new Error('Incomplete GitHub metadata.');
    values.push(...items);
    if (items.length < 100) return values;
  }
}
async function binary(path) {
  const response = await fetch(`${base}${path}`, { headers });
  if (!response.ok) return { omitted: `upstream HTTP ${response.status}` };
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (bytes + length > BUDGET) return { omitted: '100 MB evidence budget' };
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  bytes += buffer.length;
  return { buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
}
const through = Number(process.env.VERIFY_RUN_ID);
if (!Number.isSafeInteger(through) || through < 1) throw new Error('A verification run ID is required.');
const current = await get(`/actions/runs/${through}`);
if (current.conclusion !== 'success' || current.head_sha !== process.env.FAULTLINE_COMMIT) throw new Error('Release requires successful verification of the exact commit.');
const runs = await all('/actions/workflows/verify.yml/runs', 'workflow_runs');
const selected = runs.filter(run => run.run_number <= current.run_number && run.head_branch === 'main' && run.head_repository.full_name === repository && run.status === 'completed');
for (const run of selected) {
  const directory = new URL(`../tests/evidence/ci-run-${String(run.run_number).padStart(4, '0')}/`, import.meta.url);
  mkdirSync(directory, { recursive: true });
  const jobs = await all(`/actions/runs/${run.id}/jobs`, 'jobs');
  const artifacts = await all(`/actions/runs/${run.id}/artifacts`, 'artifacts');
  const metadata = { runId: run.id, runNumber: run.run_number, commit: run.head_sha, url: run.html_url, conclusion: run.conclusion, jobs: [], artifacts: [] };
  for (const job of jobs) {
    const record = { id: job.id, name: job.name, conclusion: job.conclusion, steps: job.steps.map(step => ({ name: step.name, conclusion: step.conclusion })) };
    const downloaded = await binary(`/actions/jobs/${job.id}/logs`);
    if (downloaded.buffer) {
      const filename = `job-${job.id}.log`;
      writeFileSync(new URL(filename, directory), downloaded.buffer);
      record.log = { filename, sha256: downloaded.sha256, bytes: downloaded.buffer.length };
    } else record.log = { omitted: downloaded.omitted };
    metadata.jobs.push(record);
  }
  for (const artifact of artifacts) {
    if (!/^[\w.-]+$/.test(artifact.name)) throw new Error('Unsafe artifact name.');
    const record = { name: artifact.name, id: artifact.id, bytes: artifact.size_in_bytes, expired: artifact.expired, digest: artifact.digest };
    if (artifact.expired || bytes + artifact.size_in_bytes > BUDGET) {
      record.omitted = artifact.expired ? 'expired upstream' : '100 MB evidence budget';
    } else {
      const downloaded = await binary(`/actions/artifacts/${artifact.id}/zip`);
      if (downloaded.buffer) {
        if (artifact.digest && artifact.digest !== `sha256:${downloaded.sha256}`) throw new Error('Upstream artifact digest mismatch.');
        writeFileSync(new URL(`${artifact.name}.zip`, directory), downloaded.buffer);
        record.saved = true;
        record.sha256 = downloaded.sha256;
      } else record.omitted = downloaded.omitted;
    }
    metadata.artifacts.push(record);
  }
  writeFileSync(new URL('run.json', directory), `${JSON.stringify(metadata, null, 2)}\n`);
}
console.log(`Collected ${selected.length} completed CI batches, original job logs and ${bytes} evidence bytes into the independent test package.`);
