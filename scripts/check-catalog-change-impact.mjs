#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertPromotionPushReusesSnapshot,
  catalogChangeImpact,
  catalogImpactRegistryCoverage,
  catalogPromotionImpact,
  classifyCatalogPath,
  isPromotionOnlyPush,
} from './catalog-change-impact.mjs';
import { configuredReuseSourceForCodeRef, pushBeforeSha } from './catalog-channels.mjs';

assert.equal(classifyCatalogPath('.github/workflows/catalog.yml'), 'none');
assert.equal(classifyCatalogPath('.github/workflows/catalog-reuse.yml'), 'none');
assert.equal(classifyCatalogPath('.github/workflows/catalog-production.yml'), 'none');
assert.equal(classifyCatalogPath('scripts/package-probe-controller.mjs'), 'none');
assert.equal(classifyCatalogPath('scripts/run-boot-smoke.sh'), 'none', 'retired managed paths must remain classifiable during deletion');
assert.equal(classifyCatalogPath('scripts/install-probe-dependencies.sh'), 'none');
assert.equal(classifyCatalogPath('scripts/install-probe-feeds.sh'), 'full');
assert.equal(classifyCatalogPath('scripts/setup-probe-runtime.sh'), 'none');
assert.equal(classifyCatalogPath('translations/probe-ui.json'), 'applications');
assert.equal(classifyCatalogPath('compatibility.json'), 'compatibility');
assert.equal(classifyCatalogPath('scripts/generate-catalog.mjs'), 'full');
assert.equal(classifyCatalogPath('scripts/build-index.mjs'), 'full');
assert.equal(classifyCatalogPath('scripts/generate-profile-config-groups.mjs'), 'full');
assert.equal(classifyCatalogPath('scripts/profile-config-contract.mjs'), 'full');
assert.equal(classifyCatalogPath('scripts/catalog-change-impact.mjs'), 'none');
assert.equal(classifyCatalogPath('scripts/stamp-catalog-snapshot.mjs'), 'none');
assert.equal(classifyCatalogPath('scripts/check-profile-config-groups.mjs'), 'none');
assert.equal(classifyCatalogPath('scripts/benchmark-profile-config-groups.mjs'), 'none');
assert.equal(classifyCatalogPath('docs/COMPATIBILITY.md'), 'none');

assert.equal(pushBeforeSha({ before: 'A'.repeat(40) }), 'a'.repeat(40));
assert.equal(pushBeforeSha({ before: '0'.repeat(40) }), '');
assert.equal(pushBeforeSha({ before: 'bad' }), '');

const markerlessCwd = mkdtempSync(join(tmpdir(), 'catalog-change-impact-markerless-'));
const markedCwd = mkdtempSync(join(tmpdir(), 'catalog-change-impact-marked-'));
try {
  assert.deepEqual(configuredReuseSourceForCodeRef('dev', { cwd: markerlessCwd }), {
    codeRef: 'dev', dataBranch: 'catalog-dev',
  }, 'dev promotion must use the canonical catalog-dev fallback when no explicit reuse marker exists');
  writeFileSync(join(markedCwd, '.catalog-reuse-source'), 'catalog-fix-change-impact-marker\n');
  assert.deepEqual(configuredReuseSourceForCodeRef('dev', { cwd: markedCwd }), {
    codeRef: 'fix-change-impact-marker', dataBranch: 'catalog-fix-change-impact-marker',
  }, 'dev promotion must honor a valid explicit reuse marker');
} finally {
  rmSync(markerlessCwd, { recursive: true, force: true });
  rmSync(markedCwd, { recursive: true, force: true });
}
assert.deepEqual(configuredReuseSourceForCodeRef('staging'), {
  codeRef: 'dev', dataBranch: 'catalog-dev',
}, 'staging promotion must preserve the canonical catalog-dev predecessor');
assert.deepEqual(configuredReuseSourceForCodeRef('main'), {
  codeRef: 'staging', dataBranch: 'catalog-staging',
}, 'main promotion must inherit the validated catalog-staging snapshot into catalog-candidate');

for (const ref of ['dev', 'staging', 'main']) {
  assert.equal(isPromotionOnlyPush(ref, 'push'), true, `${ref} push must be promotion-only`);
  assert.equal(assertPromotionPushReusesSnapshot({
    eventName: 'push',
    codeRef: ref,
    source: { codeRef: ref === 'dev' ? 'dev' : ref === 'staging' ? 'dev' : 'staging', dataBranch: 'catalog-source' },
    snapshotImpact: { mode: 'none' },
  }), true, `${ref} promotion must accept an unchanged validated snapshot`);
  assert.throws(() => assertPromotionPushReusesSnapshot({
    eventName: 'push',
    codeRef: ref,
    source: { codeRef: 'source', dataBranch: 'catalog-source' },
    snapshotImpact: { mode: 'full' },
  }), /cannot start heavy generation/, `${ref} promotion must fail closed instead of falling back to heavy generation`);
  assert.throws(() => assertPromotionPushReusesSnapshot({
    eventName: 'push',
    codeRef: ref,
    snapshotImpact: { mode: 'none' },
  }), /requires a validated predecessor snapshot/, `${ref} promotion must fail when no predecessor snapshot is proven`);
}
assert.equal(isPromotionOnlyPush('fix-F', 'push'), false, 'fix lanes may generate new runtime data when necessary');
assert.equal(isPromotionOnlyPush('main', 'schedule'), false, 'scheduled upstream refresh is not a code-promotion push');
assert.equal(isPromotionOnlyPush('main', 'workflow_dispatch'), false, 'explicit manual generation is not a code-promotion push');

assert.deepEqual(catalogChangeImpact([
  'scripts/package-probe-controller.mjs',
  'scripts/check-package-probe.mjs',
]), { mode: 'none', fastAssets: [], classified: [
  { path: 'scripts/package-probe-controller.mjs', impact: 'none' },
  { path: 'scripts/check-package-probe.mjs', impact: 'none' },
] });
assert.equal(catalogChangeImpact([
  '.github/workflows/catalog.yml',
  'scripts/catalog-change-impact.mjs',
]).mode, 'none');
assert.equal(catalogChangeImpact([
  'scripts/generate-profile-config-groups.mjs',
  'scripts/check-profile-config-groups.mjs',
]).mode, 'full');
assert.equal(catalogChangeImpact([
  'scripts/profile-config-contract.mjs',
]).mode, 'full');
assert.equal(catalogChangeImpact([
  'scripts/stamp-catalog-snapshot.mjs',
  'scripts/check-catalog-snapshot.mjs',
]).mode, 'none');
assert.equal(catalogChangeImpact([
  'scripts/build-index.mjs',
]).mode, 'full');

const pushFull = catalogChangeImpact(['scripts/profile-config-contract.mjs']);
const snapshotSame = catalogChangeImpact([]);
const promoted = catalogPromotionImpact(pushFull, snapshotSame, {
  dataBranch: 'catalog-fix-F', baseSha: 'a'.repeat(40),
});
assert.equal(promoted.mode, 'none', 'matching snapshot Data Surface must suppress duplicate heavy generation');
assert.equal(promoted.reuseSource, 'catalog-fix-F');
assert.equal(promoted.snapshotBaseSha, 'a'.repeat(40));
assert.equal(catalogPromotionImpact(pushFull,
  catalogChangeImpact(['scripts/profile-config-contract.mjs'])).mode, 'full',
'changed snapshot Data Surface must keep full generation enabled outside promotion-only pushes');

assert.deepEqual(catalogChangeImpact([
  'translations/probe-ui.json',
  'curated-sizes.json',
]).fastAssets, ['applications']);
assert.deepEqual(catalogChangeImpact([
  'translations/probe-ui.json',
  'compatibility.json',
]), { mode: 'root-assets', fastAssets: ['applications', 'compatibility'], classified: [
  { path: 'translations/probe-ui.json', impact: 'applications' },
  { path: 'compatibility.json', impact: 'compatibility' },
] });
assert.equal(catalogChangeImpact([
  'translations/probe-ui.json',
  'scripts/generate-catalog.mjs',
]).mode, 'full');

assert.throws(() => classifyCatalogPath('scripts/new-catalog-output.mjs'), /Unclassified Catalog-impact file/);
assert.throws(() => classifyCatalogPath('translations/new-runtime-ui.json'), /Unclassified Catalog-impact file/);

const impactScript = readFileSync(resolve('scripts/catalog-change-impact.mjs'), 'utf8');
assert(impactScript.includes('const remoteHead = `refs/heads/${dataBranch}`;'),
  'remote snapshot reads must address the source branch without updating a local tracking ref');
assert(impactScript.includes("'fetch', '--no-tags', '--depth=1', '--refmap=', 'origin', remoteHead"),
  'remote snapshot reads must stay shallow and disable remote-tracking ref updates');
assert(impactScript.includes("gitText(['show', 'FETCH_HEAD:index.json']"),
  'remote snapshot reads must inspect the freshly fetched snapshot through FETCH_HEAD');
assert(!impactScript.includes('refs/remotes/origin/${dataBranch}'),
  'remote snapshot reads must not race on shallow origin/catalog-* tracking refs');

const catalogWorkflow = readFileSync(resolve('.github/workflows/catalog.yml'), 'utf8');
assert.match(catalogWorkflow, /push:\s*\n\s*branches: \["fix-\*"\]/,
  'automatic Menuconfig Catalog generation must only run on fix-* source-lane pushes');
for (const promotionRef of ['dev', 'staging', 'main']) {
  assert(!catalogWorkflow.includes(`branches: [${promotionRef}`),
    `${promotionRef} must not be an automatic Menuconfig Catalog generation branch`);
}
assert.match(catalogWorkflow, /impact_base_ref:/,
  'manual source-lane rebuilds must expose an explicit impact base ref');
assert.match(catalogWorkflow, /impact_base_ref is only allowed on fix-\* source lanes/,
  'manual impact-base classification must be restricted to fix-* source lanes');
assert.match(catalogWorkflow, /GIT_NO_LAZY_FETCH=1 git cat-file -e "\$IMPACT_BASE_REF\^\{commit\}"/,
  'manual impact-base checks must not materialize a disconnected promisor commit');
assert.match(catalogWorkflow, /git fetch --no-tags --filter=blob:none --depth="\$depth" origin/,
  'manual impact-base ancestry checks must fetch bounded blobless source-lane history');
assert(!catalogWorkflow.includes('--unshallow'),
  'manual impact-base ancestry checks must not fetch the complete Catalog history');
assert.match(catalogWorkflow, /git merge-base "\$GITHUB_SHA" origin\/dev/,
  'new fix-* branch pushes must classify against their dev merge-base instead of defaulting to full');
assert(!catalogWorkflow.includes('- "scripts/**"'), 'Menuconfig Catalog push must not watch every script');
assert(!catalogWorkflow.includes('- ".github/workflows/catalog.yml"'), 'Menuconfig Catalog push must not self-trigger on control changes');
assert.match(catalogWorkflow, /node scripts\/catalog-change-impact\.mjs/, 'heavy workflow must pass through the promotion-aware Data Surface gate');
assert.match(catalogWorkflow, /needs\.mode\.outputs\.mode == 'full'/, 'heavy discover/generate jobs must require explicit full mode');
for (const required of [
  'scripts/generate-catalog.mjs', 'scripts/generate-profile-config-groups.mjs',
  'scripts/profile-config-contract.mjs', 'scripts/build-index.mjs', 'catalog.config.json',
  'translations/menu-i18n.json', 'translations/zh-CN.json', 'compatibility.json',
  'scripts/curated-sizes.mjs', 'scripts/collect-curated-size-samples.mjs',
]) {
  assert(catalogWorkflow.includes(`- "${required}"`), `Catalog runtime input missing from push.paths: ${required}`);
}

const reuseWorkflow = readFileSync(resolve('.github/workflows/catalog-reuse.yml'), 'utf8');
assert.match(reuseWorkflow, /push:\s*\n\s*branches: \[main, dev, staging, "fix-\*"\]/,
  'snapshot reuse must remain enabled on dev/staging/main and fix-* promotion lanes');
assert.match(reuseWorkflow, /node scripts\/catalog-change-impact\.mjs/, 'snapshot reuse must use the same promotion-aware Data Surface gate');
assert.match(reuseWorkflow, /needs\.preflight\.outputs\.reuse == 'true'/, 'snapshot promotion must require verified reusable identity');
assert.match(reuseWorkflow, /filter: blob:none/, 'snapshot reuse checkout must not download historical Catalog asset blobs');
assert.match(reuseWorkflow, /GIT_NO_LAZY_FETCH=1 git cat-file -e "\$base_sha\^\{commit\}"/,
  'snapshot reuse must not materialize a disconnected promisor commit');
assert.match(reuseWorkflow, /git fetch --no-tags --filter=blob:none --depth="\$depth" origin/,
  'snapshot reuse ancestry recovery must remain bounded and blobless');
assert(!reuseWorkflow.includes('--unshallow'),
  'snapshot reuse must not fetch the complete Catalog history');
assert.match(reuseWorkflow, /for depth in 32 128 512; do\s+git fetch --no-tags --filter=blob:none --depth="\$depth" origin \\\s+"\+refs\/heads\/\$GITHUB_REF_NAME:refs\/remotes\/origin\/\$GITHUB_REF_NAME" \\\s+"\+refs\/heads\/dev:refs\/remotes\/origin\/dev"/,
  'new fix-* reuse pushes must fetch bounded current-fix and origin/dev lineages');
assert.match(reuseWorkflow, /base_sha="\$\(git merge-base "\$GITHUB_SHA" origin\/dev 2>\/dev\/null \|\| true\)"/,
  'merge-base lookup must remain non-fatal under set -e while the bounded fallback retries');
assert.match(reuseWorkflow, /\[\[ "\$base_sha" =~ \^\[0-9a-f\]\{40\}\$ \]\] \|\| \{\s+echo "Unable to determine the merge-base/,
  'an unresolved merge-base must fail closed instead of bypassing the impact guard');
assert.match(reuseWorkflow, /mapfile -t changed < <\(git diff --name-only "\$base_sha" "\$GITHUB_SHA"\)/,
  'reuse impact must classify the merge-base-to-target delta after before fallback');
assert.match(reuseWorkflow, /\[\[ "\$\(sed -n 's\/\^mode=\/\/p' "\$RUNNER_TEMP\/catalog-reuse-impact\.outputs"\)" == none \]\]/,
  'cumulative reuse verification must remain fail-closed for root-assets/full impact');

const coverage = catalogImpactRegistryCoverage();
assert.deepEqual(coverage.missing, []);
assert.deepEqual(coverage.stale, []);
console.log(`Catalog zero-heavy promotion and change impact checks passed (${coverage.managed.length} managed files).`);
