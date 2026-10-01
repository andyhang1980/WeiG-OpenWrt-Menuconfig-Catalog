#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = readFileSync(resolve(ROOT, '.github', 'workflows', 'catalog.yml'), 'utf8');

for (const needle of [
  '- "catalog.config.json"',
  '- "compatibility.json"',
  '- "translations/menu-i18n.json"',
  '- "translations/zh-CN.json"',
  '- "translations/probe-ui.json"',
  '- "scripts/generate-catalog.mjs"',
  '- "scripts/build-index.mjs"',
  'node scripts/catalog-change-impact.mjs',
  "needs.mode.outputs.mode == 'full'",
  "needs.mode.outputs.mode == 'root-assets'",
]) {
  assert(catalog.includes(needle), `catalog runtime trigger/router contract missing: ${needle}`);
}
for (const forbidden of [
  '- "scripts/**"', '- "translations/**"', '- "*.json"', '- ".github/workflows/catalog.yml"',
  '!scripts/package-probe-*.mjs', '!scripts/run-package-probe.mjs', '!scripts/write-package-probe-evidence.mjs',
]) {
  assert(!catalog.includes(forbidden), `non-runtime Catalog trigger returned: ${forbidden}`);
}

const publishScript = resolve(ROOT, 'scripts', 'publish-release.sh');
const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_LOG"
if [[ "$1 $2" == "release view" ]]; then
  if [[ "\${GH_VIEW_MISSING:-0}" == 1 ]]; then
    echo "release not found" >&2
    exit 1
  fi
  exit 0
fi
if [[ "$1 $2" == "release upload" ]]; then
  count=0
  [[ ! -f "$GH_COUNT" ]] || count="$(cat "$GH_COUNT")"
  count=$((count + 1))
  printf '%s\\n' "$count" > "$GH_COUNT"
  if (( count <= \${GH_UPLOAD_FAILURES:-0} )); then
    echo "\${GH_UPLOAD_ERROR:-HTTP 500: simulated upload failure}" >&2
    exit 1
  fi
  exit 0
fi
exit 0
`;

function runScenario({
  viewMissing = false,
  uploadFailures = 0,
  uploadError = '',
  expectedStatus = 0,
  expectedUploads = 1,
}) {
  const dir = mkdtempSync(join(tmpdir(), 'weig-catalog-release-'));
  try {
    const bin = join(dir, 'bin');
    const dist = join(dir, 'dist');
    mkdirSync(bin);
    mkdirSync(dist);
    writeFileSync(join(dist, 'index.json'), '{}\n');
    writeFileSync(join(dist, 'a.json.gz'), 'a');
    writeFileSync(join(dist, 'b.translations.json'), '{}\n');
    const ghPath = join(bin, 'gh');
    writeFileSync(ghPath, fakeGh);
    chmodSync(ghPath, 0o755);
    const log = join(dir, 'gh.log');
    const count = join(dir, 'upload-count');
    const result = spawnSync('bash', [publishScript], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH || ''}`,
        GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
        GITHUB_RUN_ID: '12345',
        GITHUB_REPOSITORY: 'example/catalog',
        CATALOG_RELEASE_RETRY_MAX_ATTEMPTS: '4',
        CATALOG_RELEASE_RETRY_BASE_SECONDS: '0',
        GH_LOG: log,
        GH_COUNT: count,
        GH_VIEW_MISSING: viewMissing ? '1' : '0',
        GH_UPLOAD_FAILURES: String(uploadFailures),
        GH_UPLOAD_ERROR: uploadError,
      },
    });
    assert.equal(result.status, expectedStatus, [
      `unexpected publish status: ${result.status}`,
      result.stdout,
      result.stderr,
    ].join('\n'));
    const uploads = Number(readFileSync(count, 'utf8').trim() || '0');
    assert.equal(uploads, expectedUploads, 'unexpected release upload attempt count');
    const calls = readFileSync(log, 'utf8');
    return { calls, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rateLimited = runScenario({
  uploadFailures: 2,
  uploadError: 'HTTP 403: API rate limit exceeded for installation.',
  expectedStatus: 0,
  expectedUploads: 3,
});
assert.match(rateLimited.stderr, /GitHub rate limit detected; retrying/);

const genericFailure = runScenario({
  uploadFailures: 1,
  uploadError: 'HTTP 500: simulated upload failure',
  expectedStatus: 1,
  expectedUploads: 1,
});
assert.doesNotMatch(genericFailure.stderr, /GitHub rate limit detected; retrying/);

const missingRelease = runScenario({
  viewMissing: true,
  expectedStatus: 0,
  expectedUploads: 1,
});
assert.match(missingRelease.calls, /^release create menuconfig-catalog-complete /m);
assert.match(missingRelease.calls, /^release upload menuconfig-catalog-complete /m);

console.log('release publication checks passed: trigger exclusions, bounded rate-limit retry, hard failure, create/upload flow');
