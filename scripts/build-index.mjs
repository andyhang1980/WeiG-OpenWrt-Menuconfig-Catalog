#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { normalizeCompatibilityDocument } from './compatibility-rules.mjs';
import { buildCuratedApplications } from './curated-applications.mjs';
import { fileContract, indexBody, indexContract, stampIndex } from './index-contract.mjs';
import { compareBranches, sourceAllowsBranch } from './source-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function legacyContract(value) {
  const row = value && typeof value === 'object' ? value : {};
  const explicit = row.legacy && typeof row.legacy === 'object' ? row.legacy : null;
  const source = explicit || row;
  const asset = String(source.asset || '');
  const hash = String(source.hash || source.compressedSha256 || '');
  const bytes = Number(source.bytes || source.compressedBytes || 0);
  if (!asset) return null;
  return {
    asset,
    hash,
    bytes,
    catalogSchema: Number(source.catalogSchema || (explicit ? 0 : 5) || 0),
    relationsSchema: Number(source.relationsSchema || (explicit ? 0 : 2) || 0),
  };
}

function normalizeLegacyMirror(branch) {
  const legacy = legacyContract(branch);
  if (!legacy) return branch;
  return {
    ...branch,
    // Keep the root fields until every schema-5 consumer has migrated.
    asset: legacy.asset,
    hash: legacy.hash,
    bytes: legacy.bytes,
    legacy,
  };
}

function writeCompatibilityAsset(directory, policy) {
  mkdirSync(directory, { recursive: true });
  const compatibility = normalizeCompatibilityDocument(
    JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8')),
    policy,
  );
  const write = (asset, document) => {
    const json = JSON.stringify(document);
    writeFileSync(join(directory, asset), gzipSync(Buffer.from(json), { level: 9 }));
    return { asset, ...fileContract(join(directory, asset)), schema: document.schema,
      rules: document.rules.length, jsonBytes: Buffer.byteLength(json) };
  };
  // One authority, two wire projections: old consumers still see every conflict.
  const legacy = compatibility.schema >= 6 ? { schema: 5,
    rules: compatibility.rules.map(({ preferredDisable, ...rule }) => rule) } : compatibility;
  return {
    compatibility,
    contract: write('compatibility.json.gz', legacy),
    ...(compatibility.schema >= 6 ? { v6Contract: write('compatibility.v6.json.gz', compatibility) } : {}),
  };
}

function writeApplicationsAsset(directory) {
  mkdirSync(directory, { recursive: true });
  const applications = buildCuratedApplications(ROOT);
  const asset = 'applications.json.gz';
  const json = JSON.stringify(applications);
  writeFileSync(join(directory, asset), gzipSync(Buffer.from(json), { level: 9 }));
  return {
    applications,
    contract: {
      asset,
      ...fileContract(join(directory, asset)),
      schema: applications.schema,
      items: applications.items.length,
      jsonBytes: Buffer.byteLength(json),
    },
  };
}

const fastAssetMode = process.argv[2] === '--compatibility-only' ? 'compatibility'
  : process.argv[2] === '--applications-only' ? 'applications' : '';
if (fastAssetMode) {
  const previousFile = resolve(process.argv[3] || '');
  const out = resolve(process.argv[4] || previousFile);
  if (!previousFile || !existsSync(previousFile)) {
    throw new Error(`${fastAssetMode}-only mode requires an existing index.json`);
  }
  const previous = JSON.parse(readFileSync(previousFile, 'utf8'));
  if (!Array.isArray(previous.sources) || previous.assets?.compatibility?.asset !== 'compatibility.json.gz' ||
      previous.assets?.applications?.asset !== 'applications.json.gz') {
    throw new Error(`${fastAssetMode}-only mode requires a complete existing Catalog index`);
  }
  const expectedIndex = indexContract(previous);
  if (previous.hash !== expectedIndex.hash || previous.bytes !== expectedIndex.bytes) {
    throw new Error(`${fastAssetMode}-only mode rejected an invalid existing index contract`);
  }
  const assetName = `${fastAssetMode}.json.gz`;
  const previousAsset = join(dirname(previousFile), assetName);
  if (!existsSync(previousAsset)) {
    throw new Error(`${fastAssetMode}-only mode requires the existing ${fastAssetMode} asset`);
  }
  const actualAsset = fileContract(previousAsset);
  const expectedAsset = previous.assets[fastAssetMode];
  if (actualAsset.hash !== expectedAsset.hash || actualAsset.bytes !== expectedAsset.bytes) {
    throw new Error(`${fastAssetMode}-only mode rejected an invalid existing ${fastAssetMode} contract`);
  }
  const policy = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
  const generated = fastAssetMode === 'compatibility'
    ? writeCompatibilityAsset(dirname(out), policy)
    : writeApplicationsAsset(dirname(out));
  const body = indexBody(previous);
  const next = stampIndex({
    ...body,
    assets: { ...body.assets, [fastAssetMode]: generated.contract,
      ...(generated.v6Contract ? { compatibilityV6: generated.v6Contract } : {}) },
  });
  writeFileSync(out, JSON.stringify(next, null, 2) + '\n');
  const count = fastAssetMode === 'compatibility'
    ? `${generated.compatibility.rules.length} rules`
    : `${generated.applications.items.length} items`;
  console.log(`index.json: ${fastAssetMode}-only ${count} bytes=${generated.contract.bytes}`);
  process.exit(0);
}
const dir = resolve(process.argv[2] || join(ROOT, 'dist'));
const out = resolve(process.argv[3] || join(dir, 'index.json'));
const previousFile = process.argv[4] ? resolve(process.argv[4]) : '';
const attemptsDir = process.argv[5] ? resolve(process.argv[5]) : '';
const rows = readdirSync(dir).filter((name) => name.endsWith('.meta.json')).sort()
  .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
const previous = previousFile && existsSync(previousFile)
  ? JSON.parse(readFileSync(previousFile, 'utf8')) : { sources: [] };
const attempts = attemptsDir && existsSync(attemptsDir)
  ? readdirSync(attemptsDir).filter((name) => name.endsWith('.attempt.json')).sort()
    .map((name) => JSON.parse(readFileSync(join(attemptsDir, name), 'utf8')))
  : [];
const currentKeys = new Set(rows.map((row) => `${row.source.id}\0${row.source.branch}`));
if (!rows.length && !(previous.sources || []).length && !attempts.length) {
  throw new Error('没有当前、历史或失败状态数据');
}
const policy = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
const { compatibility, contract: compatibilityContract, v6Contract } = writeCompatibilityAsset(dir, policy);
const { applications, contract: applicationsContract } = writeApplicationsAsset(dir);
const sources = (previous.sources || []).filter((source) => policy.sources.some((item) => item.id === source.id))
  .map((source) => {
    const rule = policy.sources.find((item) => item.id === source.id);
    return {
      ...source,
      build: rule.build,
      branches: (source.branches || []).filter((branch) =>
        sourceAllowsBranch(rule, branch.branch))
        .map((branch) => normalizeLegacyMirror({ ...branch })),
    };
  });
for (const row of rows) {
  let source = sources.find((item) => item.id === row.source.id);
  if (!source) {
    source = {
      id: row.source.id, label: row.source.label || row.source.id,
      repo: row.source.repo, legacy: row.source.legacy,
      build: policy.sources.find((item) => item.id === row.source.id)?.build,
      branches: [],
    };
    sources.push(source);
  }
  source.label = row.source.label || source.label || row.source.id;
  source.build = policy.sources.find((item) => item.id === row.source.id)?.build;
  const legacy = legacyContract(row);
  if (!legacy || legacy.catalogSchema < 5 || legacy.relationsSchema < 2) {
    throw new Error(`meta lacks an explicit legacy build contract: ${row.source.id}/${row.source.branch}`);
  }
  const branch = normalizeLegacyMirror({
    id: row.source.branch.startsWith('openwrt-') ? row.source.branch.slice(8) : row.source.branch,
    version: row.source.branch.startsWith('openwrt-') ? row.source.branch.slice(8) : row.source.branch,
    branch: row.source.branch, counts: row.counts,
    commit: row.commit || row.source.commit || '',
    ...(row.buildInputs ? { buildInputs: row.buildInputs, inputsHash: row.source.inputsHash } : {}),
    legacy,
    assets: row.assets || {},
    schema: Number(row.schema || 5),
    sizeReport: row.sizeReport || {},
    state: 'fresh',
    lastSuccessAt: row.generatedAt || new Date().toISOString(),
  });
  const oldAt = source.branches.findIndex((item) => item.branch === branch.branch);
  if (oldAt >= 0) source.branches[oldAt] = branch;
  else source.branches.push(branch);
}
for (const attempt of attempts) {
  let source = sources.find((item) => item.id === attempt.source.id);
  if (!source) {
    source = {
      ...attempt.source,
      build: policy.sources.find((item) => item.id === attempt.source.id)?.build,
      branches: [],
    };
    sources.push(source);
  }
  let branch = source.branches.find((item) => item.branch === attempt.branch);
  if (!branch) {
    branch = {
      id: attempt.branch.startsWith('openwrt-') ? attempt.branch.slice(8) : attempt.branch,
      branch: attempt.branch,
    };
    source.branches.push(branch);
  }
  branch.lastAttemptAt = attempt.attemptedAt;
  branch.runUrl = attempt.runUrl;
  branch.version = attempt.version || branch.version || branch.id;
  branch.lastAttemptCommit = attempt.upstreamCommit || '';
  branch.compatibilityMode = attempt.compatibilityMode || 'native';
  branch.artifactName = attempt.artifactName || '';
  branch.order = attempt.order || 0;
  branch.orderText = attempt.orderText || '';
  branch.jobName = attempt.jobName || '';
  branch.failureLog = attempt.failureLog || '';
  if (attempt.status === 'success' && currentKeys.has(`${attempt.source.id}\0${attempt.branch}`)) {
    branch.state = 'fresh';
    branch.errorStage = '';
  } else if (attempt.status === 'success') {
    branch.state = branch.asset ? 'stale' : 'unavailable';
    branch.errorStage = 'publish-download';
  } else if (attempt.status === 'failure') {
    branch.state = branch.asset ? 'stale' : 'unavailable';
    branch.errorStage = attempt.stage || 'unknown';
  }
}
for (const source of sources) source.branches.sort((a, b) => compareBranches(a.branch, b.branch));
const branchRows = sources.flatMap((source) => source.branches);
const generatedAt = new Date().toISOString();
const body = {
  schema: 2,
  generatedAt,
  commit: process.env.CATALOG_COMMIT || '',
  completeReleaseTag: 'menuconfig-catalog-complete',
  health: {
    fresh: branchRows.filter((item) => item.state === 'fresh').length,
    stale: branchRows.filter((item) => item.state === 'stale').length,
    unavailable: branchRows.filter((item) => item.state === 'unavailable').length,
  },
  assets: { compatibility: compatibilityContract, applications: applicationsContract,
    ...(v6Contract ? { compatibilityV6: v6Contract } : {}) },
  sources,
};
writeFileSync(
  out,
  JSON.stringify(stampIndex(body), null, 2) + '\n',
);
console.log(`index.json: ${sources.length} sources / ${branchRows.length} branches` +
  ` (fresh=${branchRows.filter((item) => item.state === 'fresh').length}` +
  ` stale=${branchRows.filter((item) => item.state === 'stale').length}` +
  ` unavailable=${branchRows.filter((item) => item.state === 'unavailable').length})` +
  ` / compatibility=${compatibility.rules.length} rules, ${compatibilityContract.bytes} bytes` +
  ` / applications=${applications.items.length}, ${applicationsContract.bytes} bytes`);
