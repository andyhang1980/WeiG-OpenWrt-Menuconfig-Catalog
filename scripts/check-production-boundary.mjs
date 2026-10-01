#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDataBranchForCodeRef,
  defaultReuseSourceForCodeRef,
  runtimeDataBranchForChannel,
  translationChannel,
  validatePromotionSource,
} from './catalog-channels.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = join(ROOT, '.github', 'workflows');
const workflows = new Map(readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .map((name) => [name, readFileSync(join(workflowDir, name), 'utf8')]));
const productionName = 'catalog-production.yml';
const production = workflows.get(productionName) || '';
const catalog = workflows.get('catalog.yml') || '';
const reuse = workflows.get('catalog-reuse.yml') || '';
const translation = workflows.get('translate.yml') || '';
const failures = [];
const channelContracts = [
  [buildDataBranchForCodeRef('main'), 'catalog-candidate', 'build main'],
  [buildDataBranchForCodeRef('dev'), 'catalog-dev', 'build dev'],
  [buildDataBranchForCodeRef('staging'), 'catalog-staging', 'build staging'],
  [buildDataBranchForCodeRef('fix-F'), 'catalog-fix-F', 'build fix F'],
  [buildDataBranchForCodeRef('fix-next.test'), 'catalog-fix-next.test', 'build generic fix'],
  [runtimeDataBranchForChannel('main'), 'catalog-main', 'runtime main'],
  [runtimeDataBranchForChannel('dev'), 'catalog-dev', 'runtime dev'],
  [runtimeDataBranchForChannel('staging'), 'catalog-staging', 'runtime staging'],
  [runtimeDataBranchForChannel('fix-F'), 'catalog-fix-F', 'runtime fix F'],
  [translationChannel('candidate')?.codeRef, 'main', 'translation candidate code'],
  [translationChannel('candidate')?.dataBranch, 'catalog-candidate', 'translation candidate data'],
  [translationChannel('fix-F')?.codeRef, 'fix-F', 'translation fix F code'],
  [translationChannel('fix-F')?.dataBranch, 'catalog-fix-F', 'translation fix F data'],
  [defaultReuseSourceForCodeRef('main')?.codeRef, 'staging', 'main default reuse source code'],
  [defaultReuseSourceForCodeRef('main')?.dataBranch, 'catalog-staging', 'main default reuse source data'],
  [validatePromotionSource('fix-F', 'catalog-dev').targetDataBranch, 'catalog-fix-F', 'seed fix F'],
  [validatePromotionSource('fix-F', 'catalog-fix-F').sourceCodeRef, 'fix-F', 'reuse fix F code'],
  [validatePromotionSource('fix-F', 'catalog-fix-F').targetDataBranch, 'catalog-fix-F', 'reuse fix F data'],
  [validatePromotionSource('fix-F1', 'catalog-fix-F').sourceCodeRef, 'fix-F', 'reuse sibling fix source code'],
  [validatePromotionSource('fix-F1', 'catalog-fix-F').sourceDataBranch, 'catalog-fix-F', 'reuse sibling fix source data'],
  [validatePromotionSource('fix-F1', 'catalog-fix-F').targetDataBranch, 'catalog-fix-F1', 'reuse sibling fix target data'],
  [validatePromotionSource('dev', 'catalog-fix-F').targetDataBranch, 'catalog-dev', 'promote fix F to dev'],
  [validatePromotionSource('staging', 'catalog-dev').targetDataBranch, 'catalog-staging', 'promote dev to staging'],
  [validatePromotionSource('main', 'catalog-staging').sourceCodeRef, 'staging', 'reuse staging source code for main'],
  [validatePromotionSource('main', 'catalog-staging').sourceDataBranch, 'catalog-staging', 'reuse staging source data for main'],
  [validatePromotionSource('main', 'catalog-staging').targetDataBranch, 'catalog-candidate', 'promote staging snapshot to candidate'],
];
for (const [actual, expected, label] of channelContracts) {
  if (actual !== expected) failures.push(`${label}: ${actual || '(empty)'} != ${expected}`);
}
for (const invalid of [
  () => validatePromotionSource('dev', 'catalog-staging'),
  () => validatePromotionSource('staging', 'catalog-fix-F'),
  () => validatePromotionSource('main', 'catalog-dev'),
  () => validatePromotionSource('main', 'catalog-main'),
  () => validatePromotionSource('fix-F', 'catalog-staging'),
  () => validatePromotionSource('fix-F', 'catalog-candidate'),
]) {
  try { invalid(); failures.push('invalid Catalog promotion edge was accepted'); } catch {}
}

const requireText = (text, needle, label) => { if (!text.includes(needle)) failures.push(label); };
const forbidText = (text, needle, label) => { if (text.includes(needle)) failures.push(label); };

requireText(production, 'workflow_dispatch:', 'production must be manual');
forbidText(production, 'schedule:', 'production must not be scheduled');
forbidText(production, 'push:', 'production must not run on push');
requireText(production, "if: github.ref_name == 'main'", 'production must be pinned to main code');
requireText(production, 'group: catalog-write-catalog-main', 'production must own the catalog-main writer lock');
requireText(production, 'scripts/verify-production-candidate.mjs', 'production must verify candidate provenance');
requireText(production, 'catalog-candidate moved: expected $EXPECTED_CANDIDATE_SHA, got $candidate_sha',
  'production must reject a candidate that moved after manual selection');
requireText(production, 'git clone --depth 1 --single-branch --branch catalog-candidate',
  'production candidate fetch must be shallow and pinned to the candidate branch');
forbidText(production, 'git clone --single-branch --branch catalog-candidate',
  'production must not regress to an unbounded candidate clone');
requireText(production, 'git -C candidate fetch --no-tags --depth=1 origin "$asset_ref"',
  'production must fetch the immutable assetRef even when it lives on an isolated data history');
requireText(production, 'git -C candidate cat-file -e "${asset_ref}^{commit}"',
  'production must verify that the immutable assetRef commit exists');
forbidText(production, 'merge-base --is-ancestor "$asset_ref"',
  'production must not require cross-lane assetRef ancestry after snapshot copies');
requireText(production, 'HEAD:catalog-main', 'production must be the catalog-main writer');
requireText(production, 'scripts/publish-release.sh', 'production must own the complete Release alias');
forbidText(production, 'catalog-data', 'production workflow must not retain the retired catalog-data name');

for (const [name, text] of workflows) {
  if (/^\s*queue\s*:/m.test(text)) failures.push(`${name} contains unsupported concurrency queue syntax`);
  if (name !== productionName && /HEAD:catalog-main|HEAD:\$\{?[^\n]*catalog-main/.test(text)) {
    failures.push(`${name} writes catalog-main outside Production Gate`);
  }
  if (name !== productionName && text.includes('scripts/publish-release.sh')) {
    failures.push(`${name} publishes the complete Release outside Production Gate`);
  }
  if (text.includes('catalog-data')) failures.push(`${name} still references retired catalog-data`);
}

requireText(catalog, 'scripts/catalog-channels.mjs build', 'catalog build must use centralized channel mapping');
requireText(catalog, 'scripts/catalog-channels.mjs validate-non-production', 'catalog writers must use centralized non-production guard');
requireText(catalog, 'steps:\n      - uses: actions/checkout@v7\n      - name: Validate non-production publish channel',
  'Catalog publish must checkout code before invoking channel validation scripts');
forbidText(catalog, 'catalog-fix-[ABC]', 'Catalog workflow must not hard-code A/B/C lanes');
forbidText(catalog, 'catalog-fix-E', 'Catalog workflow must not hard-code E lane');
forbidText(catalog, '- "scripts/**"', 'Catalog heavy push must not watch every script');
forbidText(catalog, '- ".github/workflows/catalog.yml"', 'Catalog heavy push must not self-trigger');
forbidText(catalog, 'Publish complete catalog Release', 'catalog build must not publish production Release');

requireText(reuse, 'branches: [main, dev, staging, "fix-*"]', 'reuse workflow must cover canonical fix/dev/staging/main');
requireText(reuse, 'scripts/catalog-channels.mjs validate-promotion', 'reuse workflow must validate promotion edges centrally');
requireText(reuse, 'scripts/catalog-change-impact.mjs', 'reuse workflow must gate on data impact');
requireText(reuse, 'source_data_branch="$target_data_branch"', 'fix reuse must prefer its existing isolated runtime snapshot');
requireText(reuse, 'refs/heads/$target_data_branch', 'fix reuse must verify the isolated runtime branch exists before self-reuse');
requireText(reuse, 'scripts/catalog-channels.mjs default-reuse-source',
  'a missing configured marker branch must fall back to the canonical predecessor');
requireText(catalog, 'scripts/catalog-channels.mjs default-reuse-source',
  'fast root-asset publication must recover from a deleted configured marker branch');
requireText(reuse, 'EXPECTED_ASSET_REF', 'reuse workflow must pin immutable asset identity');

requireText(translation, 'default: candidate', 'translation default must be candidate');
requireText(translation, 'options: [candidate, dev, staging]', 'translation channels must be bounded');
requireText(translation, 'scripts/catalog-channels.mjs translation', 'translation must use centralized channel mapping');
forbidText(translation, 'catalog-main', 'translation must not write or select production data');
forbidText(translation, 'data_channel:', 'translation must not expose a free data-channel selector');
forbidText(translation, 'code_channel:', 'translation must not expose a free code-channel selector');

if (workflows.has('curated-sizes.yml')) failures.push('retired cross-sample size automation returned');

const scan = [
  ...[...workflows].map(([name, text]) => [`.github/workflows/${name}`, text]),
  ...readdirSync(join(ROOT, 'scripts')).filter((name) => /\.(?:mjs|sh|py)$/.test(name) && !name.startsWith('check-') && name !== 'check.mjs')
    .map((name) => [`scripts/${name}`, readFileSync(join(ROOT, 'scripts', name), 'utf8')]),
];
for (const [name, text] of scan) {
  if (/git\s+(?:-C\s+\S+\s+)?push[^\n]*(?:--force|-f\b)/.test(text)) failures.push(`${name} contains a force push`);
}

const productionWriters = [...workflows].filter(([, text]) => text.includes('HEAD:catalog-main')).map(([name]) => name);
if (productionWriters.join(',') !== productionName) failures.push(`catalog-main writer set is ${productionWriters.join(',') || '(none)'}`);

if (failures.length) throw new Error(`production boundary check failed:\n- ${failures.join('\n- ')}`);
console.log(`production boundary checks passed: writer=${productionName}, workflows=${workflows.size}`);
