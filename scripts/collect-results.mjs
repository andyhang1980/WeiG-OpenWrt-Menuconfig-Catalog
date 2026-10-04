#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { basename, join, resolve } from 'node:path';
import { safeSlug } from './lib.mjs';
import { validateProfileBaselineDocument } from './profile-config-contract.mjs';

const [rawArg = 'current', previousArg = 'previous', distArg = 'dist',
  attemptsArg = 'current-attempts', diagnosticsArg = 'publish-diagnostics'] = process.argv.slice(2);
const rawDir = resolve(rawArg);
const previousDir = resolve(previousArg);
const distDir = resolve(distArg);
const attemptsDir = resolve(attemptsArg);
const diagnosticsDir = resolve(diagnosticsArg);
for (const dir of [distDir, attemptsDir, diagnosticsDir]) mkdirSync(dir, { recursive: true });

const walk = (dir) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((name) => {
    const file = join(dir, name);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });
};
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const warnings = [];
const fatalErrors = [];
const copied = new Map();
const copyUnique = (file, dir, scope) => {
  const name = basename(file);
  const hash = digest(file);
  const key = `${dir}\0${name}`;
  if (copied.has(key) && copied.get(key) !== hash) {
    warnings.push(`${scope}:同名不同内容文件 ${name}`);
    return false;
  }
  copyFileSync(file, join(dir, name));
  copied.set(key, hash);
  return true;
};

// Reports remain required producer evidence, not runtime assets. Older
// snapshots stay addressable; carrying last-good may not republish retired
// duplicate graphs or human-readable reports into the new snapshot.
const isDiagnosticAsset = (file) =>
  /\.(?:relations(?:\.debug)?\.json(?:\.gz)?|translations\.json|contract\.json|duplicates\.json|curated-candidates\.json)$/.test(file);
for (const file of walk(previousDir).filter((item) =>
  item.endsWith('.json.gz') && !isDiagnosticAsset(item))) {
  copyFileSync(file, join(distDir, basename(file)));
}
for (const name of ['i18n-cache.json', 'translation-state.json', 'translation-retry-queue.json']) {
  const file = join(previousDir, name);
  if (existsSync(file)) copyFileSync(file, join(distDir, name));
}
const fallbackState = (attempt) => {
  const asset = `${safeSlug(attempt.source?.id)}--${safeSlug(attempt.branch)}.json.gz`;
  return existsSync(join(distDir, asset)) ? 'last-good' : 'unavailable';
};

const artifactDirs = existsSync(rawDir)
  ? readdirSync(rawDir).sort().map((name) => join(rawDir, name))
    .filter((item) => statSync(item).isDirectory())
  : [];
const attempts = [];
const branches = [];
let acceptedFiles = 0;
for (const artifactDir of artifactDirs) {
  const artifactName = basename(artifactDir);
  const files = walk(artifactDir);
  const accepted = files.filter((file) =>
    /\.(json\.gz|meta\.json|contract\.json|relations\.json|translations\.json|duplicates\.json|curated-candidates\.json|attempt\.json|log)$/.test(file) ||
    file.endsWith('--SUMMARY.txt'));
  acceptedFiles += accepted.length;
  for (const file of accepted.filter((item) =>
    item.endsWith('.attempt.json') || item.endsWith('--SUMMARY.txt') || item.endsWith('.log'))) {
    copyUnique(file, attemptsDir, artifactName);
  }
  const attemptFiles = accepted.filter((file) => file.endsWith('.attempt.json'));
  if (attemptFiles.length !== 1) {
    warnings.push(`${artifactName}:attempt 数量=${attemptFiles.length},已隔离`);
    continue;
  }
  let attempt;
  try {
    attempt = JSON.parse(readFileSync(attemptFiles[0], 'utf8'));
  } catch (error) {
    warnings.push(`${artifactName}:attempt 无法解析:${error.message}`);
    continue;
  }
  attempts.push(attempt);
  const identity = `${attempt.orderText || '-'} ${attempt.source?.id || 'unknown'}/${attempt.branch || 'unknown'}`;
  const issues = [];
  const summary = accepted.find((file) => file.endsWith('--SUMMARY.txt') &&
    readFileSync(file, 'utf8').includes(`Branch: ${attempt.branch}`));
  if (!summary) issues.push('缺 SUMMARY');
  if (attempt.status !== 'success') {
    if (!attempt.failureLog || !accepted.some((file) => basename(file) === attempt.failureLog)) {
      issues.push(`缺失败日志 ${attempt.failureLog || '-'}`);
    }
    warnings.push(...issues.map((item) => `${identity}:${item}`));
    branches.push({
      orderText: attempt.orderText, source: attempt.source.id, branch: attempt.branch,
      artifactName, attemptStatus: attempt.status, publishState: fallbackState(attempt),
      stage: attempt.stage, failureLog: attempt.failureLog, issues,
    });
    continue;
  }

  const metaFiles = accepted.filter((file) => file.endsWith('.meta.json'));
  let meta;
  if (metaFiles.length !== 1) issues.push(`meta 数量=${metaFiles.length}`);
  if (!issues.length) {
    try {
      meta = JSON.parse(readFileSync(metaFiles[0], 'utf8'));
    } catch (error) {
      issues.push(`meta 无法解析:${error.message}`);
    }
  }
  if (meta && (meta.source?.id !== attempt.source.id || meta.source?.branch !== attempt.branch)) {
    issues.push('meta 与 attempt 身份不一致');
  }
  const assetFile = meta && accepted.find((file) => basename(file) === meta.asset);
  const translationName = meta?.asset?.replace(/\.json\.gz$/, '.translations.json');
  const translationFile = translationName &&
    accepted.find((file) => basename(file) === translationName);
  const contractName = meta?.asset?.replace(/\.json\.gz$/, '.contract.json');
  const contractFile = contractName && accepted.find((file) => basename(file) === contractName);
  const relationsName = meta?.asset?.replace(/\.json\.gz$/, '.relations.json.gz');
  const relationsFile = relationsName && accepted.find((file) => basename(file) === relationsName);
  const duplicateName = meta?.asset?.replace(/\.json\.gz$/, '.duplicates.json');
  const duplicateFile = duplicateName && accepted.find((file) => basename(file) === duplicateName);
  const candidateName = meta?.asset?.replace(/\.json\.gz$/, '.curated-candidates.json');
  const candidateFile = candidateName && accepted.find((file) => basename(file) === candidateName);
  if (meta && !assetFile) issues.push(`缺 ${meta.asset}`);
  if (meta && !translationFile) issues.push('缺 translations');
  if (meta && !contractFile) issues.push('缺 target contract');
  if (meta && !relationsFile) issues.push('missing Kconfig relations');
  if (meta && !duplicateFile) issues.push('missing symbol duplicate report');
  if (meta && !candidateFile) issues.push('missing curated candidates report');
  if (duplicateFile) {
    try {
      const report = JSON.parse(readFileSync(duplicateFile, 'utf8'));
      if (!report.summary || !Array.isArray(report.duplicates) || !Array.isArray(report.conflicts)) {
        issues.push('invalid symbol duplicate report');
      } else if (report.summary.conflicts > 0) {
        issues.push(`Kconfig symbol merge conflicts ${report.summary.conflicts}`);
      }
    } catch (error) {
      issues.push(`cannot parse symbol duplicate report: ${error.message}`);
    }
  }
  if (contractFile) {
    try {
      const contract = JSON.parse(readFileSync(contractFile, 'utf8'));
      if (contract.source?.id !== attempt.source.id || contract.source?.branch !== attempt.branch ||
          !Number.isInteger(contract.summary?.selectableTargets)) {
        issues.push('target contract 与 attempt 身份不一致');
      }
      const probe = contract.kconfigProbe;
      const maxRatio = Number.parseFloat(process.env.KCONFIG_MAX_QUARANTINE_RATIO || '0.2');
      if (!probe || !Number.isInteger(probe.targets) || !Number.isInteger(probe.passed) ||
          !Array.isArray(probe.quarantined)) {
        issues.push('missing or invalid Kconfig probe report');
      } else if (probe.targets > 0) {
        const quarantined = probe.quarantined.length;
        const ratio = quarantined / probe.targets;
        if (probe.passed + quarantined !== probe.targets) {
          issues.push(`Kconfig probe count mismatch ${probe.passed}+${quarantined}/${probe.targets}`);
        } else if (!Number.isFinite(maxRatio) || ratio > maxRatio) {
          issues.push(`Kconfig probe quarantine ratio ${quarantined}/${probe.targets} exceeds ${maxRatio}`);
        }
      }
    } catch (error) {
      issues.push(`target contract 无法解析:${error.message}`);
    }
  }
  if (relationsFile) {
    try {
      const document = JSON.parse(gunzipSync(readFileSync(relationsFile), { finishFlush: 2 }).toString('utf8'));
      const relations = document.relations || document;
      if (document.source?.id !== attempt.source.id || document.source?.branch !== attempt.branch ||
          Number(relations.schema || 0) < 3 || !Number.isInteger(relations.summary?.packages) ||
          !relations.validation || !Array.isArray(relations.records) ||
          (Number(relations.schema || 0) >= 4 &&
            (typeof relations.relationsComplete !== 'boolean' || !Array.isArray(relations.relationCapabilities) ||
              typeof relations.packageClosureComplete !== 'boolean' ||
              !Array.isArray(relations.packageClosureCapabilities) ||
              !relations.packageClosureValidation || typeof relations.packageClosureValidation !== 'object'))) {
        issues.push('Kconfig relations do not match attempt identity');
      }
    } catch (error) {
      issues.push(`cannot parse Kconfig relations: ${error.message}`);
    }
  }
  if (assetFile) {
    try {
      const compressed = readFileSync(assetFile);
      const jsonHash = createHash('sha256').update(gunzipSync(compressed)).digest('hex');
      const compressedHash = createHash('sha256').update(compressed).digest('hex');
      if (meta.sha256 && meta.sha256 !== jsonHash) issues.push('catalog SHA-256 不一致');
      if (meta.hash && meta.hash !== compressedHash) issues.push('catalog compressed hash mismatch');
      if (meta.bytes && Number(meta.bytes) !== compressed.byteLength) issues.push('catalog byte count mismatch');
    } catch (error) {
      issues.push(`catalog 无法解压:${error.message}`);
    }
  }
  const shardFiles = [];
  for (const [logical, contract] of Object.entries(meta?.assets || {})) {
    const file = accepted.find((candidate) => basename(candidate) === contract.asset);
    if (!file) {
      issues.push(`missing Catalog shard ${logical}:${contract.asset || '-'}`);
      continue;
    }
    shardFiles.push(file);
    try {
      const compressed = readFileSync(file);
      const json = gunzipSync(compressed);
      const compressedHash = createHash('sha256').update(compressed).digest('hex');
      const jsonHash = createHash('sha256').update(json).digest('hex');
      if (contract.hash !== compressedHash || Number(contract.bytes) !== compressed.byteLength ||
          (contract.sha256 && contract.sha256 !== jsonHash)) {
        issues.push(`Catalog shard contract mismatch ${logical}`);
      }
      if (logical === 'profileBaselines') {
        const document = JSON.parse(json.toString('utf8'));
        validateProfileBaselineDocument(document, {
          sourceId: attempt.source.id,
          branch: attempt.branch,
          commit: attempt.upstreamCommit || '',
          contract,
        });
      }
    } catch (error) {
      issues.push(`Catalog shard cannot be decoded ${logical}:${error.message}`);
    }
  }
  if (Number(meta?.schema || 0) >= 6 && (!meta.assets?.core || !meta.assets?.graph || !meta.assets?.menu ||
      !meta.assets?.hidden || !meta.assets?.help || !meta.assets?.profileBaselines)) {
    issues.push('Catalog schema 6 lacks required split/Profile baseline assets');
  }
  let fresh = false;
  if (!issues.length) {
    fresh = copyUnique(assetFile, distDir, identity) &&
      shardFiles.every((file) => copyUnique(file, distDir, identity)) &&
      copyUnique(metaFiles[0], distDir, identity) &&
      [contractFile, relationsFile, duplicateFile, candidateFile, translationFile]
        .every((file) => copyUnique(file, diagnosticsDir, identity));
    if (!fresh) issues.push('输出文件名冲突');
  }
  warnings.push(...issues.map((item) => `${identity}:${item}`));
  branches.push({
    orderText: attempt.orderText, source: attempt.source.id, branch: attempt.branch,
    artifactName, attemptStatus: attempt.status,
    publishState: fresh ? 'fresh' : fallbackState(attempt),
    stage: fresh ? 'complete' : 'publish-validation', failureLog: attempt.failureLog, issues,
  });
}

if (!attempts.length) fatalErrors.push('未收集到任何可解析的分支 attempt 记录');
const dataAssets = readdirSync(distDir).filter((name) => name.endsWith('.json.gz'));
if (!dataAssets.length) fatalErrors.push('没有本次成功数据或历史 last-good 数据可发布');
const complete = attempts.length > 0 && branches.length === attempts.length &&
  branches.every((item) => item.attemptStatus === 'success' &&
    item.publishState === 'fresh' && item.issues.length === 0) && warnings.length === 0;
if (/^fix-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(String(process.env.GITHUB_REF_NAME || '')) && !complete) {
  fatalErrors.push('Fix Catalog snapshot is incomplete; isolated runtime publication is fail-closed');
}
const manifest = {
  schema: 2,
  collectedAt: new Date().toISOString(),
  rawFiles: walk(rawDir).length,
  acceptedFiles,
  complete,
  fresh: branches.filter((item) => item.publishState === 'fresh').length,
  lastGood: branches.filter((item) => item.publishState === 'last-good').length,
  attempts: attempts.map((item) => ({
    order: item.order, orderText: item.orderText, jobName: item.jobName,
    source: item.source.id, repo: item.source.repo, branch: item.branch, version: item.version,
    status: item.status, stage: item.stage, artifactName: item.artifactName,
    failureLog: item.failureLog,
  })),
  branches,
  warnings,
  fatalErrors,
};
writeFileSync(join(diagnosticsDir, 'publish-inputs.json'), JSON.stringify(manifest, null, 2) + '\n');
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `complete=${complete}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `fresh=${manifest.fresh}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `lastGood=${manifest.lastGood}\n`);
}
if (fatalErrors.length) throw new Error(`Artifact 收集无法继续:\n- ${fatalErrors.join('\n- ')}`);
if (warnings.length) console.warn(`Artifact 分支级警告:\n- ${warnings.join('\n- ')}`);
console.log(`collected ${attempts.length} attempts; fresh=${manifest.fresh}` +
  ` last-good=${manifest.lastGood} complete=${complete}`);
