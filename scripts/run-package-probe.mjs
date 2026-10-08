#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 weigefenxiang <weigefenxiang@gmail.com>
// SPDX-License-Identifier: GPL-3.0-or-later
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVirtualProbe } from './package-probe-virtual.mjs';
import { buildFailureFingerprint, classifyPrerequisiteFailure, classifyTargetPrerequisiteFailure, extractFailedBuildTargets, isCommandInfrastructureFailure, isMakeInfrastructureFailure, probeResultExitCode } from './package-probe-failure-classification.mjs';
import { parsePackageInfo } from './lib.mjs';
import { derivePackageDependencyClosure, validatePackageClosureGraph } from './kconfig-relations.mjs';
import { applicableBuildDependencies, normalizeCompatibilityDocument } from './compatibility-rules.mjs';
import { captureCatalogInputs, catalogInputsHash } from './catalog-inputs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9+_.@-]{0,95}$/;
const WORKDIR = resolve(process.env.PROBE_WORKDIR || join(ROOT, 'work', 'upstream'));
const LOG_FILE = resolve(process.env.PROBE_LOG || join(ROOT, 'probe.log'));
const RUNTIME_FILE = resolve(process.env.PROBE_RUNTIME || join(ROOT, 'probe-runtime.json'));
const MODE = String(process.env.PROBE_MODE || 'config-resolve');
const TARGET = String(process.env.PROBE_TARGET || '');
const PROFILE = String(process.env.PROBE_PROFILE || '');
const TARGET_SYSTEM = String(process.env.PROBE_TARGET_SYSTEM || '');
const SUBTARGET = String(process.env.PROBE_SUBTARGET || '');
const TARGET_CONFIG = String(process.env.PROBE_TARGET_CONFIG || '');
const SOURCE = String(process.env.PROBE_SOURCE || '');
const BRANCH = String(process.env.PROBE_BRANCH || '');
const TARGET_BATCH = MODE === 'config-resolve' ? parseTargetBatch(process.env.PROBE_TARGET_BATCH || '') : [];
const FINAL_PACKAGE_CONFIG = Buffer.from(String(process.env.PROBE_PACKAGE_CONFIG || ''), 'base64url').toString('utf8');
const BASELINE_PACKAGE_CONFIG = Buffer.from(String(process.env.PROBE_BASELINE_PACKAGE_CONFIG || ''), 'base64url').toString('utf8');
const INTENT_JSON = Buffer.from(String(process.env.PROBE_PACKAGE_INTENT || 'W10'), 'base64url').toString('utf8');
const FINAL_STATES = parsePackageConfig(FINAL_PACKAGE_CONFIG);
const BASELINE_STATES = parsePackageConfig(BASELINE_PACKAGE_CONFIG, true);
const INTENT = parseIntent(INTENT_JSON);
const BASELINE_DIRECT_STATES = directIntentStates(INTENT, 'before');
const FINAL_DIRECT_STATES = directIntentStates(INTENT, 'after');
const DIRECT_STATES = FINAL_DIRECT_STATES;
const PAIRED_COMPARISON = String(process.env.PROBE_PAIRED_COMPARISON || '').toLowerCase() === 'true';
const BASELINE_ROOTS = INTENT.filter((row) => ['m', 'y'].includes(String(row?.before || 'n'))).map((row) => row.package);
const ROOTS = String(process.env.PROBE_ROOTS || '').split(',').map((row) => row.trim()).filter(Boolean);
const MAKE_COMMAND = String(process.env.PROBE_MAKE_COMMAND || 'make');
const MAKE_PREFIX = String(process.env.PROBE_MAKE_ARGUMENT || '').trim();
const requestedJobs = Number(process.env.PROBE_JOBS || 0);
const JOBS = Number.isSafeInteger(requestedJobs) && requestedJobs > 0 ? requestedJobs : Math.max(1, availableParallelism() + 1);
const COMMAND_OUTPUT_LIMIT = 256 * 1024;

function loadCompatibilityDocument() {
  try {
    const policy = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
    const raw = JSON.parse(readFileSync(join(ROOT, 'compatibility.json'), 'utf8'));
    return normalizeCompatibilityDocument(raw, policy);
  } catch (error) {
    // Do not turn a malformed reviewed rule document into an untracked
    // package list.  The caller records this as an inconclusive gate.
    return { error: String(error?.message || error), rules: [] };
  }
}

const COMPATIBILITY_DOCUMENT = loadCompatibilityDocument();

const MODE_LEVELS = Object.freeze({
  'config-resolve': 1,
  'package-compile': 2,
  'rootfs-integration': 3,
  'firmware-integration': 4,
  'boot-smoke': 5,
  'runtime-health': 6,
  'reboot-validation': 7,
});
let ACTIVE_PHASE_LOG = '';
if (!MODE_LEVELS[MODE]) {
  throw new Error(`unsupported probe mode: ${MODE}`);
}
if (SOURCE.toLowerCase() === 'hanwckf') throw new Error('hanwckf is excluded from Package Probe');
if (MODE === 'config-resolve') {
  if (!TARGET_BATCH.length) throw new Error('L1 Probe environment batch is required');
} else if (!TARGET || !TARGET_CONFIG) throw new Error('Probe Target config is required');
if (!ROOTS.length || ROOTS.some((name) => !PACKAGE_RE.test(name))) throw new Error('invalid PROBE_ROOTS');
for (const root of ROOTS) {
  if (!['m', 'y'].includes(FINAL_STATES.get(root))) throw new Error(`Probe root is not enabled in Final state: ${root}`);
}

mkdirSync(dirname(LOG_FILE), { recursive: true });
if (!existsSync(LOG_FILE)) writeFileSync(LOG_FILE, '');

function parsePackageConfig(text, allowEmpty = false) {
  const states = new Map();
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized && !allowEmpty) throw new Error('Final package config is empty');
  if (!normalized) return states;
  for (const line of normalized.split('\n')) {
    const match = line.match(/^CONFIG_PACKAGE_([A-Za-z0-9][A-Za-z0-9+_.@-]{0,95})=([my])$/);
    if (!match) throw new Error(`invalid package config line: ${line}`);
    if (states.has(match[1]) && states.get(match[1]) !== match[2]) throw new Error(`conflicting package config state: ${match[1]}`);
    states.set(match[1], match[2]);
  }
  return states;
}

function parseIntent(text) {
  let rows;
  try { rows = JSON.parse(text || '[]'); }
  catch { throw new Error('PROBE_PACKAGE_INTENT is invalid JSON'); }
  if (!Array.isArray(rows)) throw new Error('PROBE_PACKAGE_INTENT must be an array');
  return rows;
}

function directIntentStates(rows, stateKey = 'after') {
  const states = new Map();
  for (const row of rows) {
    const packageName = String(row?.package || '');
    const value = String(row?.[stateKey] || 'n');
    if (!PACKAGE_RE.test(packageName) || !['n', 'm', 'y'].includes(value) || states.has(packageName)) {
      throw new Error(`invalid or duplicate direct package intent: ${packageName}`);
    }
    states.set(packageName, value);
  }
  return states;
}

function parseTargetBatch(text) {
  if (!String(text || '').trim()) return [];
  let rows;
  try { rows = JSON.parse(text); }
  catch { throw new Error('PROBE_TARGET_BATCH is invalid JSON'); }
  if (!Array.isArray(rows) || rows.length > 256) throw new Error('PROBE_TARGET_BATCH must contain up to 256 environments');
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`invalid L1 environment at index ${index}`);
    const target = String(row.target || '');
    const targetConfig = String(row.targetConfig || '');
    if (!target || !targetConfig) throw new Error(`L1 environment ${index} is missing Target config`);
    return {
      targetSystem: String(row.targetSystem || ''), targetSystemLabel: String(row.targetSystemLabel || ''),
      subtarget: String(row.subtarget || ''), subtargetLabel: String(row.subtargetLabel || ''),
      target, profile: String(row.profile || ''), profileLabel: String(row.profileLabel || ''), targetConfig,
    };
  });
}

function log(line = '') {
  const text = `${line}\n`;
  process.stdout.write(text);
  appendFileSync(LOG_FILE, text);
  if (ACTIVE_PHASE_LOG && resolve(ACTIVE_PHASE_LOG) !== resolve(LOG_FILE)) appendFileSync(ACTIVE_PHASE_LOG, text);
}

function phaseLogPath(label) {
  return join(dirname(LOG_FILE), `probe-${safeSlug(label)}.log`);
}

async function withPhaseLog(label, action) {
  const previous = ACTIVE_PHASE_LOG;
  const file = phaseLogPath(label);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
  ACTIVE_PHASE_LOG = file;
  try {
    return await action(file);
  } finally {
    ACTIVE_PHASE_LOG = previous;
  }
}

function stageStatus(value) {
  if (value?.result === 'skipped') return 'skipped';
  if (value?.result === 'inconclusive') return 'failure';
  if (value?.result === 'incompatible') return 'failure';
  return value?.ok === false ? 'failure' : 'success';
}

async function runStage(attempt, name, action) {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  try {
    const value = await action();
    attempt.stages[name] = {
      status: stageStatus(value), startedAt, finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - started),
    };
    return value;
  } catch (error) {
    attempt.stages[name] = {
      status: 'failure', startedAt, finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - started),
    };
    throw error;
  }
}

log(`Make concurrency / Make 并发: -j${JOBS}`);
log('Defconfig: on (upstream resolver)');
log(`Probe roots / 测试入口: ${ROOTS.join(', ')}`);

function appendCommandOutput(current, chunk) {
  const next = current + String(chunk || '');
  return next.length > COMMAND_OUTPUT_LIMIT ? next.slice(-COMMAND_OUTPUT_LIMIT) : next;
}

async function command(file, args, options = {}) {
  log(`\n$ ${file} ${args.join(' ')}`);
  return new Promise((resolvePromise) => {
    let output = '';
    const child = spawn(file, args, {
      cwd: options.cwd || WORKDIR,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      output = appendCommandOutput(output, chunk);
      process.stdout.write(chunk); appendFileSync(LOG_FILE, chunk);
      if (ACTIVE_PHASE_LOG && resolve(ACTIVE_PHASE_LOG) !== resolve(LOG_FILE)) appendFileSync(ACTIVE_PHASE_LOG, chunk);
    });
    child.stderr.on('data', (chunk) => {
      output = appendCommandOutput(output, chunk);
      process.stderr.write(chunk); appendFileSync(LOG_FILE, chunk);
      if (ACTIVE_PHASE_LOG && resolve(ACTIVE_PHASE_LOG) !== resolve(LOG_FILE)) appendFileSync(ACTIVE_PHASE_LOG, chunk);
    });
    child.on('error', (error) => {
      const text = `ERROR: ${error.message}`;
      output = appendCommandOutput(output, text);
      log(text); resolvePromise({ ok: false, code: -1, output });
    });
    child.on('close', (code) => resolvePromise({ ok: code === 0, code, output }));
  });
}

async function make(args, parallel = true, options = {}) {
  const makeArgs = parallel ? [`-j${JOBS}`, ...args] : ['-j1', ...args];
  return command(MAKE_COMMAND, [...(MAKE_PREFIX ? [MAKE_PREFIX] : []), ...makeArgs], options);
}

function verboseMakeArgs(args) {
  const rows = [...args];
  if (!rows.some((arg) => /^V=/.test(arg))) rows.push('V=s');
  if (!rows.some((arg) => /^BUILD_LOG=/.test(arg))) rows.push('BUILD_LOG=1');
  return rows;
}

async function makeWithSerialRetry(args, label, attempt, options = {}) {
  const primary = await make(args, true, options);
  if (primary.ok) return primary;
  log(`Retry serial verbose / 串行详细复核: ${label}`);
  const serial = await make(verboseMakeArgs(args), false, options);
  attempt.serialRetries.push({
    label, primaryCode: primary.code, serialCode: serial.code,
    result: serial.ok ? 'recovered' : 'failure',
  });
  return serial;
}

function failedMakeIsInfrastructure(result) {
  return isMakeInfrastructureFailure(result?.output);
}

function failedPackageBuildTargets(result) {
  return extractFailedBuildTargets(result?.output);
}

function applyFailureDetail(attempt, detail, options = {}) {
  if (!attempt || !detail) return;
  const terminalError = detail.terminalError || detail.errorSummary || '';
  if (terminalError && (!options.preserveExisting || !attempt.terminalError)) {
    attempt.terminalError = terminalError;
    attempt.errorSummary = terminalError;
  }
  const recoverableErrors = Array.isArray(detail.recoverableErrors) ? detail.recoverableErrors : [];
  if (recoverableErrors.length) {
    attempt.recoverableErrors = [...new Set([...(attempt.recoverableErrors || []), ...recoverableErrors])];
  } else if (!options.preserveExisting && !Array.isArray(attempt.recoverableErrors)) {
    attempt.recoverableErrors = [];
  }
}

function normalizePackageBuildTarget(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')
    .replace(/\/(?:compile|install|prepare)$/, '').replace(/\/+$/, '');
}

function classifyPackageBuildFailure(result, rootTargets, attempt, reasons, options = {}) {
  const detail = classifyPrerequisiteFailure(result?.output);
  applyFailureDetail(attempt, detail);
  attempt.failureCause = detail.cause || '';
  attempt.failureFingerprint = detail.failureFingerprint || attempt.failureFingerprint || '';
  if (failedMakeIsInfrastructure(result)) return { result: 'inconclusive', reason: reasons.infrastructure };
  const failedTargets = failedPackageBuildTargets(result);
  attempt.failedBuildTargets = failedTargets;
  const roots = new Set((rootTargets || []).map(normalizePackageBuildTarget));
  if (failedTargets.some((target) => roots.has(target))) {
    attempt.packageCauseKind = 'direct';
    return { result: 'incompatible', reason: reasons.root };
  }
  const sharedTargets = new Set((options.sharedTargets || attempt.sharedBuildTargets || []).map(normalizePackageBuildTarget));
  if (failedTargets.some((target) => sharedTargets.has(target))) {
    attempt.sharedTargetCandidate = failedTargets.find((target) => sharedTargets.has(target));
    // A newly added package can share one upstream Make target with a
    // package already selected by the Base Profile.  Preserve the shared
    // target for the A/B replay instead of blaming the added dependency.
    attempt.packageCauseKind = '';
    attempt.prerequisiteCause = detail.cause || '';
    return { result: 'inconclusive', reason: failedTargets.length ? reasons.prerequisite : reasons.unattributed };
  }
  const dependencies = new Set((options.dependencyTargets || attempt.newDependencyTargets || []).map(normalizePackageBuildTarget));
  if (failedTargets.some((target) => dependencies.has(target)) && reasons.dependency) {
    attempt.packageCauseKind = 'dependency';
    return { result: 'incompatible', reason: reasons.dependency };
  }
  attempt.prerequisiteCause = detail.cause || '';
  return { result: 'inconclusive', reason: failedTargets.length ? reasons.prerequisite : reasons.unattributed };
}

function unversionedPackageName(value) {
  return String(value || '').replace(/-[0-9][A-Za-z0-9.+:~_-]*$/, '');
}

function rootfsConflictPackages(result) {
  const text = String(result?.output || '');
  const packages = [];
  for (const match of text.matchAll(/(?:ERROR:\s+)?([^\s:]+?)(?:-[0-9][^:\s]*)?:\s+trying to overwrite\s+[^\s,]+\s+owned by\s+([^\s,.]+)/gi)) {
    packages.push(unversionedPackageName(match[1]), unversionedPackageName(match[2]));
  }
  for (const match of text.matchAll(/Package\s+([^\s]+)\s+wants to install file\s+[^\s]+.*?already provided by package\s+([^\s.]+)/gis)) {
    packages.push(unversionedPackageName(match[1]), unversionedPackageName(match[2]));
  }
  return [...new Set(packages.filter(Boolean))];
}

function classifyRootfsInstallFailure(result, attempt, roots = ROOTS, dependencyPackages = []) {
  const detail = classifyPrerequisiteFailure(result?.output);
  applyFailureDetail(attempt, detail);
  attempt.failureCause = detail.cause || '';
  attempt.failureFingerprint = detail.failureFingerprint || attempt.failureFingerprint || '';
  if (failedMakeIsInfrastructure(result)) return { result: 'inconclusive', reason: 'rootfs-install-infrastructure' };
  const failedTargets = failedPackageBuildTargets(result);
  if (failedTargets.length) attempt.failedBuildTargets = failedTargets;
  const conflictPackages = rootfsConflictPackages(result);
  attempt.rootfsConflictPackages = conflictPackages;
  if (conflictPackages.some((packageName) => roots.includes(packageName))) {
    attempt.packageCauseKind = 'direct';
    return { result: 'incompatible', reason: 'rootfs-conflict' };
  }
  if (conflictPackages.some((packageName) => dependencyPackages.includes(packageName))) {
    attempt.packageCauseKind = 'dependency';
    return { result: 'incompatible', reason: 'rootfs-conflict' };
  }
  attempt.prerequisiteCause = detail.cause || '';
  const reportedPrerequisite = Boolean(detail.cause) || conflictPackages.length > 0;
  return { result: 'inconclusive', reason: reportedPrerequisite
    ? 'rootfs-install-prerequisite-failure' : 'rootfs-install-unattributed-failure' };
}

function safeSlug(value) {
  return String(value || 'default').replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-').slice(0, 120) || 'default';
}

function sha256Text(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function enabledPackageNames(states) {
  return new Set(Object.entries(states || {}).filter(([, state]) => ['m', 'y'].includes(state)).map(([name]) => name));
}

function resolvedConfigDiff(baselineStates, finalStates, directRoots = ROOTS) {
  const baseline = enabledPackageNames(baselineStates);
  const final = enabledPackageNames(finalStates);
  const direct = new Set(directRoots);
  const added = [...final].filter((name) => !baseline.has(name)).sort();
  const removed = [...baseline].filter((name) => !final.has(name)).sort();
  const shared = [...final].filter((name) => baseline.has(name)).sort();
  return {
    added, removed, shared,
    addedDependencies: added.filter((name) => !direct.has(name)),
  };
}

function mappedBuildTargets(packageInfo, packages) {
  const mapping = parseUpstreamPackageInfo(packageInfo);
  const targets = [];
  for (const packageName of packages || []) {
    const sources = [...(mapping.get(packageName) || [])].map(safeSourceMakefile).sort();
    if (sources.length === 1) targets.push(`${posix.dirname(sources[0])}/compile`);
  }
  return [...new Set(targets)];
}

function normalizedBuildTarget(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')
    .replace(/\/(?:compile|install|prepare)$/, '').replace(/\/+$/, '');
}

function enabledPackageTargetOwnership(packageInfo, states) {
  const mapping = parseUpstreamPackageInfo(packageInfo);
  const ownership = new Map();
  for (const [packageName, state] of Object.entries(states || {})) {
    if (!['m', 'y'].includes(state)) continue;
    const sources = [...(mapping.get(packageName) || [])].map(safeSourceMakefile).sort();
    if (sources.length !== 1) continue;
    const target = normalizedBuildTarget(`${posix.dirname(sources[0])}/compile`);
    if (!target) continue;
    if (!ownership.has(target)) ownership.set(target, []);
    ownership.get(target).push(packageName);
  }
  for (const packages of ownership.values()) packages.sort();
  return ownership;
}

function targetOwnershipObject(ownership) {
  return Object.fromEntries([...ownership.entries()].map(([target, packages]) => [target, [...packages]]));
}

function uniqueNormalizedTargets(targets = []) {
  return [...new Set((targets || []).map(normalizedBuildTarget).filter(Boolean))].sort();
}

async function sha256File(file) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

async function firmwareSnapshot() {
  const directory = join(WORKDIR, 'bin', 'targets', TARGET_SYSTEM, SUBTARGET);
  if (!existsSync(directory)) return { directory, artifacts: [], manifestHash: '' };
  const artifacts = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const file = join(directory, entry.name);
    const stats = statSync(file);
    artifacts.push({ name: entry.name, size: stats.size, sha256: await sha256File(file) });
  }
  return { directory, artifacts, manifestHash: sha256Text(JSON.stringify(artifacts)) };
}

function packageStatesFromText(text) {
  return new Map([...String(text || '').matchAll(/^CONFIG_PACKAGE_([A-Za-z0-9][A-Za-z0-9+_.@-]{0,95})=([my])$/gm)]
    .map((match) => [match[1], match[2]]));
}

function rootRequestedStates() {
  return new Map(ROOTS.map((root) => [root, DIRECT_STATES.get(root) || FINAL_STATES.get(root) || 'y']));
}

function probeConfigText(targetConfig, requestedStates) {
  const lines = ['CONFIG_HAVE_DOT_CONFIG=y', String(targetConfig || '').trim()];
  for (const [packageName, state] of requestedStates) {
    lines.push(state === 'n' ? `# CONFIG_PACKAGE_${packageName} is not set` : `CONFIG_PACKAGE_${packageName}=${state}`);
  }
  return `${lines.filter(Boolean).join('\n')}\n`;
}

async function resolveProbeConfig({ targetConfig, requestedStates, file, resolveConfig, roots, attempt, label, snapshotFile = '' }) {
  writeFileSync(file, probeConfigText(targetConfig, requestedStates));
  const result = await resolveConfig(file);
  if (!result.ok) {
    return {
      ok: false, states: {}, config: file, reason: `${label}-defconfig-failure`, rejectedRoots: [],
      code: result.code, output: result.output || '', infrastructure: isCommandInfrastructureFailure(result),
    };
  }
  const resolvedText = readFileSync(file, 'utf8');
  const resolvedStates = packageStatesFromText(resolvedText);
  const actual = Object.fromEntries(roots.map((root) => [root, resolvedStates.get(root) || 'n']));
  const directActual = Object.fromEntries([...requestedStates].map(([packageName]) => [packageName, resolvedStates.get(packageName) || 'n']));
  const rejected = [...requestedStates].filter(([packageName, state]) => directActual[packageName] !== state)
    .map(([packageName]) => packageName);
  if (attempt) {
    if (snapshotFile) {
      mkdirSync(dirname(snapshotFile), { recursive: true });
      copyFileSync(file, snapshotFile);
    }
    attempt.configPath = snapshotFile || file;
    attempt.configHash = sha256Text(resolvedText);
    attempt.resolvedPackageCount = resolvedStates.size;
    attempt.resolvedPackageStates = Object.fromEntries(resolvedStates);
  }
  if (rejected.length) {
    return { ok: false, states: actual, config: file, reason: 'root-kconfig-rejected', rejectedRoots: rejected };
  }
  return {
    ok: true, states: actual, config: file, resolvedPackageCount: resolvedStates.size,
    resolvedPackageStates: Object.fromEntries(resolvedStates), configHash: sha256Text(resolvedText), rejectedRoots: [],
  };
}

async function solveL1Config(environment, roots, suffix, attempt) {
  const directory = join(WORKDIR, '.probe-configs');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${safeSlug(environment.target)}--${safeSlug(environment.profile)}--${safeSlug(suffix)}.config`);
  const resolver = join(WORKDIR, 'scripts', 'config', 'conf');
  const resolverShim = `${resolver}.mjs`;
  return resolveProbeConfig({
    targetConfig: environment.targetConfig, requestedStates: roots, file, roots: [...roots.keys()], attempt,
    label: 'l1', resolveConfig: (configFile) => existsSync(resolverShim)
      ? command(process.execPath, [resolverShim, `--defconfig=${configFile}`, '-w', configFile, 'Config.in'])
      : command(resolver, [`--defconfig=${configFile}`, '-w', configFile, 'Config.in']),
  });
}

async function prepareConfig(attempt, label = 'final', options = {}) {
  const roots = options.roots || ROOTS;
  const requestedStates = options.requestedStates || DIRECT_STATES;
  const file = options.file || join(WORKDIR, '.config');
  return resolveProbeConfig({
    targetConfig: TARGET_CONFIG, requestedStates, file, roots, attempt, label,
    snapshotFile: join(WORKDIR, '.probe-configs', `${safeSlug(label)}.config`),
    resolveConfig: () => make(['defconfig'], false),
  });
}

function packageNamesFromInfo(text) {
  return new Set([...String(text || '').matchAll(/^Package:\s*(\S+)$/gm)].map((match) => match[1]));
}

let probeInputsHash;
function currentProbeInputsHash() {
  if (probeInputsHash !== undefined) return probeInputsHash;
  const receipt = process.env.PROBE_FEEDS_RUNTIME || join(process.env.GITHUB_WORKSPACE || ROOT, 'probe-feeds-runtime.json');
  try {
    probeInputsHash = catalogInputsHash(captureCatalogInputs(WORKDIR, JSON.parse(readFileSync(receipt, 'utf8'))));
  } catch { probeInputsHash = ''; }
  return probeInputsHash;
}

function applicableProbeBuildDependencies(packageInfo) {
  if (COMPATIBILITY_DOCUMENT.error) return {
    packages: [], rules: [], unresolved: [{ reason: 'compatibility-document-invalid', error: COMPATIBILITY_DOCUMENT.error }],
  };
  const availablePackages = parsePackageInfo(packageInfo).map((item) => item.name);
  return applicableBuildDependencies(COMPATIBILITY_DOCUMENT, {
    source: SOURCE,
    branch: BRANCH,
    upstreamCommit: String(process.env.PROBE_UPSTREAM_COMMIT || '').toLowerCase(),
    inputsHash: currentProbeInputsHash(),
    system: TARGET_SYSTEM,
    targetSystem: TARGET_SYSTEM,
    subtarget: SUBTARGET,
    profile: PROFILE,
    availablePackages,
  });
}

function packageClosureGate(attempt, packageInfo, roots, phase) {
  const dependencySet = applicableProbeBuildDependencies(packageInfo);
  attempt.packageClosure = { ...dependencySet, phase, roots: [...roots] };
  if (dependencySet.unresolved.length) {
    attempt.stages.packageClosure = {
      status: 'failure', reason: 'compatibility-rule-unresolved',
      unresolved: dependencySet.unresolved,
    };
    log(`INCONCLUSIVE: compatibility build-dependency rules unresolved: ${JSON.stringify(dependencySet.unresolved)}`);
    return { result: 'inconclusive', reason: 'compatibility-rule-unresolved' };
  }
  if (!dependencySet.packages.length) {
    attempt.packageClosureCapability = {
      complete: false,
      capabilities: [],
      validation: { format: 'openwrt-packageinfo-v1', reasons: ['no-applicable-build-dependency'] },
    };
    attempt.stages.packageClosure = { status: 'success', result: 'not-run', failedPackages: [] };
    return { result: 'clear', reason: '' };
  }
  const packageRows = parsePackageInfo(packageInfo);
  const packageCapability = validatePackageClosureGraph(packageRows);
  attempt.packageClosureCapability = packageCapability;
  if (!packageCapability.complete) {
    attempt.stages.packageClosure = {
      status: 'failure', result: 'inconclusive', reason: 'package-closure-capability-unavailable',
      failedPackages: dependencySet.packages, validation: packageCapability.validation,
    };
    log(`INCONCLUSIVE: package-info closure capability unavailable: ${JSON.stringify(packageCapability.validation)}`);
    return { result: 'inconclusive', reason: 'package-closure-capability-unavailable' };
  }
  const closure = derivePackageDependencyClosure(parsePackageInfo(packageInfo), roots, dependencySet.packages, {
    selectedPackages: enabledPackageNames(attempt.resolvedPackageStates),
    installedPackages: new Set(Object.entries(attempt.resolvedPackageStates || {})
      .filter(([, state]) => state === 'y').map(([name]) => name)),
  });
  attempt.packageClosure = { ...attempt.packageClosure, ...closure };
  attempt.stages.packageClosure = {
    status: closure.result === 'reachable' ? 'failure' : closure.result === 'inconclusive' ? 'failure' : 'success',
    result: closure.result, failedPackages: dependencySet.packages,
    paths: closure.paths, unknown: closure.unknown,
  };
  if (closure.result === 'reachable') {
    attempt.packageCauseKind = roots.some((root) => closure.paths.some((row) => row.root === root && row.target === root))
      ? 'direct' : 'dependency';
    attempt.failureCause = 'package-closure-failure';
    for (const row of closure.paths) log(`FAIL: package closure reaches failed package ${row.target}: ${row.path.join(' -> ')}`);
    return { result: 'incompatible', reason: 'package-closure-failure' };
  }
  if (closure.result === 'inconclusive') {
    log(`INCONCLUSIVE: package closure unresolved: ${JSON.stringify(closure.unknown)}`);
    return { result: 'inconclusive', reason: 'package-closure-unknown' };
  }
  return { result: 'clear', reason: '' };
}

function newL1Attempt(environment, phase = 'final') {
  return {
    source: SOURCE, branch: BRANCH,
    targetSystem: environment.targetSystem, subtarget: environment.subtarget,
    target: environment.target, profile: environment.profile, profileLabel: environment.profileLabel,
    phase, stages: {}, rootStates: {}, unavailableRoots: [], rejectedRoots: [], serialRetries: [],
  };
}

async function configResolve(options = {}) {
  const roots = options.roots || ROOTS;
  const requested = options.requestedStates || DIRECT_STATES;
  const phase = options.phase || 'final';
  const requireEnabled = options.requireEnabled !== false;
  const environments = options.environments || TARGET_BATCH;
  log(`L1 environment batch / L1 环境批次: ${environments.length}`);
  const metadata = await command('bash', [join(ROOT, 'scripts', 'prepare-metadata.sh'), 'metadata-only']);
  if (!metadata.ok) {
    return environments.map((environment) => ({ ...newL1Attempt(environment, phase), result: 'inconclusive', reason: 'metadata-failure',
      stages: { metadata: 'failure' } }));
  }
  const resolver = await make(['scripts/config/conf'], false);
  if (!resolver.ok) {
    return environments.map((environment) => ({ ...newL1Attempt(environment, phase), result: 'inconclusive', reason: 'kconfig-resolver-failure',
      stages: { metadata: 'success', resolver: 'failure' } }));
  }
  const packageInfoPath = join(WORKDIR, 'tmp', '.packageinfo');
  if (!existsSync(packageInfoPath)) {
    return environments.map((environment) => ({ ...newL1Attempt(environment, phase), result: 'inconclusive', reason: 'metadata-unresolved',
      stages: { metadata: 'success', resolver: 'success' } }));
  }
  const packageNames = packageNamesFromInfo(readFileSync(packageInfoPath, 'utf8'));
  if (!packageNames.size) {
    return environments.map((environment) => ({ ...newL1Attempt(environment, phase), result: 'inconclusive', reason: 'metadata-unresolved',
      stages: { metadata: 'success', resolver: 'success' } }));
  }
  const globallyAbsent = roots.filter((root) => !packageNames.has(root));
  const attempts = [];
  for (const environment of environments) {
    const attempt = newL1Attempt(environment, phase);
    attempt.phaseLog = ACTIVE_PHASE_LOG;
    attempt.stages = { metadata: 'success', resolver: 'success' };
    if (globallyAbsent.length) {
      attempt.result = 'skipped'; attempt.reason = 'root-absent-source'; attempt.unavailableRoots = [...globallyAbsent];
      attempt.rootStates = Object.fromEntries(roots.map((root) => [root, globallyAbsent.includes(root) ? 'missing' : 'unknown']));
      attempts.push(attempt); continue;
    }
    log(`\nL1 Profile / 配置环境: ${SOURCE}/${BRANCH}/${environment.targetSystem}/${environment.subtarget}/${environment.profile}`);
    const combined = await solveL1Config(environment, requested, `${phase}-combined`, attempt);
    attempt.stages.kconfig = combined.ok ? 'success' : 'failure';
    if (!combined.ok) {
      const detail = classifyPrerequisiteFailure(combined.output || '');
      attempt.resolverCode = combined.code;
      applyFailureDetail(attempt, detail);
      attempt.failureCause = detail.cause || '';
      attempt.failureFingerprint = detail.failureFingerprint || '';
      if (combined.infrastructure) {
        attempt.result = 'inconclusive'; attempt.reason = 'runner-infrastructure';
      } else {
        attempt.result = phase === 'baseline' ? 'blocked' : 'inconclusive';
        attempt.reason = phase === 'baseline' ? 'base-profile-prepare-failure' : 'defconfig-failure';
        if (phase === 'baseline') attempt.baselineBlockReason = 'defconfig-failure';
      }
      attempts.push(attempt); continue;
    }
    attempt.rootStates = combined.states;
    if (!requireEnabled) {
      attempt.result = 'compatible'; attempt.reason = phase === 'baseline' && !roots.length
        ? 'baseline-ready/no-direct-roots' : '';
      attempt.baselineReady = phase === 'baseline' && !roots.length;
      attempts.push(attempt); continue;
    }
    const rejected = roots.filter((root) => !['m', 'y'].includes(combined.states[root]));
    attempt.rejectedRoots = [...rejected];
    if (!rejected.length) {
      attempt.result = 'compatible'; attempt.reason = phase === 'baseline' && !roots.length
        ? 'baseline-ready/no-direct-roots' : '';
      attempt.baselineReady = phase === 'baseline' && !roots.length;
      attempts.push(attempt); continue;
    }
    const unavailable = [];
    for (const root of rejected) {
      const single = await solveL1Config(environment, new Map([[root, requested.get(root) || 'y']]), `${phase}-single-${root}`);
      if (!single.ok) {
        const detail = classifyPrerequisiteFailure(single.output || '');
        attempt.resolverCode = single.code;
        applyFailureDetail(attempt, detail);
        attempt.failureCause = detail.cause || attempt.failureCause || '';
        attempt.failureFingerprint = detail.failureFingerprint || attempt.failureFingerprint || '';
        if (single.infrastructure) {
          attempt.result = 'inconclusive'; attempt.reason = 'runner-infrastructure';
        } else {
          attempt.result = phase === 'baseline' ? 'blocked' : 'inconclusive';
          attempt.reason = phase === 'baseline' ? 'base-profile-prepare-failure' : 'single-root-defconfig-failure';
          if (phase === 'baseline') attempt.baselineBlockReason = 'single-root-defconfig-failure';
        }
        attempt.stages.singleRoot = 'failure'; break;
      }
      if (!['m', 'y'].includes(single.states[root])) unavailable.push(root);
    }
    if (attempt.result === 'inconclusive') { attempts.push(attempt); continue; }
    attempt.stages.singleRoot = 'success';
    attempt.unavailableRoots = unavailable;
    if (unavailable.length) {
      attempt.result = 'skipped'; attempt.reason = 'root-not-applicable';
    } else {
      attempt.result = 'incompatible'; attempt.reason = 'root-combination-rejected';
      log(`FAIL: L1 root combination rejected by upstream Kconfig: ${rejected.join(', ')}`);
    }
    attempts.push(attempt);
  }
  return attempts;
}

function phaseIdentity(row) {
  return [SOURCE, BRANCH, row?.targetSystem, row?.subtarget, row?.target, row?.profile].map((value) => String(value || '')).join('\0');
}

function pairIdFor(row) {
  return `pair:${sha256Text(phaseIdentity(row)).slice(0, 20)}`;
}

function phaseFailureFingerprint(phase) {
  const normalizedTargets = uniqueNormalizedTargets(phase?.failedBuildTargets || []);
  const classifierFingerprint = buildFailureFingerprint({
    phase: phase?.phase || '', cause: phase?.failureCause || phase?.prerequisiteCause || phase?.targetPrerequisiteCause || '',
    errorSummary: phase?.errorSummary || '', failedBuildTargets: normalizedTargets,
  });
  return sha256Text(JSON.stringify({
    phase: phase?.phase || '', result: phase?.result || '', reason: phase?.reason || '',
    failedBuildTargets: normalizedTargets, prerequisiteCause: phase?.prerequisiteCause || '',
    targetPrerequisiteCause: phase?.targetPrerequisiteCause || '', errorSummary: phase?.errorSummary || '',
    classifierFingerprint, rootStates: phase?.rootStates || {},
  }));
}

function completedPhaseAttempt(attempt, result, startedAt, started) {
  attempt.result = result?.result || 'inconclusive';
  attempt.reason = result?.reason || '';
  attempt.selectedLevel = MODE_LEVELS[MODE];
  attempt.deepestPassedLevel = deepestPassedLevel(attempt);
  attempt.finishedAt = new Date().toISOString();
  attempt.durationMs = Math.max(0, Date.now() - started);
  attempt.failureFingerprint = phaseFailureFingerprint(attempt);
  return attempt;
}

function isOperationalPhaseReason(reason) {
  return /(?:infrastructure|metadata|runner|network|download|timeout|oom|resource|counterfactual|unresolved)/i.test(String(reason || ''));
}

function isGenericFailureWrapper(value) {
  const text = String(value || '').trim();
  return /^(?:ERROR:\s*)?(?:package|tools|toolchain|target)(?:\/[A-Za-z0-9_./+@-]+)?\s+failed to build\s*$/i.test(text) ||
    /^make(?:\[\d+\])?:\s+\*{3}\s+.*\bError\s+\d+/i.test(text);
}

function hasDeterministicBaselineEvidence(attempt, result) {
  if (attempt?.rejectedRoots?.length) return true;
  const failedTargets = Array.isArray(attempt?.failedBuildTargets) ? attempt.failedBuildTargets.filter(Boolean) : [];
  const conflictPackages = Array.isArray(attempt?.rootfsConflictPackages)
    ? attempt.rootfsConflictPackages.filter(Boolean) : [];
  const terminalError = String(attempt?.terminalError || attempt?.errorSummary || '').trim();
  if (!terminalError || isMakeInfrastructureFailure(terminalError)) return false;
  // Rootfs/firmware size limits are deterministic domain failures even when
  // the upstream log does not print a Make target.  Keep this matcher generic
  // so it does not depend on a Source, Branch, package, or image filename.
  const domainLimitFailure = /(?:rootfs|firmware|filesystem|image)[^\n]*(?:too\s+(?:large|big)|exceed(?:s|ed)?|(?:size|space)\s+limit|maximum\s+size|overflow)/i.test(terminalError);
  if (!failedTargets.length && !conflictPackages.length && !domainLimitFailure) return false;
  // A direct B package failure is already classified as incompatible by the
  // package ownership classifier; its outer Make wrapper is sufficient in
  // that case.  Unknown/unattributed wrappers must remain unresolved.
  const cause = String(attempt?.failureCause || attempt?.targetPrerequisiteCause || attempt?.prerequisiteCause || '').trim();
  if (cause) return true;
  if (result?.result === 'incompatible') return true;
  return !isGenericFailureWrapper(terminalError);
}

// A virtual Baseline-B reboot failure is a domain blocker only after the
// guest has already crossed every preceding runtime boundary.  In
// particular, a missing/partial stage record must stay unresolved: it cannot
// prove that the Base Profile, rather than the Runner, prevented A/B from
// starting.  The virtual runner uses these two reasons for failures after a
// successful first boot/reboot; keep the check reason- and stage-based, never
// source/target/package-specific.
function hasCompleteBaselineRebootFailure(attempt, result) {
  const reason = String(result?.reason || '');
  if (!['incompatible', 'inconclusive'].includes(String(result?.result || '')) ||
      !['final-reboot-failed', 'final-reboot-health-failed'].includes(reason)) return false;
  const stages = attempt?.stages || {};
  const enteredReboot = ['boot', 'runtimeHealth', 'reboot']
    .every((name) => stages[name]?.status === 'success');
  const secondPhaseFailed = ['secondBoot', 'secondRuntimeHealth']
    .some((name) => stages[name]?.status === 'failure');
  return enteredReboot && secondPhaseFailed;
}

/**
 * Give Baseline-B the same result vocabulary at every depth.  A failed B is
 * a Base Profile blocker only when the Runner captured deterministic failure
 * evidence.  Harness/network/metadata failures remain unresolved and must
 * never be upgraded merely because they happened during B.
 */
function normalizeBaselinePhaseResult(attempt, result) {
  if (result?.result === 'compatible' || result?.result === 'skipped' || result?.result === 'blocked') return result;
  const reason = String(result?.reason || '');
  if (hasCompleteBaselineRebootFailure(attempt, result)) {
    attempt.baselineBlockReason = 'base-profile-reboot-failure';
    attempt.packageCauseKind = '';
    return { ...result, result: 'blocked', reason: 'base-profile-reboot-failure' };
  }
  if (isOperationalPhaseReason(reason)) {
    return { ...result, result: 'inconclusive', reason: reason || 'baseline-unresolved' };
  }
  if (!hasDeterministicBaselineEvidence(attempt, result)) {
    return { ...result, result: 'inconclusive', reason: reason || 'baseline-unresolved' };
  }
  const prepareFailure = attempt?.stages?.config?.status === 'failure' || attempt?.stages?.targetPrepare?.status === 'failure';
  attempt.baselineBlockReason = prepareFailure ? 'base-profile-prepare-failure' : 'base-profile-build-failure';
  attempt.packageCauseKind = '';
  return {
    ...result, result: 'blocked',
    reason: prepareFailure ? 'base-profile-prepare-failure' : 'base-profile-build-failure',
  };
}

function pairAttempt(baseline, final = null, preflight = null) {
  const selected = final || baseline || {};
  const preflightEvidence = preflight || baseline?.preflight || final?.preflight || null;
  const baselineOnlyResult = baseline?.result || 'inconclusive';
  // Every execution path must carry a structured reason.  Keep the legacy
  // `baseline-failure` spelling readable when consuming old artifacts, but do
  // not emit it for newly-created paired attempts.
  const baselineOnlyReason = baseline?.reason && baseline.reason !== 'baseline-failure'
    ? baseline.reason : 'baseline-unresolved';
  const baselineFinalReason = baseline?.result === 'blocked' ? 'baseline-blocked' : baselineOnlyReason;
  const pair = {
    ...selected,
    phase: 'paired',
    pairId: pairIdFor(selected),
    pairConclusion: final ? (final.result === 'incompatible'
      ? `incompatible-${final.packageCauseKind || 'unattributed'}`
      : final.result === 'blocked' ? `blocked-${final.reason || 'base-profile-failure'}`
      : final.result === 'inconclusive' ? 'inconclusive' : final.result || 'inconclusive')
      : baseline?.result === 'blocked' ? `blocked-${baseline.reason || 'base-profile-failure'}` : baselineOnlyReason,
    baseline,
    final: final || { phase: 'final', result: 'not-run', reason: baselineFinalReason, stages: {} },
  };
  if (final) Object.assign(pair, final);
  pair.phase = 'paired';
  pair.pairId = pairIdFor(selected);
  pair.baseline = baseline;
  pair.final = final || { phase: 'final', result: 'not-run', reason: baselineFinalReason, stages: {} };
  pair.preflight = preflightEvidence;
  pair.preflightResult = preflightEvidence?.result || '';
  pair.preflightReason = preflightEvidence?.reason || '';
  // A non-compatible B is never a package incompatibility.  A confirmed
  // Base Profile failure is a complete `blocked` domain conclusion; an
  // unresolved B remains an inconclusive transport result.
  pair.result = final ? final.result
    : baselineOnlyResult === 'blocked' ? 'blocked'
      : baselineOnlyResult === 'skipped' ? 'skipped' : 'inconclusive';
  pair.reason = final ? final.reason : baselineOnlyResult === 'skipped' ? baselineOnlyReason : baselineOnlyReason;
  pair.stages = {
    ...(preflightEvidence?.stage ? { preflight: preflightEvidence.stage } : {}),
    ...(final ? final.stages : (baseline?.stages || {})),
  };
  pair.packageCauseKind = final?.packageCauseKind || '';
  pair.prerequisiteCause = final?.prerequisiteCause || baseline?.prerequisiteCause || '';
  pair.targetPrerequisiteCause = final?.targetPrerequisiteCause || baseline?.targetPrerequisiteCause || '';
  if (final && 'runtimeCovered' in final) pair.runtimeCovered = final.runtimeCovered;
  else if (baseline && 'runtimeCovered' in baseline) pair.runtimeCovered = baseline.runtimeCovered;
  pair.runtimeCoverageReason = final?.runtimeCoverageReason || baseline?.runtimeCoverageReason || '';
  pair.terminalError = final?.terminalError || final?.errorSummary || baseline?.terminalError || baseline?.errorSummary || '';
  pair.errorSummary = pair.terminalError;
  pair.recoverableErrors = [...new Set([...(baseline?.recoverableErrors || []), ...(final?.recoverableErrors || [])])];
  pair.baselineConfigHash = baseline?.configHash || '';
  pair.finalConfigHash = final?.configHash || '';
  pair.configHash = final?.configHash || baseline?.configHash || '';
  pair.resolvedConfigDiff = final?.configDiff || {};
  pair.configDiff = final?.configDiff || {};
  pair.addedDependencies = final?.newDependencyPackages || final?.configDiff?.addedDependencies || [];
  pair.newDependencyTargets = final?.newDependencyTargets || [];
  pair.failureFingerprint = final?.failureFingerprint || baseline?.failureFingerprint || phaseFailureFingerprint(pair);
  pair.finishedAt = final?.finishedAt || baseline?.finishedAt || new Date().toISOString();
  pair.durationMs = Math.max(0, Number(baseline?.durationMs || 0) + Number(final?.durationMs || 0));
  return pair;
}

function decorateL1Pair(baseline, final, preflight = null) {
  if (final && baseline?.resolvedPackageStates && final.resolvedPackageStates) {
    final.configDiff = resolvedConfigDiff(baseline.resolvedPackageStates, final.resolvedPackageStates, ROOTS);
    final.resolvedConfigDiff = final.configDiff;
    final.newDependencyPackages = final.configDiff.addedDependencies;
    try { final.newDependencyTargets = mappedBuildTargets(readPackageInfo(), final.newDependencyPackages); }
    catch { final.newDependencyTargets = []; }
  }
  return pairAttempt(baseline, final, preflight);
}

async function configResolvePaired() {
  const preflight = await preflightRoots(ROOTS);
  if (preflight.result !== 'available') return TARGET_BATCH.map((environment) => preflightPairAttempt(preflight, environment));
  const baseline = await withPhaseLog('baseline', () => configResolve({
    roots: BASELINE_ROOTS, requestedStates: BASELINE_DIRECT_STATES, phase: 'baseline', requireEnabled: true,
  }));
  const runnable = TARGET_BATCH.filter((environment, index) => baseline[index]?.result === 'compatible');
  const finalRows = runnable.length ? await withPhaseLog('final', () => configResolve({
    roots: ROOTS, requestedStates: FINAL_DIRECT_STATES, phase: 'final', requireEnabled: true, environments: runnable,
  })) : [];
  const finalByIdentity = new Map(finalRows.map((row) => [phaseIdentity(row), row]));
  return TARGET_BATCH.map((environment, index) => {
    const baselineAttempt = baseline[index];
    const finalAttempt = baselineAttempt?.result === 'compatible' ? finalByIdentity.get(phaseIdentity(environment)) || null : null;
    return decorateL1Pair(baselineAttempt, finalAttempt, preflight);
  });
}

async function runDepthPhase({ phase, roots, requestedStates, finalStates, baselineResolvedStates, skipVirtual = false, runtimeSkipReason = '' }) {
  const attempt = {
    source: SOURCE, branch: BRANCH, targetSystem: TARGET_SYSTEM, subtarget: SUBTARGET,
    target: TARGET, profile: PROFILE, phase,
    stages: {}, rootStates: {}, rootMappings: [], sourceMakefiles: [], rootTargets: [],
    unavailableRoots: [], rejectedRoots: [], serialRetries: [],
  };
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  attempt.startedAt = startedAt;
  let result;
  await withPhaseLog(phase, async (phaseLog) => {
    attempt.phaseLog = phaseLog;
    try {
      const options = { phase, roots, requestedStates, finalStates, baselineResolvedStates, skipVirtual, runtimeSkipReason };
      if (MODE === 'package-compile') result = await packageCompile(attempt, options);
      else if (MODE === 'rootfs-integration') result = await rootfsIntegration(attempt, options);
      else result = await firmwareIntegration(attempt, options);
    } catch (error) {
      attempt.error = String(error?.message || error);
      result = { result: 'inconclusive', reason: 'runner-infrastructure' };
    }
  });
  if (phase === 'baseline') result = normalizeBaselinePhaseResult(attempt, result);
  return completedPhaseAttempt(attempt, result, startedAt, started);
}

function replayMakeVariables(directory, hostToolchain = null) {
  const paths = replayDirectoryPaths(directory);
  // OpenWrt's host tools are prerequisites of `make prepare` itself.  A
  // fresh STAGING_DIR_HOST cannot build tools such as mkhash/gzip because
  // those tools are needed before the first replay tool can be prepared.
  // Reuse the already prepared Baseline-B host tree explicitly while the
  // target-side build/staging/tmp/bin trees remain private to the replay.
  const sharedHost = typeof hostToolchain === 'string' ? hostToolchain : hostToolchain?.stagingDir;
  const hostBuildDir = typeof hostToolchain === 'object' ? hostToolchain?.buildDir : '';
  const stagingDirHost = sharedHost || paths.staging_dir_host;
  // GNU make/OpenWrt accepts POSIX separators for these logical workspace
  // variables.  Normalize on Windows as well so the replay contract is
  // stable across hosts (and so suffix-based diagnostics do not confuse a
  // path separator with a different directory layout).
  const makePath = (value) => String(value || '').replaceAll('\\', '/');
  return [
    `BUILD_DIR=${makePath(paths.build_dir)}`,
    ...(hostBuildDir ? [`BUILD_DIR_HOST=${makePath(hostBuildDir)}`] : []),
    `STAGING_DIR=${makePath(paths.staging_dir)}`,
    `STAGING_DIR_HOST=${makePath(stagingDirHost)}`,
    `TMP_DIR=${makePath(paths.tmp)}`,
    `BIN_DIR=${makePath(paths.bin)}`,
  ];
}

// OpenWrt derives STAGING_DIR_HOST from STAGING_DIR as `staging_dir/host`.
// Keep the logical replay directory in that shape; replayMakeVariables then
// explicitly points STAGING_DIR_HOST at Baseline-B's prepared host tree so
// `make prepare` can invoke host tools before bootstrapping a fresh target
// staging tree.
const REPLAY_DIRECTORY_NAMES = Object.freeze(['build_dir', 'staging_dir', 'tmp', 'bin']);

function replayDirectoryPaths(directory) {
  const paths = Object.fromEntries(REPLAY_DIRECTORY_NAMES.map((name) => [name, join(directory, name)]));
  paths.staging_dir_host = join(paths.staging_dir, 'host');
  return paths;
}

function prepareReplayWorkspace(directory) {
  const paths = replayDirectoryPaths(directory);
  const hostToolchain = {
    stagingDir: join(WORKDIR, 'staging_dir', 'host'),
    buildDir: join(WORKDIR, 'build_dir', 'host'),
    source: 'baseline-staging_dir/host',
    shared: true,
  };
  const requiredStamps = {
    tmpBuild: join(paths.tmp, '.build'),
    // STAGING_DIR_HOST is intentionally the prepared Baseline-B host tree;
    // record the actual stamp path used by Make rather than the empty logical
    // replay/staging_dir/host directory.
    stagingHostPrereq: join(hostToolchain.stagingDir, '.prereq-build'),
  };
  try {
    mkdirSync(directory, { recursive: true });
    for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
    if (!existsSync(hostToolchain.stagingDir) || !statSync(hostToolchain.stagingDir).isDirectory()) {
      return {
        ok: false,
        reason: 'replay-host-toolchain-unavailable',
        error: `baseline host toolchain is missing or not a directory: ${hostToolchain.stagingDir}`,
        paths, requiredStamps, hostToolchain,
      };
    }
    // These are Make stamp files, not directories.  A directory at either
    // path makes `touch`/file prerequisites fail with an opaque replay error;
    // reject that shape rather than deleting or masking an existing path.
    const stampConflicts = Object.entries(requiredStamps)
      .filter(([, path]) => existsSync(path) && !statSync(path).isFile())
      .map(([name]) => name);
    if (stampConflicts.length) {
      return { ok: false, reason: 'replay-bootstrap-failure',
        error: `replay stamp paths are not files: ${stampConflicts.join(', ')}`, paths, requiredStamps, hostToolchain };
    }
    for (const path of Object.values(requiredStamps)) writeFileSync(path, '', { flag: 'a' });
    for (const name of ['.packageinfo', '.targetinfo']) {
      const source = join(WORKDIR, 'tmp', name);
      const destination = join(paths.tmp, name);
      if (existsSync(source) && statSync(source).isFile()) copyFileSync(source, destination);
    }
    const missing = Object.entries(paths).filter(([, path]) => !existsSync(path) || !statSync(path).isDirectory()).map(([name]) => name);
    if (missing.length) {
      return { ok: false, reason: 'replay-bootstrap-failure', error: `replay directories are missing or not directories: ${missing.join(', ')}`, paths, requiredStamps, hostToolchain };
    }
    const nonFiles = Object.entries(requiredStamps).filter(([, path]) => !existsSync(path) || !statSync(path).isFile()).map(([name]) => name);
    if (nonFiles.length) {
      return { ok: false, reason: 'replay-bootstrap-failure', error: `replay stamp paths are missing or not files: ${nonFiles.join(', ')}`, paths, requiredStamps, hostToolchain };
    }
    return { ok: true, paths, requiredStamps, hostToolchain };
  } catch (error) {
    return { ok: false, reason: 'replay-bootstrap-failure', error: String(error?.message || error), paths, requiredStamps, hostToolchain };
  }
}

function counterfactualFailureDetail(result) {
  const detail = classifyPrerequisiteFailure(result?.output || '');
  const normalized = {
    cause: detail.cause || '', errorSummary: detail.errorSummary || '',
    terminalError: detail.terminalError || detail.errorSummary || '',
    recoverableErrors: detail.recoverableErrors || [],
    failedBuildTargets: detail.failedBuildTargets || [],
    failureFingerprint: detail.failureFingerprint || '',
  };
  // Keep bounded command output available to the replay-capability matcher,
  // but never enumerable: unresolved/counterfactual evidence spreads this
  // detail object, so exposing rawOutput there would duplicate the whole
  // prepare log in runtime JSON and uploaded evidence.
  Object.defineProperty(normalized, 'rawOutput', {
    value: String(result?.output || ''), enumerable: false, configurable: false,
  });
  return normalized;
}

function hasDeterministicCounterfactualFailure(detail) {
  const terminalError = String(detail?.terminalError || detail?.errorSummary || '').trim();
  if (!terminalError || isMakeInfrastructureFailure(terminalError)) return false;
  // Once the isolated replay has entered the exact shared target, an allowed
  // prerequisite cause or a concrete failed target is sufficient domain
  // evidence.  A bare script/compiler non-zero with neither is still a
  // Runner attribution gap and must remain unresolved.
  return Boolean(detail?.cause || detail?.failedBuildTargets?.length);
}

function isKnownReplayCapabilityFailure(detail, replayStage) {
  if (!['prepare'].includes(String(replayStage || ''))) return false;
  const text = [detail?.terminalError, detail?.errorSummary, ...(detail?.recoverableErrors || []), detail?.rawOutput]
    .filter(Boolean).join('\n');
  // These are replay-harness directory contracts, not an upstream Target
  // failure.  Only path-specific evidence is reportable; a generic Make or
  // compiler error remains the red `counterfactual-unresolved` result.
  const stampPath = '(?:tmp[\\/]\\.build|staging_dir(?:[\\/]host|_host)[\\/]\\.prereq-build)';
  const missing = '(?:missing|not\\s+found|does\\s+not\\s+exist|incomplete)';
  const replayHostBinary = '[^\\n]*\\.probe-replays[\\/][^\\n]*?staging_dir[\\/]host[\\/]bin[\\/][A-Za-z0-9._+-]+';
  const missingHostBinary = `(?:${replayHostBinary})[^\\n]*(?:no such file or directory|${missing})`;
  return new RegExp(`(?:no\\s+rule\\s+to\\s+make\\s+target[^\\n]*${stampPath}|${stampPath}[^\\n]*${missing}|(?:BUILD_DIR|STAGING_DIR(?:_HOST)?|TMP_DIR|BIN_DIR)[^\\n]*${missing}|${missingHostBinary})`, 'i').test(text);
}

function preserveFinalFailure(final) {
  if (!final || final.originalFailure) return;
  final.originalFailure = {
    terminalError: final.terminalError || '', errorSummary: final.errorSummary || '',
    recoverableErrors: [...(final.recoverableErrors || [])],
    failedBuildTargets: [...(final.failedBuildTargets || [])],
    failureCause: final.failureCause || '', prerequisiteCause: final.prerequisiteCause || '',
    targetPrerequisiteCause: final.targetPrerequisiteCause || '', reason: final.reason || '',
    failureFingerprint: final.failureFingerprint || '',
  };
}

function setReplayUnavailable(final, target, stage, detail, replayAttempt, directory) {
  final.counterfactual = {
    type: 'shared-target', target, mode: 'isolated-replay', result: 'unavailable',
    reason: 'counterfactual-replay-unavailable', stage, directory,
    ...(detail?.errorSummary ? { errorSummary: detail.errorSummary } : {}),
    ...(detail?.terminalError ? { terminalError: detail.terminalError } : {}),
    ...(detail?.failedBuildTargets?.length ? { failedBuildTargets: detail.failedBuildTargets } : {}),
  };
  final.reason = 'counterfactual-replay-unavailable';
  final.packageCauseKind = '';
  // Replay diagnostics stay under the counterfactual/baselineReplay fields;
  // the Final-A error remains the authoritative primary failure.
  applyFailureDetail(final, detail, { preserveExisting: true });
  final.baselineReplay = { ...replayAttempt, directory };
}

/**
 * Re-run a failed Final-A shared target against Baseline-B's resolved config.
 *
 * A direct Root is intentionally excluded here: compiling it in B would no
 * longer be the requested counterfactual.  For a shared target that B did
 * not execute, the replay gets independent build/staging/tmp/bin trees and
 * a separate Kconfig file.  Download caches remain available through the
 * inherited environment, while stamps and generated outputs cannot leak
 * between A and B.
 */
async function replaySharedTarget(baseline, final) {
  const failedTargets = uniqueNormalizedTargets(final?.failedBuildTargets || []);
  const sharedTargets = new Set(uniqueNormalizedTargets(final?.sharedBuildTargets || []));
  const target = failedTargets.find((candidate) => sharedTargets.has(candidate)) ||
    failedTargets.find((candidate) => candidate.startsWith('target/'));
  if (!target) return { applied: false, reason: 'not-shared-target' };

  final.sharedTarget = target;
  final.sharedTargetOwnership = final.buildTargetOwnership?.[target] || [];
  // Capture Final-A before any replay branch can attach diagnostics or
  // replace its primary error.  This also covers missing B config, workspace
  // bootstrap failures, and Runner exceptions where no Make stage is reached.
  preserveFinalFailure(final);
  // `make prepare` is itself the shared Target build.  When B completed it
  // and A fails inside the generic Target namespace, the B execution is a
  // sufficient counterfactual; do not force a package-root replay.
  if (target.startsWith('target/') && baseline?.stages?.targetPrepare?.status === 'success') {
    final.counterfactual = { type: 'shared-target', target, mode: 'baseline-executed', result: 'passed' };
    final.packageCauseKind = 'shared';
    final.result = 'incompatible';
    final.reason = 'plugin-induced-failure';
    return { applied: true, result: 'plugin-induced', target };
  }
  if (uniqueNormalizedTargets(baseline?.executedBuildTargets || []).includes(target)) {
    final.counterfactual = { type: 'shared-target', target, mode: 'baseline-executed', result: 'passed' };
    final.packageCauseKind = 'shared';
    final.result = 'incompatible';
    final.reason = 'plugin-induced-failure';
    return { applied: true, result: 'plugin-induced', target };
  }

  const baselineConfig = baseline?.configPath;
  if (!baselineConfig || !existsSync(baselineConfig)) {
    final.counterfactual = { type: 'shared-target', target, mode: 'isolated-replay', result: 'unresolved', reason: 'baseline-config-missing' };
    final.reason = 'counterfactual-unresolved';
    return { applied: true, result: 'unresolved', target, reason: 'baseline-config-missing' };
  }

  const replayDirectory = join(WORKDIR, '.probe-replays', `${safeSlug(TARGET || 'target')}--${safeSlug(PROFILE || 'profile')}--${safeSlug(target)}`);
  let replayCleanupError = null;
  try { rmSync(replayDirectory, { recursive: true, force: true }); }
  catch (error) { replayCleanupError = String(error?.message || error); }
  const replayWorkspace = replayCleanupError
    ? { ok: false, reason: 'replay-bootstrap-failure', error: replayCleanupError, paths: replayDirectoryPaths(replayDirectory) }
    : prepareReplayWorkspace(replayDirectory);
  const replayAttempt = {
    phase: 'baseline-replay', target, stages: {}, serialRetries: [],
    replayDirectories: replayWorkspace.paths,
    replayRequiredStamps: replayWorkspace.requiredStamps || {},
    replayHostToolchain: replayWorkspace.hostToolchain || null,
  };
  if (!replayWorkspace.ok) {
    replayAttempt.stages.replayBootstrap = { status: 'failure', reason: replayWorkspace.reason };
    replayAttempt.error = replayWorkspace.error;
    if (replayWorkspace.reason === 'replay-host-toolchain-unavailable') {
      preserveFinalFailure(final);
      final.counterfactual = {
        type: 'shared-target', target, mode: 'isolated-replay', result: 'unavailable',
        reason: 'counterfactual-replay-unavailable', stage: 'bootstrap',
        error: replayWorkspace.error, directory: replayDirectory,
      };
      final.reason = 'counterfactual-replay-unavailable';
      final.packageCauseKind = '';
      final.baselineReplay = { ...replayAttempt, directory: replayDirectory };
      return { applied: true, result: 'unavailable', target, reason: 'counterfactual-replay-unavailable' };
    }
    final.counterfactual = {
      type: 'shared-target', target, mode: 'isolated-replay', result: 'unresolved',
      reason: replayWorkspace.reason, error: replayWorkspace.error, directory: replayDirectory,
    };
    final.reason = 'counterfactual-unresolved';
    final.baselineReplay = { ...replayAttempt, directory: replayDirectory };
    return { applied: true, result: 'unresolved', target, reason: replayWorkspace.reason };
  }
  replayAttempt.stages.replayBootstrap = { status: 'success' };
  const replayConfig = join(replayDirectory, '.config');
  const topLevelConfig = join(WORKDIR, '.config');
  let originalConfig = null;
  let originalConfigCaptured = false;
  let replayPrepareStarted = false;
  let replayTargetStarted = false;
  const env = { KCONFIG_CONFIG: replayConfig, KCONFIG_OVERWRITECONFIG: '1', PROBE_REPLAY: 'true' };
  const variables = replayMakeVariables(replayDirectory, replayWorkspace.hostToolchain);
  const options = { cwd: WORKDIR, env };
  let prep;
  let targetResult;
  try {
    // File access is part of the replay bootstrap.  Any permission/path
    // failure here is an unresolved Runner result, never a Base Profile
    // conclusion.
    copyFileSync(baselineConfig, replayConfig);
    originalConfig = existsSync(topLevelConfig) ? readFileSync(topLevelConfig) : null;
    originalConfigCaptured = true;
    // Fake and older OpenWrt make frontends read .config from TOPDIR even
    // when KCONFIG_CONFIG is set.  Keep that file aligned for the duration
    // of the replay and always restore Final-A afterwards.
    copyFileSync(replayConfig, topLevelConfig);
    replayPrepareStarted = true;
    prep = await makeWithSerialRetry(['prepare', ...variables], 'Baseline shared-target replay preparation', replayAttempt, options);
    replayAttempt.stages.replayPrepare = { status: prep.ok ? 'success' : 'failure' };
    if (!prep.ok) {
      const detail = counterfactualFailureDetail(prep);
      const infrastructure = isCommandInfrastructureFailure(prep);
      applyFailureDetail(replayAttempt, detail);
      replayAttempt.failedBuildTargets = detail.failedBuildTargets;
      replayAttempt.failureFingerprint = detail.failureFingerprint;
      preserveFinalFailure(final);
      if (!infrastructure && isKnownReplayCapabilityFailure(detail, 'prepare')) {
        setReplayUnavailable(final, target, 'prepare', detail, replayAttempt, replayDirectory);
        final.failureFingerprint = final.originalFailure?.failureFingerprint || final.failureFingerprint || '';
        return { applied: true, result: 'unavailable', target, reason: 'counterfactual-replay-unavailable' };
      }
      final.counterfactual = {
        type: 'shared-target', target, mode: 'isolated-replay', result: 'unresolved', stage: 'prepare',
        // B already passed prepare.  A fresh replay prepare failure proves
        // only that the replay harness/environment diverged; the shared
        // target was never entered, so it cannot establish a Base Profile
        // blocker.
        reason: infrastructure ? 'replay-prepare-infrastructure' : 'replay-prepare-unresolved', ...detail,
      };
      applyFailureDetail(final, detail, { preserveExisting: true });
      final.failureFingerprint = final.originalFailure?.failureFingerprint || final.failureFingerprint || '';
      final.replayFailedBuildTargets = detail.failedBuildTargets || [];
      final.replayPrerequisiteCause = detail.cause || '';
      if (detail.failedBuildTargets.length) final.failedBuildTargets = detail.failedBuildTargets;
      if (detail.cause) final.targetPrerequisiteCause = detail.cause;
      final.packageCauseKind = '';
      final.reason = 'counterfactual-unresolved';
      return { applied: true, result: 'unresolved', target,
        reason: infrastructure ? 'replay-prepare-infrastructure' : 'replay-prepare-unresolved' };
    }
    replayTargetStarted = true;
    targetResult = await makeWithSerialRetry([`${target}/compile`, ...variables], 'Baseline shared-target replay', replayAttempt, options);
    replayAttempt.stages.replayTarget = { status: targetResult.ok ? 'success' : 'failure' };
    if (targetResult.ok) {
      final.counterfactual = { type: 'shared-target', target, mode: 'isolated-replay', result: 'passed', directory: replayDirectory };
      final.packageCauseKind = 'shared';
      final.result = 'incompatible';
      final.reason = 'plugin-induced-failure';
      return { applied: true, result: 'plugin-induced', target };
    }
    const detail = counterfactualFailureDetail(targetResult);
    if (isCommandInfrastructureFailure(targetResult)) {
      final.counterfactual = {
        type: 'shared-target', target, mode: 'isolated-replay', result: 'unresolved',
        reason: 'replay-infrastructure-failure', directory: replayDirectory, ...detail,
      };
      final.reason = 'counterfactual-unresolved';
      preserveFinalFailure(final);
      applyFailureDetail(final, detail, { preserveExisting: true });
      return { applied: true, result: 'unresolved', target, reason: 'replay-infrastructure-failure' };
    }
    if (!hasDeterministicCounterfactualFailure(detail)) {
      final.counterfactual = {
        type: 'shared-target', target, mode: 'isolated-replay', result: 'unresolved',
        reason: 'replay-target-unresolved', directory: replayDirectory, ...detail,
      };
      final.packageCauseKind = '';
      final.reason = 'counterfactual-unresolved';
      preserveFinalFailure(final);
      applyFailureDetail(final, detail, { preserveExisting: true });
      final.replayFailedBuildTargets = detail.failedBuildTargets || [];
      final.replayFailureFingerprint = detail.failureFingerprint || '';
      return { applied: true, result: 'unresolved', target, reason: 'replay-target-unresolved' };
    }
    final.counterfactual = {
      type: 'shared-target', target, mode: 'isolated-replay', result: 'failed',
      reason: 'base-profile-build-failure', directory: replayDirectory, ...detail,
    };
    final.packageCauseKind = '';
    final.result = 'blocked';
    final.reason = 'base-profile-build-failure';
    preserveFinalFailure(final);
    applyFailureDetail(final, detail, { preserveExisting: true });
    final.replayFailedBuildTargets = detail.failedBuildTargets || [];
    final.replayFailureFingerprint = detail.failureFingerprint || '';
    return { applied: true, result: 'base-profile-build-failure', target };
  } catch (error) {
    // A thrown file/Runner error is a replay-bootstrap or replay-target
    // capability failure, never evidence that the Base Profile failed.  Mark
    // the stage explicitly so downstream evidence can distinguish it from a
    // missing/failed Make result while retaining the original Final-A error.
    if (!replayPrepareStarted) {
      replayAttempt.stages.replayBootstrap = { status: 'failure', reason: 'replay-runner-failure' };
    } else if (!replayTargetStarted) {
      replayAttempt.stages.replayPrepare = { status: 'failure', reason: 'replay-runner-failure' };
    } else {
      replayAttempt.stages.replayTarget = { status: 'failure', reason: 'replay-runner-failure' };
    }
    preserveFinalFailure(final);
    final.counterfactual = {
      type: 'shared-target', target, mode: 'isolated-replay', result: 'unresolved',
      reason: 'replay-runner-failure', error: String(error?.message || error), directory: replayDirectory,
    };
    final.reason = 'counterfactual-unresolved';
    return { applied: true, result: 'unresolved', target, reason: 'replay-runner-failure' };
  } finally {
    if (originalConfigCaptured) {
      if (originalConfig === null) rmSync(topLevelConfig, { force: true });
      else writeFileSync(topLevelConfig, originalConfig);
    }
    final.baselineReplay = { ...replayAttempt, directory: replayDirectory };
  }
}

function baselineRuntimeCoverageSkip(attempt) {
  return MODE_LEVELS[MODE] >= MODE_LEVELS['boot-smoke'] && attempt?.result === 'skipped' &&
    attempt?.stages?.firmwareBuild?.status === 'success' && Number(attempt?.deepestPassedLevel || 0) >= 4;
}

async function runDepthPaired() {
  const preflight = await preflightRoots(ROOTS);
  if (preflight.result !== 'available') return [preflightPairAttempt(preflight)];
  const baseline = await runDepthPhase({
    phase: 'baseline', roots: BASELINE_ROOTS, requestedStates: BASELINE_DIRECT_STATES,
    finalStates: BASELINE_STATES,
  });
  // A virtual capability skip after a successful firmware build is not a
  // Base Profile failure.  Keep B's coverage result, but still run Final A
  // through L4 so package/firmware compatibility is evaluated.  All other B
  // non-compatible states (blocked, unresolved, or an earlier skip) remain a
  // hard short-circuit.
  const continueAfterBaselineRuntimeSkip = baselineRuntimeCoverageSkip(baseline);
  if (baseline.result !== 'compatible' && !continueAfterBaselineRuntimeSkip) {
    return [pairAttempt(baseline, null, preflight)];
  }
  const final = await runDepthPhase({
    phase: 'final', roots: ROOTS, requestedStates: FINAL_DIRECT_STATES,
    finalStates: FINAL_STATES, baselineResolvedStates: baseline.resolvedPackageStates || {},
    skipVirtual: continueAfterBaselineRuntimeSkip,
    runtimeSkipReason: baseline.runtimeCoverageReason || baseline.reason || 'virtual-boot-unsupported',
  });
  if (final.result === 'inconclusive' && final.failedBuildTargets?.length &&
      final.reason !== 'target-prerequisite-infrastructure') {
    const replay = await replaySharedTarget(baseline, final);
    if (!replay.applied && !String(final.reason || '').includes('infrastructure') &&
        !String(final.reason || '').includes('metadata') && !String(final.reason || '').includes('runner')) {
      final.counterfactual = {
        type: 'shared-target', mode: 'unavailable', result: 'unresolved',
        reason: 'target-ownership-unresolved', failedBuildTargets: final.failedBuildTargets,
      };
      final.reason = 'counterfactual-unresolved';
    }
    final.failureFingerprint = phaseFailureFingerprint(final);
  }
  return [pairAttempt(baseline, final, preflight)];
}

export function parseUpstreamPackageInfo(text) {
  const mapping = new Map();
  let sourceMakefile = '';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const source = line.match(/^Source-Makefile:\s*(.+)$/);
    if (source) {
      sourceMakefile = source[1].trim().replace(/\\/g, '/');
      continue;
    }
    const pkg = line.match(/^Package:\s*(\S+)$/);
    if (!pkg || !sourceMakefile) continue;
    if (!mapping.has(pkg[1])) mapping.set(pkg[1], new Set());
    mapping.get(pkg[1]).add(sourceMakefile);
  }
  return mapping;
}

function safeSourceMakefile(value) {
  const source = String(value || '').replace(/\\/g, '/');
  if (!source.startsWith('package/') || !source.endsWith('/Makefile') || source.includes('../') || source.includes('/./')) {
    throw new Error(`unsafe upstream Source-Makefile: ${value}`);
  }
  return source;
}

export function resolveRootBuildTargets(packageInfo, roots = ROOTS) {
  const mapping = parseUpstreamPackageInfo(packageInfo);
  const sourceMakefiles = [];
  const rootMappings = [];
  for (const root of roots) {
    const sources = [...(mapping.get(root) || [])].map(safeSourceMakefile).sort();
    if (sources.length !== 1) {
      const error = new Error(sources.length ? `ambiguous upstream Source-Makefile for ${root}: ${sources.join(', ')}`
        : `upstream package metadata does not contain Probe root: ${root}`);
      error.code = 'PROBE_METADATA_UNRESOLVED';
      throw error;
    }
    rootMappings.push({ package: root, sourceMakefile: sources[0] });
    sourceMakefiles.push(sources[0]);
  }
  const uniqueSources = [...new Set(sourceMakefiles)];
  const targets = uniqueSources.map((source) => `${posix.dirname(source)}/compile`);
  return { rootMappings, sourceMakefiles: uniqueSources, targets };
}

function readPackageInfo() {
  const path = join(WORKDIR, 'tmp', '.packageinfo');
  if (!existsSync(path)) {
    const error = new Error('upstream tmp/.packageinfo is missing after metadata preparation');
    error.code = 'PROBE_METADATA_UNRESOLVED';
    throw error;
  }
  return readFileSync(path, 'utf8');
}

async function preflightRoots(roots = ROOTS) {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  let packageInfo = '';
  let metadataFailure = null;
  let refreshStatus = 'not-run';
  let phaseLog = '';
  await withPhaseLog('preflight', async (logFile) => {
    phaseLog = logFile;
    log('Preflight: refreshing package metadata after Feeds installation.');
    const metadata = await command('bash', [join(ROOT, 'scripts', 'prepare-metadata.sh'), 'metadata-only']);
    refreshStatus = metadata.ok ? 'success' : 'failure';
    if (!metadata.ok) {
      const detail = classifyPrerequisiteFailure(metadata.output);
      metadataFailure = {
        reason: 'metadata-unresolved',
        errorSummary: detail.errorSummary || 'metadata refresh failed after Feeds installation',
      };
    } else {
      try {
        packageInfo = readPackageInfo();
      } catch (readError) {
        refreshStatus = 'failure';
        metadataFailure = { reason: 'metadata-unresolved', errorSummary: readError.message };
      }
    }
  });
  const finishedAt = new Date().toISOString();
  const stage = {
    status: metadataFailure ? 'failure' : 'success', startedAt, finishedAt,
    durationMs: Math.max(0, Date.now() - started),
    refresh: {
      status: refreshStatus,
      command: 'scripts/prepare-metadata.sh metadata-only',
      packageInfo: packageInfo ? 'present' : 'missing',
    },
  };
  if (metadataFailure) {
    log(`ERROR: Preflight package metadata could not be resolved: ${metadataFailure.errorSummary || metadataFailure.reason}`);
    return {
      result: 'inconclusive', reason: metadataFailure.reason, errorSummary: metadataFailure.errorSummary || '',
      unavailableRoots: [], rootMappings: [], sourceMakefiles: [], targets: [], phaseLog, stage,
    };
  }

  const mapping = parseUpstreamPackageInfo(packageInfo);
  const unavailableRoots = roots.filter((root) => !(mapping.get(root)?.size));
  if (unavailableRoots.length) {
    log(`SKIP: Preflight root package unavailable in Source/Branch: ${unavailableRoots.join(', ')}`);
    return {
      result: 'skipped', reason: 'root-absent-source', errorSummary: '', unavailableRoots,
      rootMappings: [], sourceMakefiles: [], targets: [], phaseLog, stage,
    };
  }
  const rootMappings = [];
  const sourceMakefiles = [];
  try {
    for (const root of roots) {
      const sources = [...(mapping.get(root) || [])].map(safeSourceMakefile).sort();
      if (sources.length !== 1) throw new Error(`ambiguous upstream Source-Makefile for ${root}: ${sources.join(', ')}`);
      rootMappings.push({ package: root, sourceMakefile: sources[0] });
      sourceMakefiles.push(sources[0]);
    }
  } catch (error) {
    log(`ERROR: Preflight package metadata is ambiguous: ${error.message}`);
    return {
      result: 'inconclusive', reason: 'metadata-unresolved', errorSummary: error.message,
      unavailableRoots: [], rootMappings: [], sourceMakefiles: [], targets: [], phaseLog, stage,
    };
  }
  const uniqueSources = [...new Set(sourceMakefiles)];
  const targets = uniqueSources.map((source) => `${posix.dirname(source)}/compile`);
  log(`Preflight package roots available / 预检插件可用: ${roots.join(', ')}`);
  return {
    result: 'available', reason: '', errorSummary: '', unavailableRoots, rootMappings,
    sourceMakefiles: uniqueSources, targets, phaseLog, stage,
  };
}

function notRunPhase(phase, reason) {
  return { phase, result: 'not-run', reason, stages: {}, rootStates: {}, rootMappings: [],
    sourceMakefiles: [], rootTargets: [], unavailableRoots: [], rejectedRoots: [], serialRetries: [] };
}

function preflightPairAttempt(preflight, environment = null) {
  const target = environment || {
    targetSystem: TARGET_SYSTEM, subtarget: SUBTARGET, target: TARGET, profile: PROFILE,
  };
  const result = preflight.result === 'skipped' ? 'skipped' : 'inconclusive';
  const reason = preflight.reason;
  const rootState = preflight.result === 'skipped' ? 'missing' : 'unknown';
  const pair = {
    source: SOURCE, branch: BRANCH,
    targetSystem: target.targetSystem || '', subtarget: target.subtarget || '', target: target.target || '',
    profile: target.profile || '', profileLabel: target.profileLabel || '', phase: 'paired',
    stages: { preflight: preflight.stage }, rootStates: Object.fromEntries(ROOTS.map((root) => [root, rootState])),
    rootMappings: preflight.rootMappings || [], sourceMakefiles: preflight.sourceMakefiles || [],
    rootTargets: preflight.targets || [], unavailableRoots: preflight.unavailableRoots || [], rejectedRoots: [], serialRetries: [],
    preflight: { ...preflight, stage: preflight.stage }, preflightResult: preflight.result, preflightReason: preflight.reason,
    result, reason, selectedLevel: MODE_LEVELS[MODE], deepestPassedLevel: 0,
    pairConclusion: preflight.result === 'skipped' ? 'preflight-skipped' : 'preflight-failure',
    baseline: notRunPhase('baseline', preflight.result === 'skipped' ? 'preflight-skipped' : 'preflight-failure'),
    final: notRunPhase('final', preflight.result === 'skipped' ? 'preflight-skipped' : 'preflight-failure'),
    packageCauseKind: '', prerequisiteCause: '', targetPrerequisiteCause: '', errorSummary: preflight.errorSummary || '',
    startedAt: preflight.stage.startedAt, finishedAt: preflight.stage.finishedAt, durationMs: preflight.stage.durationMs,
  };
  pair.pairId = pairIdFor(pair);
  pair.failureFingerprint = phaseFailureFingerprint(pair);
  return pair;
}

function classifyConfigFailure(config, attempt, roots = ROOTS) {
  if (config.reason !== 'root-kconfig-rejected') return { result: 'inconclusive', reason: config.reason };
  attempt.rejectedRoots = config.rejectedRoots || [];
  let packageInfo;
  try { packageInfo = readPackageInfo(); }
  catch (error) {
    log(`ERROR: ${error.message}`);
    return { result: 'inconclusive', reason: error.code || 'metadata-unresolved' };
  }
  const mapping = parseUpstreamPackageInfo(packageInfo);
  const unavailableRoots = roots.filter((root) => !(mapping.get(root)?.size));
  if (unavailableRoots.length) {
    attempt.unavailableRoots = unavailableRoots;
    log(`SKIP: Probe root package unavailable in Source/Branch: ${unavailableRoots.join(', ')}`);
    return { result: 'skipped', reason: 'root-absent-source' };
  }
  log(`FAIL: Probe root package rejected by upstream Kconfig: ${attempt.rejectedRoots.join(', ')}`);
  if (attempt.phase === 'final') attempt.packageCauseKind = 'direct';
  return { result: 'incompatible', reason: 'kconfig-unsatisfied' };
}

async function packageCompile(attempt, options = {}) {
  const roots = options.roots || ROOTS;
  const requestedStates = options.requestedStates || DIRECT_STATES;
  const phase = options.phase || 'final';
  const config = await runStage(attempt, 'config', () => prepareConfig(attempt, phase, {
    roots, requestedStates, file: options.configFile || join(WORKDIR, '.config'),
  }));
  attempt.rootStates = config.states;
  if (!config.ok) {
    if (config.infrastructure) {
      const detail = classifyPrerequisiteFailure(config.output || '');
      attempt.resolverCode = config.code;
      applyFailureDetail(attempt, detail);
      attempt.failureCause = detail.cause || '';
      attempt.failureFingerprint = detail.failureFingerprint || '';
      return { result: 'inconclusive', reason: 'runner-infrastructure' };
    }
    const classified = classifyConfigFailure(config, attempt, roots);
    if (classified.result === 'skipped') attempt.stages.config.status = 'skipped';
    if (phase === 'baseline' && classified.result === 'inconclusive' && classified.reason !== 'target-prerequisite-infrastructure') {
      attempt.baselineBlockReason = classified.reason;
      return { ...classified, result: 'blocked', reason: 'base-profile-prepare-failure' };
    }
    return classified;
  }
  let packageInfo = '';
  try { packageInfo = readPackageInfo(); } catch {}
  if (packageInfo) {
    try {
      const ownership = enabledPackageTargetOwnership(packageInfo, config.resolvedPackageStates);
      attempt.buildTargetOwnership = targetOwnershipObject(ownership);
      attempt.selectedBuildTargets = [...ownership.keys()].sort();
      if (options.baselineResolvedStates) {
        const baselineOwnership = enabledPackageTargetOwnership(packageInfo, options.baselineResolvedStates);
        attempt.sharedBuildTargets = [...ownership.keys()].filter((target) => baselineOwnership.has(target)).sort();
        attempt.baselineBuildTargets = [...baselineOwnership.keys()].sort();
      }
    } catch {
      attempt.buildTargetOwnership = {};
      attempt.selectedBuildTargets = [];
      attempt.sharedBuildTargets = [];
    }
  }
  if (options.baselineResolvedStates) {
    attempt.configDiff = resolvedConfigDiff(options.baselineResolvedStates, config.resolvedPackageStates, roots);
    attempt.resolvedConfigDiff = attempt.configDiff;
    attempt.newDependencyPackages = attempt.configDiff.addedDependencies;
    try {
      attempt.newDependencyTargets = mappedBuildTargets(packageInfo || readPackageInfo(), attempt.newDependencyPackages);
    } catch {
      attempt.newDependencyTargets = [];
    }
  }
  let resolved;
  try { resolved = await runStage(attempt, 'metadata', async () => resolveRootBuildTargets(readPackageInfo(), roots)); }
  catch (error) {
    log(`ERROR: ${error.message}`);
    return { result: 'inconclusive', reason: error.code || 'metadata-unresolved' };
  }
  attempt.rootMappings = resolved.rootMappings;
  attempt.sourceMakefiles = resolved.sourceMakefiles;
  attempt.rootTargets = resolved.targets;
  attempt.directBuildTargets = uniqueNormalizedTargets(resolved.targets);
  attempt.attemptedBuildTargets = [];
  attempt.executedBuildTargets = [];
  log(`Upstream root build targets / 上游入口目标: ${resolved.targets.join(' ')}`);
  // The compatibility document is the only reviewed source for known failed
  // concrete build packages.  Use the freshly refreshed .packageinfo graph to
  // prove whether the selected roots can reach one before entering make's
  // Target preparation/compile stages.  No package names are embedded here;
  // missing or conditional graph facts remain structured inconclusive.
  const closure = packageClosureGate(attempt, packageInfo || readPackageInfo(), roots, phase);
  if (closure.result !== 'clear') {
    if (phase === 'baseline' && closure.result === 'inconclusive') {
      attempt.baselineBlockReason = closure.reason;
      return { ...closure, result: 'blocked', reason: 'base-profile-prepare-failure' };
    }
    return closure;
  }
  const target = await runStage(attempt, 'targetPrepare', () =>
    makeWithSerialRetry(['prepare'], 'Target build prerequisites', attempt));
  if (!target.ok) {
    const classified = classifyTargetPrerequisiteFailure(target.output);
    if (classified.cause) attempt.targetPrerequisiteCause = classified.cause;
    applyFailureDetail(attempt, classified);
    attempt.failedBuildTargets = classified.failedBuildTargets || [];
    attempt.failureCause = classified.cause || '';
    attempt.failureFingerprint = classified.failureFingerprint || attempt.failureFingerprint || '';
    if (phase === 'baseline' && classified.reason !== 'target-prerequisite-infrastructure') {
      attempt.baselineBlockReason = classified.reason;
      return { ...classified, result: 'blocked', reason: 'base-profile-prepare-failure' };
    }
    return classified;
  }
  if (!resolved.targets.length) {
    attempt.stages.packageCompile = {
      status: 'skipped', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 0,
    };
    log(`SKIP: ${phase} has no direct package Root targets after defconfig`);
    if (phase === 'baseline') {
      attempt.baselineReady = true;
      attempt.baselinePackageCompile = 'not-run';
      return { result: 'compatible', reason: 'baseline-ready/no-direct-roots' };
    }
    return { result: 'compatible', reason: 'no-direct-roots' };
  }
  attempt.attemptedBuildTargets = uniqueNormalizedTargets(resolved.targets);
  const compiled = await runStage(attempt, 'packageCompile', () =>
    makeWithSerialRetry(resolved.targets, `${phase} probe roots: ${roots.join(',')}`, attempt));
  if (compiled.ok) attempt.executedBuildTargets = [...attempt.attemptedBuildTargets];
  if (!compiled.ok) {
    log(`ERROR: package compile target stage failed after resolved Roots: ${roots.join(', ')}`);
    return classifyPackageBuildFailure(compiled, resolved.targets, attempt, {
      root: 'package-compile-failure', infrastructure: 'package-compile-infrastructure',
      prerequisite: 'package-compile-prerequisite-failure', unattributed: 'package-compile-unattributed-failure',
      dependency: 'package-compile-dependency-failure',
    }, { dependencyTargets: options.dependencyTargets || attempt.newDependencyTargets,
      sharedTargets: attempt.sharedBuildTargets || [] });
  }
  return { result: 'compatible', reason: '' };
}

async function rootfsIntegration(attempt, options = {}) {
  const compiled = await packageCompile(attempt, options);
  if (compiled.result !== 'compatible') return compiled;
  const packages = await runStage(attempt, 'rootfsPackages', () =>
    makeWithSerialRetry(['package/compile'], 'RootFS selected packages', attempt));
  if (!packages.ok) return classifyPackageBuildFailure(packages, attempt.rootTargets, attempt, {
    root: 'rootfs-package-compile-failure', infrastructure: 'rootfs-package-infrastructure',
    prerequisite: 'rootfs-package-prerequisite-failure', unattributed: 'rootfs-package-unattributed-failure',
    dependency: 'rootfs-package-compile-dependency-failure',
  }, { dependencyTargets: options.dependencyTargets || attempt.newDependencyTargets,
    sharedTargets: attempt.sharedBuildTargets || [] });
  const installed = await runStage(attempt, 'rootfsInstall', () =>
    makeWithSerialRetry(['package/install'], 'rootfs install', attempt));
  if (!installed.ok) {
    log('FAIL: RootFS integration failed after Probe-root compilation');
    return classifyRootfsInstallFailure(installed, attempt, options.roots || ROOTS, options.dependencyPackages || attempt.newDependencyPackages || []);
  }
  return { result: 'compatible', reason: '' };
}

async function firmwareIntegration(attempt, options = {}) {
  const rootfs = await rootfsIntegration(attempt, options);
  if (rootfs.result !== 'compatible') return rootfs;
  const firmware = await runStage(attempt, 'firmwareBuild', () =>
    makeWithSerialRetry(['target/install'], 'final package firmware', attempt));
  if (!firmware.ok) {
    log('FAIL: Final package-enabled firmware failed');
    return classifyPackageBuildFailure(firmware, attempt.rootTargets, attempt, {
      root: 'final-firmware-failure', infrastructure: 'firmware-build-infrastructure',
      prerequisite: 'firmware-prerequisite-failure', unattributed: 'firmware-unattributed-failure',
      dependency: 'firmware-dependency-failure',
    }, { dependencyTargets: options.dependencyTargets || attempt.newDependencyTargets,
      sharedTargets: attempt.sharedBuildTargets || [] });
  }
  attempt.firmware = await firmwareSnapshot();
  if (MODE === 'firmware-integration') return { result: 'compatible', reason: '' };
  // When Baseline-B cannot establish a virtual runtime, Final-A is deliberately
  // capped at firmware (L4).  A new A-only image must not turn an uncovered
  // comparison into a boot/runtime plugin conclusion.
  if (options.skipVirtual) {
    attempt.runtimeCovered = false;
    attempt.runtimeCoverageReason = options.runtimeSkipReason || 'virtual-boot-unsupported';
    return { result: 'skipped', reason: attempt.runtimeCoverageReason };
  }
  const virtual = await runVirtualProbe({
    mode: MODE,
    phase: options.phase || 'final',
    workdir: WORKDIR,
    targetSystem: TARGET_SYSTEM,
    subtarget: SUBTARGET,
    installedRoots: (options.roots || ROOTS).filter((root) => (options.finalStates || FINAL_STATES).get(root) === 'y'),
    logFile: join(dirname(LOG_FILE), `probe-virtual-${safeSlug(options.phase || 'final')}.log`),
    bootTimeoutMs: Number(process.env.PROBE_BOOT_TIMEOUT_SECONDS || 180) * 1000,
    controlTimeoutMs: Number(process.env.PROBE_CONTROL_TIMEOUT_SECONDS || 30) * 1000,
    observationMs: Number(process.env.PROBE_RUNTIME_OBSERVATION_SECONDS || 15) * 1000,
    onOutput: (text) => { process.stdout.write(text); appendFileSync(LOG_FILE, text); },
  });
  Object.assign(attempt.stages, virtual.stages);
  attempt.virtualCapabilities = virtual.capabilities;
  attempt.virtualLog = virtual.logFile;
  attempt.runtimeCovered = virtual.runtimeCovered === true || virtual.result === 'compatible';
  attempt.runtimeCoverageReason = virtual.runtimeCovered === false || virtual.result !== 'compatible' ? (virtual.reason || '') : '';
  if (virtual.result === 'incompatible') attempt.packageCauseKind = 'direct';
  return { result: virtual.result, reason: virtual.reason };
}

function stagePassed(attempt, name) {
  return attempt.stages?.[name]?.status === 'success';
}

function deepestPassedLevel(attempt) {
  if (stagePassed(attempt, 'secondRuntimeHealth')) return 7;
  if (stagePassed(attempt, 'runtimeHealth')) return 6;
  if (stagePassed(attempt, 'boot')) return 5;
  if (stagePassed(attempt, 'firmwareBuild')) return 4;
  if (stagePassed(attempt, 'rootfsInstall')) return 3;
  if (stagePassed(attempt, 'packageCompile')) return 2;
  return 0;
}

const runtimeStarted = Date.now();
let attempts;
let overallResult;
let overallReason = '';
if (MODE === 'config-resolve') {
  attempts = PAIRED_COMPARISON ? await configResolvePaired() : await configResolve();
  const results = attempts.map((row) => row.result);
  if (results.includes('inconclusive')) overallResult = 'inconclusive';
  else if (results.includes('incompatible')) overallResult = 'incompatible';
  else if (results.includes('compatible')) overallResult = 'compatible';
  else overallResult = 'skipped';
  overallReason = attempts.find((row) => row.result === overallResult)?.reason || '';
} else {
  if (PAIRED_COMPARISON) {
    attempts = await runDepthPaired();
    overallResult = attempts[0]?.result || 'inconclusive';
    overallReason = attempts[0]?.reason || '';
  } else {
    const attempt = {
      source: SOURCE, branch: BRANCH,
      targetSystem: TARGET_SYSTEM, subtarget: SUBTARGET, target: TARGET, profile: PROFILE,
      phase: 'final', stages: {}, rootStates: {}, rootMappings: [], sourceMakefiles: [], rootTargets: [], unavailableRoots: [], rejectedRoots: [], serialRetries: [],
    };
    const attemptStarted = Date.now();
    attempt.startedAt = new Date(attemptStarted).toISOString();
    let result;
    try {
      if (MODE === 'package-compile') result = await packageCompile(attempt);
      else if (MODE === 'rootfs-integration') result = await rootfsIntegration(attempt);
      else result = await firmwareIntegration(attempt);
    } catch (error) {
      attempt.error = String(error?.message || error);
      result = { result: 'inconclusive', reason: 'runner-infrastructure' };
    }
    attempt.result = result.result; attempt.reason = result.reason;
    attempt.selectedLevel = MODE_LEVELS[MODE];
    attempt.deepestPassedLevel = deepestPassedLevel(attempt);
    attempt.finishedAt = new Date().toISOString();
    attempt.durationMs = Math.max(0, Date.now() - attemptStarted);
    attempt.failureFingerprint = phaseFailureFingerprint(attempt);
    attempts = [attempt]; overallResult = result.result; overallReason = result.reason;
  }
}

const runtime = {
  schema: 3,
  generatedAt: new Date().toISOString(),
  mode: MODE,
  selectedLevel: MODE_LEVELS[MODE],
  useDefconfig: true,
  roots: ROOTS,
  packageIntent: INTENT,
  requestedPackageCount: ROOTS.length,
  comparison: PAIRED_COMPARISON ? { mode: 'paired-exclusion', executionOrder: ['baseline', 'final'] } : null,
  pairedComparison: PAIRED_COMPARISON,
  environment: { source: SOURCE, branch: BRANCH, targetSystem: TARGET_SYSTEM, subtarget: SUBTARGET, target: TARGET, profile: PROFILE },
  attempts,
  conclusion: overallResult,
  reason: overallReason,
  durationMs: Math.max(0, Date.now() - runtimeStarted),
};
writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2) + '\n');
if (runtime.reason) log(`Probe reason / 探针原因: ${runtime.reason}`);
log(`Probe conclusion / 探针结论: ${runtime.conclusion}`);
process.exitCode = probeResultExitCode(attempts);
