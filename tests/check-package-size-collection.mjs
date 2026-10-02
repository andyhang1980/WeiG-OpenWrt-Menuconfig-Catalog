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
    .map(arch => `Target: board_${arch}/generic\nTarget-Arch-Packages: ${arch}\n`).join(''));
  const preload = join(temp, 'transport.mjs');
  // Exercise the real CLI and existing repository policy without network or
  // Docker. Modern releases try APK first and fall back to the OPKG index.
  writeFileSync(preload, `import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
let active = 0, maximum = 0;
globalThis.fetch = async url => {
  assert(!url.includes('/packages-24.10/absent/'));
  active++; maximum = Math.max(maximum, active);
  await new Promise(resolve => setTimeout(resolve, 2));
  active--;
  if (url.endsWith('/releases/')) return new Response('<a href="24.10.8/">release</a><a href="25.12.2/">other</a>');
  if (url.endsWith('/packages-24.10/')) return new Response(['a','b','c','d','e'].map(id => '<a href="arch_' + id + '/">arch</a>').join(''));
  if (url.endsWith('/') && /arch_[a-e]/.test(url)) return new Response('<a href="extra_feed/">extra</a>');
  if (url.endsWith('packages.adb')) return new Response('', { status: 404 });
  assert(!url.includes('/25.12.2/targets/'), 'release discovery must not borrow another branch');
  assert(url.endsWith('Packages.gz'));
  const target = url.includes('/targets/');
  return new Response(gzipSync(target
    ? 'Package: target-demo\\nVersion: 2-r3\\nSize: 12\\nInstalled-Size: 50\\n'
    : 'Package: demo\\nVersion: ' + (url.includes('/extra_feed/') ? '9-r1' : '2-r3') + '\\nSize: 12\\nInstalled-Size: 25\\n\\nPackage: ambiguous\\nVersion: 1-r1\\nInstalled-Size: ' + (url.includes('/extra_feed/') ? '30' : '20') + '\\n'));
};
process.on('beforeExit', () => assert(maximum > 1 && maximum <= 4, 'official downloads must use bounded concurrency'));
`);
  const bundle = join(temp, 'bundle.json');
  execFileSync(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'scripts/collect-curated-size-samples.mjs'),
    join(temp, 'observations'), '--source', 'OpenWrt', '--branch', 'openwrt-24.10',
    '--tree', join(temp, 'tree'), '--output-file', bundle], { stdio: 'pipe' });
  const result = JSON.parse(readFileSync(bundle, 'utf8'));
  assert.equal(result.schema, 3);
  const available = result.observations.filter(row => row.available);
  assert.equal(available.length, 6, 'target-native repositories can cover an architecture absent from common feeds');
  for (const observation of available) {
    const sample = JSON.parse(readFileSync(join(temp, observation.file), 'utf8'));
    assert.equal(sample.available, true);
    assert(sample.packages.some(row => row.version === '2-r3'));
    if (observation.architecture !== 'absent') {
      assert(sample.packages.some(row => row.name === 'demo' && row.version === '9-r1'), 'extra official feeds are discovered');
      assert(sample.packages.some(row => row.name === 'demo' && row.version === '2-r3'), 'another version must not shadow a native version');
      assert.equal(sample.packages.find(row => row.name === 'ambiguous').installedSize, null,
        'conflicting installed observations for the same package version must stay unknown');
    }
    assert(sample.packages.some(row => row.name === 'target-demo' && row.installedSize === 50));
    assert.equal(sample.architecture, observation.architecture);
  }
  // Every configured version family uses the same generic collector; sources
  // with no declared official repository explicitly remain unavailable.
  const policy = JSON.parse(readFileSync(join(root, 'catalog.config.json'), 'utf8'));
  for (const source of policy.sources.filter(row => !policy.curatedSizeSources.some(s => s.id === row.id))) {
    const missing = join(temp, `${source.id}-unavailable.json`);
    execFileSync(process.execPath, [join(root, 'scripts/collect-curated-size-samples.mjs'), join(temp, 'missing'),
      '--source', source.id, '--branch', 'master', '--tree', join(temp, 'tree'), '--output-file', missing], { stdio: 'pipe' });
    assert.equal(JSON.parse(readFileSync(missing, 'utf8')).reason, 'no-exact-official-index-source');
  }
  const familyTree = join(temp, 'family-tree');
  mkdirSync(join(familyTree, 'tmp'), { recursive: true });
  writeFileSync(join(familyTree, 'tmp', '.targetinfo'), 'Target: fixture/generic\nTarget-Arch-Packages: fixture_arch\n');
  const familyTransport = join(temp, 'families.mjs');
  writeFileSync(familyTransport, `import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
globalThis.fetch = async url => {
  const family = process.env.WEIG_SIZE_TEST_FAMILY;
  assert.equal(new URL(url).hostname, process.env.WEIG_SIZE_TEST_HOST, 'never borrow another source');
  if (url.endsWith('/releases/')) return new Response('<a href="' + family + '.1/">same</a><a href="99.99.1/">other</a>');
  assert(!url.includes('/99.99.1/'), 'never borrow another branch');
  if (url.endsWith('/')) return new Response(url.includes('fixture_arch') ? '<a href="extra/">feed</a>' : '<a href="fixture_arch/">architecture</a>');
  if (url.endsWith('packages.adb')) return new Response('', {status: 404});
  assert(url.endsWith('Packages.gz'));
  return new Response(gzipSync('Package: family-demo\\nVersion: 1-r1\\nInstalled-Size: 55\\nSize: 22\\n'));
};
`);
  const families = ['18.06', '19.07', '21.02', '22.03', '23.05', '24.10', '25.12', '26.01'];
  for (const [source, snapshot, host] of [
    ['OpenWrt', 'main', 'downloads.openwrt.org'],
    ['ImmortalWrt', 'master', 'downloads.immortalwrt.org'],
  ]) {
    for (const branch of [snapshot, ...families.map(version => `openwrt-${version}`)]) {
      const outputFile = join(temp, `family-${source}-${branch}.json`);
      // Archive fallbacks are tested above. Restrict the transport here to the
      // declared primary host to check generic branch and snapshot routing.
      const familyPolicy = { ...policy, curatedSizeSources: policy.curatedSizeSources.map(row =>
        ({ ...row, fallbackBaseUrls: [], releaseRoots: (row.releaseRoots || []).filter(url => new URL(url).hostname === host) })) };
      const configFile = join(temp, 'family-policy.json');
      writeFileSync(configFile, JSON.stringify(familyPolicy));
      execFileSync(process.execPath, ['--import', pathToFileURL(familyTransport).href,
        join(root, 'scripts/collect-curated-size-samples.mjs'), join(temp, 'family-observations'),
        '--config', configFile, '--source', source, '--branch', branch, '--tree', familyTree, '--output-file', outputFile],
      { stdio: 'pipe', env: { ...process.env, WEIG_SIZE_TEST_FAMILY: branch.replace('openwrt-', ''), WEIG_SIZE_TEST_HOST: host } });
      const coverage = JSON.parse(readFileSync(outputFile, 'utf8'));
      assert(coverage.observations.some(row => row.available && row.architecture === 'fixture_arch'), `${source}/${branch} coverage`);
    }
  }
  console.log('Official size collection: native targets, extra feeds, archives, bounded concurrency, APK fallback and version preservation passed.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
