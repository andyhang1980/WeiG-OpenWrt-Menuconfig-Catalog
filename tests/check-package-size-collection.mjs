import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseApkDump, parseOpkgPackages } from '../scripts/curated-sizes.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
assert.equal(parseOpkgPackages('Package: demo\nVersion: 2-r3\nSize: 12\nInstalled-Size: 25\n')[0].version, '2-r3');
assert.equal(parseApkDump({ packages: [{ info: { name: 'demo', version: '2-r3', file_size: 12, installed_size: 25 } }] })[0].version, '2-r3');
const temp = mkdtempSync(join(tmpdir(), 'weig-official-size-test-'));
try {
  mkdirSync(join(temp, 'tree', 'tmp'), { recursive: true });
  writeFileSync(join(temp, 'tree', 'tmp', '.targetinfo'), ['arch_a', 'arch_b', 'arch_c', 'arch_d', 'arch_e', 'absent']
    .map(arch => `Target-Arch-Packages: ${arch}\n`).join(''));
  const preload = join(temp, 'transport.mjs');
  // Exercise the real CLI and existing repository policy without network or
  // Docker. Modern releases try APK first and fall back to the OPKG index.
  writeFileSync(preload, `import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
let active = 0, maximum = 0;
globalThis.fetch = async url => {
  assert(!url.includes('/absent/'));
  active++; maximum = Math.max(maximum, active);
  await new Promise(resolve => setTimeout(resolve, 2));
  active--;
  if (url.endsWith('/packages-24.10/')) return new Response(['a','b','c','d','e'].map(id => '<a href="arch_' + id + '/">arch</a>').join(''));
  if (url.endsWith('packages.adb')) return new Response('', { status: 404 });
  assert.match(url, /packages-24\\.10\\/arch_[a-e]\\/[^/]+\\/Packages\\.gz$/);
  return new Response(gzipSync('Package: demo\\nVersion: 2-r3\\nSize: 12\\nInstalled-Size: 25\\n'));
};
process.on('beforeExit', () => assert(maximum > 1 && maximum <= 4, 'official downloads must use bounded concurrency'));
`);
  const bundle = join(temp, 'bundle.json');
  execFileSync(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'scripts/collect-curated-size-samples.mjs'),
    join(temp, 'observations'), '--source', 'OpenWrt', '--branch', 'openwrt-24.10',
    '--tree', join(temp, 'tree'), '--output-file', bundle], { stdio: 'pipe' });
  const result = JSON.parse(readFileSync(bundle, 'utf8'));
  assert.equal(result.schema, 3);
  assert.equal(result.observations.length, 5);
  for (const observation of result.observations) {
    const sample = JSON.parse(readFileSync(join(temp, observation.file), 'utf8'));
    assert.equal(sample.available, true);
    assert.equal(sample.packages[0].version, '2-r3');
    assert.equal(sample.packages[0].installedSize, 25);
    assert.equal(sample.architecture, observation.architecture);
  }
  console.log('Official size collection: native architectures, bounded concurrency, APK fallback, package versions passed.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
