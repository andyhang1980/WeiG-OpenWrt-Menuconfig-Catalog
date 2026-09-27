#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { safeSlug } from './lib.mjs';

const required = ['SOURCE_ID', 'SOURCE_LABEL', 'SOURCE_REPO', 'SOURCE_BRANCH', 'RUN_URL'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`缺少 ${name}`);
}
const prior = process.env.PREVIOUS_ATTEMPT_FILE && existsSync(process.env.PREVIOUS_ATTEMPT_FILE)
  ? JSON.parse(readFileSync(process.env.PREVIOUS_ATTEMPT_FILE, 'utf8')) : null;
const currentSteps = [
  ['tools', process.env.TOOLS_OUTCOME],
  ['clone', process.env.CLONE_OUTCOME],
  ['feeds', process.env.FEEDS_OUTCOME],
  ['metadata', process.env.METADATA_OUTCOME],
  ['extract', process.env.EXTRACT_OUTCOME],
  ['kconfig-contract', process.env.KCONFIG_CONTRACT_OUTCOME],
  ['profile-plan', process.env.PROFILE_PLAN_OUTCOME],
  ['profile-config-groups', process.env.PROFILE_INLINE_OUTCOME],
  ['native-input-pack', process.env.PROFILE_PACK_OUTCOME],
];
const outcomes = { ...(prior?.outcomes || {}) };
for (const [stage, outcome] of currentSteps) if (outcome) outcomes[stage] = outcome;
const steps = Object.entries(outcomes);
if (process.env.EXPERIMENT_STAGE && process.env.EXPERIMENT_OUTCOME) {
  steps.push([process.env.EXPERIMENT_STAGE, process.env.EXPERIMENT_OUTCOME]);
}
const failed = steps.find(([, outcome]) => outcome && outcome !== 'success' && outcome !== 'skipped');
const status = process.env.JOB_STATUS === 'success' ? 'success' : 'failure';
const outDir = resolve(process.env.ATTEMPT_DIR || 'attempts');
const jobKey = process.env.CATALOG_JOB_KEY ||
  `${safeSlug(process.env.SOURCE_ID)}--${safeSlug(process.env.SOURCE_BRANCH)}`;
const artifactName = process.env.CATALOG_ARTIFACT_NAME || `catalog-${jobKey}`;
const orderText = process.env.CATALOG_ORDER || '00';
const filePrefix = `${orderText}-${jobKey}`;
let upstreamCommit = prior?.upstreamCommit || '';
try {
  upstreamCommit = execFileSync('git', ['-C', resolve('work/upstream'), 'rev-parse', 'HEAD'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch { /* clone may have failed before a commit existed */ }
const attempt = {
  schema: 2,
  source: {
    id: process.env.SOURCE_ID,
    label: process.env.SOURCE_LABEL,
    repo: process.env.SOURCE_REPO,
    legacy: process.env.SOURCE_LEGACY === 'true',
  },
  branch: process.env.SOURCE_BRANCH,
  version: process.env.SOURCE_VERSION ||
    process.env.SOURCE_BRANCH.replace(/^openwrt-/, ''),
  upstreamCommit,
  compatibilityMode: process.env.METADATA_COMPAT || 'native',
  status,
  stage: status === 'success' ? 'complete' : (failed?.[0] || 'unknown'),
  outcomes: Object.fromEntries(steps),
  feedFailure: process.env.FEEDS_FAILURE_REASON ? {
    reason: process.env.FEEDS_FAILURE_REASON,
    class: process.env.FEEDS_FAILURE_CLASS || 'feed-fetch-infrastructure',
    feed: process.env.FEEDS_FAILURE_FEED || '',
  } : (prior?.feedFailure || null),
  attemptedAt: new Date().toISOString(),
  runUrl: process.env.RUN_URL,
  run: {
    id: process.env.RUN_ID || '',
    attempt: process.env.RUN_ATTEMPT || '',
    jobIndex: process.env.JOB_INDEX || '',
  },
  order: Number.parseInt(orderText, 10) || 0,
  orderText,
  jobName: process.env.CATALOG_JOB_NAME || '',
  artifactName,
};
attempt.failureLog = status === 'failure' ? `${filePrefix}--${attempt.stage}.log` : '';
mkdirSync(outDir, { recursive: true });
const name = `${filePrefix}.attempt.json`;
writeFileSync(resolve(outDir, name), JSON.stringify(attempt, null, 2) + '\n');
const failureLog = attempt.failureLog || '-';
const summary = [
  'WeiG Menuconfig Catalog branch summary',
  `Source ID: ${attempt.source.id}`,
  `Source label: ${attempt.source.label}`,
  `Repository: ${attempt.source.repo}`,
  `Branch: ${attempt.branch}`,
  `Version: ${attempt.version}`,
  `Upstream commit: ${attempt.upstreamCommit || 'unavailable'}`,
  `Compatibility mode: ${attempt.compatibilityMode}`,
  `Final status: ${attempt.status}`,
  `Failed stage: ${attempt.status === 'failure' ? attempt.stage : '-'}`,
  `Feed failure: ${attempt.feedFailure ? `${attempt.feedFailure.class} / ${attempt.feedFailure.reason} / ${attempt.feedFailure.feed || '-'}` : '-'}`,
  `Failure log: ${failureLog}`,
  `Artifact: ${attempt.artifactName}`,
  `Run ID: ${attempt.run.id}`,
  `Run attempt: ${attempt.run.attempt}`,
  `Job number: ${attempt.orderText}`,
  `Job name: ${attempt.jobName}`,
  `Job index: ${attempt.run.jobIndex}`,
  `Run URL: ${attempt.runUrl}`,
  `Attempted UTC: ${attempt.attemptedAt}`,
  '',
  'Stage outcomes:',
  ...steps.map(([stage, outcome]) => `- ${stage}: ${outcome || 'not-run'}`),
  '',
].join('\n');
writeFileSync(resolve(outDir, `${filePrefix}--SUMMARY.txt`), summary);
console.log(`${attempt.source.id}/${attempt.branch}: ${attempt.status} @ ${attempt.stage}`);
