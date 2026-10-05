#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const expectedRuleCount = JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8')).rules.length;
const temp = mkdtempSync(join(tmpdir(), 'weig-catalog-index-'));
const dist = join(temp, 'dist');
const attempts = join(temp, 'attempts');
mkdirSync(dist);
mkdirSync(attempts);
try {
  writeFileSync(join(temp, 'previous.json'), JSON.stringify({
    schema: 1,
    sources: [{
      id: 'ImmortalWrt', label: 'ImmortalWrt', repo: 'immortalwrt/immortalwrt', branches: [
        { id: '23.05', branch: 'openwrt-23.05', asset: 'immortalwrt--openwrt-23.05.json.gz', state: 'fresh', lastSuccessAt: '2026-01-01T00:00:00Z' },
        { id: '21.02', branch: 'openwrt-21.02', asset: 'immortalwrt--openwrt-21.02.json.gz', state: 'fresh', lastSuccessAt: '2026-01-01T00:00:00Z' },
      ],
    }],
  }));
  writeFileSync(join(dist, 'immortalwrt--openwrt-23.05.meta.json'), JSON.stringify({
    source: { id: 'ImmortalWrt', label: 'ImmortalWrt', repo: 'immortalwrt/immortalwrt', branch: 'openwrt-23.05', commit: 'abcdef' },
    counts: { targets: 1, profiles: 1, menuOptions: 10, packages: 20 },
    asset: 'immortalwrt--openwrt-23.05.json.gz',
    generatedAt: '2026-07-29T00:00:00Z',
    hash: 'catalog-hash', bytes: 1234, schema: 6,
    legacy: {
      asset: 'immortalwrt--openwrt-23.05.json.gz', hash: 'catalog-hash', bytes: 1234,
      catalogSchema: 5, relationsSchema: 2,
    },
    assets: {
      core: { asset: 'immortalwrt--openwrt-23.05.core.json.gz', hash: 'core-hash', bytes: 222 },
      graph: { asset: 'immortalwrt--openwrt-23.05.graph.json.gz', hash: 'graph-hash', bytes: 333 },
    },
    sizeReport: { split: { initialBytes: 555 } },
  }));
  const attempt = (branch, status, stage, order) => ({
    schema: 2,
    source: { id: 'ImmortalWrt', label: 'ImmortalWrt', repo: 'immortalwrt/immortalwrt', legacy: false },
    branch, version: branch.slice(8), upstreamCommit: 'attempt123',
    order, orderText: String(order).padStart(2, '0'),
    jobName: `${String(order).padStart(2, '0')} · ImmortalWrt · ${branch}`,
    compatibilityMode: 'native', artifactName: `catalog-immortalwrt-${branch}`,
    failureLog: status === 'failure' ? `immortalwrt-${branch}--${stage}.log` : '',
    status, stage, attemptedAt: '2026-07-29T00:10:00Z', runUrl: 'https://example.invalid/run/1',
  });
  writeFileSync(join(attempts, '23.attempt.json'), JSON.stringify(attempt('openwrt-23.05', 'success', 'complete', 3)));
  writeFileSync(join(attempts, '21.attempt.json'), JSON.stringify(attempt('openwrt-21.02', 'failure', 'defconfig', 2)));
  writeFileSync(join(attempts, '24.attempt.json'), JSON.stringify(attempt('openwrt-24.10', 'failure', 'feeds', 4)));
  const out = join(dist, 'index.json');
  execFileSync(process.execPath, [
    join(ROOT, 'scripts', 'build-index.mjs'), dist, out, join(temp, 'previous.json'), attempts,
  ], { stdio: 'pipe' });
  const index = JSON.parse(readFileSync(out, 'utf8'));
  if (index.schema !== 2) throw new Error('index schema 2 missing');
  if (index.assets?.compatibility?.asset !== 'compatibility.json.gz' ||
      !/^[a-f0-9]{64}$/.test(index.assets.compatibility.hash) ||
      index.assets.compatibility.bytes <= 0 || index.assets.compatibility.schema !== 5 ||
      index.assets.compatibility.rules !== expectedRuleCount || index.assets.compatibility.jsonBytes <= 0 ||
      index.assets.compatibility.jsonBytes > 512 * 1024) {
    throw new Error('global compatibility asset contract missing');
  }
  if (index.assets?.applications?.asset !== 'applications.json.gz' ||
      !/^[a-f0-9]{64}$/.test(index.assets.applications.hash) ||
      index.assets.applications.bytes <= 0 || index.assets.applications.schema !== 1 ||
      index.assets.applications.items <= 0 || index.assets.applications.jsonBytes <= 0) {
    throw new Error('global applications asset contract missing');
  }
  const branches = index.sources.find((source) => source.id === 'ImmortalWrt').branches;
  const main = branches.find((branch) => branch.branch === 'openwrt-23.05');
  const old = branches.find((branch) => branch.branch === 'openwrt-21.02');
  const never = branches.find((branch) => branch.branch === 'openwrt-24.10');
  if (main.state !== 'fresh' || main.commit !== 'abcdef') throw new Error('fresh branch merge failed');
  if (main.hash !== 'catalog-hash' || main.bytes !== 1234 || main.schema !== 6 ||
      main.legacy?.asset !== main.asset || main.legacy?.hash !== main.hash ||
      main.legacy?.bytes !== main.bytes || main.legacy?.catalogSchema !== 5 ||
      main.legacy?.relationsSchema !== 2 || main.assets?.core?.hash !== 'core-hash' || main.assets?.graph?.bytes !== 333 ||
      main.sizeReport?.split?.initialBytes !== 555 || !index.generatedAt ||
      !index.hash || !index.bytes) throw new Error('catalog index metadata/split assets missing');
  if (old.state !== 'stale' || !old.asset || old.errorStage !== 'defconfig' ||
      old.legacy?.asset !== old.asset || old.legacy?.catalogSchema !== 5 || old.legacy?.relationsSchema !== 2) throw new Error('stale branch merge failed');
  if (never.state !== 'unavailable' || never.asset || never.errorStage !== 'feeds') throw new Error('unavailable branch merge failed');
  if (old.version !== '21.02' || old.lastAttemptCommit !== 'attempt123' ||
      old.failureLog !== 'immortalwrt-openwrt-21.02--defconfig.log' ||
      !old.artifactName || old.orderText !== '02' ||
      !old.jobName.startsWith('02 ·')) throw new Error('diagnostic metadata merge failed');
  if (index.health.fresh !== 1 || index.health.stale !== 1 || index.health.unavailable !== 1) {
    throw new Error('health counts failed');
  }
  const fastDir = join(temp, 'fast');
  mkdirSync(fastDir);
  const fastOut = join(fastDir, 'index.json');
  execFileSync(process.execPath, [
    join(ROOT, 'scripts', 'build-index.mjs'), '--compatibility-only', out, fastOut,
  ], { stdio: 'pipe' });
  const fast = JSON.parse(readFileSync(fastOut, 'utf8'));
  if (JSON.stringify(fast.sources) !== JSON.stringify(index.sources) ||
      JSON.stringify(fast.health) !== JSON.stringify(index.health) ||
      fast.generatedAt !== index.generatedAt || fast.assets.compatibility.schema !== 5 ||
      fast.assets.compatibility.rules !== expectedRuleCount || fast.assets.compatibilityV6?.schema !== 6) {
    throw new Error('compatibility-only publish changed non-compatibility Catalog data');
  }
  const firstFast = readFileSync(fastOut, 'utf8');
  execFileSync(process.execPath, [
    join(ROOT, 'scripts', 'build-index.mjs'), '--compatibility-only', fastOut, fastOut,
  ], { stdio: 'pipe' });
  if (readFileSync(fastOut, 'utf8') !== firstFast) {
    throw new Error('identical compatibility-only publish was not deterministic');
  }
  const applicationDir = join(temp, 'applications-fast');
  mkdirSync(applicationDir);
  const applicationOut = join(applicationDir, 'index.json');
  execFileSync(process.execPath, [
    join(ROOT, 'scripts', 'build-index.mjs'), '--applications-only', out, applicationOut,
  ], { stdio: 'pipe' });
  const applicationFast = JSON.parse(readFileSync(applicationOut, 'utf8'));
  if (JSON.stringify(applicationFast.sources) !== JSON.stringify(index.sources) ||
      JSON.stringify(applicationFast.health) !== JSON.stringify(index.health) ||
      applicationFast.generatedAt !== index.generatedAt ||
      applicationFast.assets.applications.schema !== 1 ||
      applicationFast.assets.applications.items !== index.assets.applications.items) {
    throw new Error('applications-only publish changed branch Catalog data');
  }
  const firstApplicationsFast = readFileSync(applicationOut, 'utf8');
  execFileSync(process.execPath, [
    join(ROOT, 'scripts', 'build-index.mjs'), '--applications-only', applicationOut, applicationOut,
  ], { stdio: 'pipe' });
  if (readFileSync(applicationOut, 'utf8') !== firstApplicationsFast) {
    throw new Error('identical applications-only publish was not deterministic');
  }
  writeFileSync(fastOut, JSON.stringify({ ...fast, hash: '0'.repeat(64) }));
  let invalidIndexRejected = false;
  try {
    execFileSync(process.execPath, [
      join(ROOT, 'scripts', 'build-index.mjs'), '--compatibility-only', fastOut, fastOut,
    ], { stdio: 'pipe' });
  } catch {
    invalidIndexRejected = true;
  }
  writeFileSync(fastOut, firstFast);
  const fastAsset = join(fastDir, 'compatibility.json.gz');
  const validAsset = readFileSync(fastAsset);
  writeFileSync(fastAsset, Buffer.from('tampered'));
  let invalidAssetRejected = false;
  try {
    execFileSync(process.execPath, [
      join(ROOT, 'scripts', 'build-index.mjs'), '--compatibility-only', fastOut, fastOut,
    ], { stdio: 'pipe' });
  } catch {
    invalidAssetRejected = true;
  }
  writeFileSync(fastAsset, validAsset);
  if (!invalidIndexRejected || !invalidAssetRejected) {
    throw new Error('compatibility-only publish accepted a tampered contract');
  }
  console.log('catalog index checks passed: fresh=1 stale=1 unavailable=1 compatibility=3 root-assets=stable');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
