#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareBranches, sourceAllowsBranch, sourceBranchVersion, sourceNeedsDiscovery, validateSourcePolicy,
} from './source-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
const token = process.env.GITHUB_TOKEN || '';
const headers = { 'User-Agent': 'WeiG-OpenWrt-Menuconfig-Catalog' };
if (token) headers.Authorization = `Bearer ${token}`;
const safeKey = (value) => {
  const raw = String(value);
  const slug = raw.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 110);
  return `${slug}-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
};

async function remoteBranches(repo) {
  const rows = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`https://api.github.com/repos/${repo}/branches?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`${repo} branches: HTTP ${response.status}`);
    const part = await response.json();
    rows.push(...part.map((item) => item.name));
    if (part.length < 100) break;
  }
  return rows;
}

const include = [];
for (const source of config.sources) {
  const policy = validateSourcePolicy(source);
  const branches = sourceNeedsDiscovery(source) ? await remoteBranches(source.repo) : policy.patterns;
  let defaultBranch = '';
  if (source.branches?.preferDefault) {
    const response = await fetch(`https://api.github.com/repos/${source.repo}`, { headers });
    if (!response.ok) throw new Error(`${source.repo} default branch: HTTP ${response.status}`);
    const candidate = (await response.json()).default_branch;
    if (sourceAllowsBranch(source, candidate)) defaultBranch = candidate;
  }
  for (const branch of [...new Set(branches)].filter((item) => sourceAllowsBranch(source, item))
    .sort((left, right) => compareBranches(left, right, source))) {
    if (!/^[A-Za-z0-9._/-]{1,96}$/.test(branch)) throw new Error(`非法分支名:${source.repo}/${branch}`);
    const version = sourceBranchVersion(source, branch);
    include.push({
      source: source.id,
      label: source.label,
      repo: source.repo,
      branch,
      version,
      defaultBranch,
      jobKey: safeKey(`${source.id}-${branch}`),
      metadataCompat: 'metadata-only',
      diy: source.diy,
      legacy: Boolean(source.legacy),
    });
  }
}
if (!include.length) throw new Error('未发现任何源码分支');
const width = Math.max(2, String(include.length + 2).length);
for (const [index, item] of include.entries()) {
  item.order = index + 2;
  item.orderText = String(item.order).padStart(width, '0');
  item.jobName = `${item.orderText} · ${item.label} · ${item.branch} · ${item.repo}`;
  item.artifactPrefix = `${item.orderText}-catalog-${item.jobKey}`;
}
const publishOrderText = String(include.length + 2).padStart(width, '0');
const mapping = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  jobs: [
    { order: 1, orderText: String(1).padStart(width, '0'), jobName: 'Discover / 发现源码分支', artifactPrefix: '01-discover' },
    ...include.map(({ order, orderText, jobName, artifactPrefix, source, repo, branch, version }) => ({
      order, orderText, jobName, artifactPrefix, source, repo, branch, version,
    })),
    {
      order: include.length + 2, orderText: publishOrderText,
      jobName: 'Publish / 发布目录与 Release', artifactPrefix: `${publishOrderText}-publish`,
    },
  ],
};
mkdirSync(join(ROOT, 'diagnostics'), { recursive: true });
writeFileSync(join(ROOT, 'diagnostics', '01-job-artifact-map.json'),
  JSON.stringify(mapping, null, 2) + '\n');
writeFileSync(join(ROOT, 'diagnostics', '01-discover--SUMMARY.txt'), [
  'WeiG Menuconfig Catalog discovery summary',
  `Discovered branches: ${include.length}`,
  `Number width: ${width}`,
  `Generate jobs: 02-${String(include.length + 1).padStart(width, '0')}`,
  `Publish job: ${publishOrderText}`,
  '',
  ...mapping.jobs.map((item) => `${item.orderText} | ${item.jobName} | ${item.artifactPrefix}`),
  '',
].join('\n'));
const matrix = JSON.stringify({ include });
if (process.env.GITHUB_OUTPUT) {
  console.log(`matrix=${matrix}`);
  console.log(`publish-order=${publishOrderText}`);
} else {
  console.log(JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), include }, null, 2));
}
