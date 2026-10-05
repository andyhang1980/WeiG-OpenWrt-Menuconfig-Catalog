import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parsePackageInfo, nativePackageInstallationContract } from '../scripts/lib.mjs';
import { buildKconfigRelations, derivePackageDependencyClosure } from '../scripts/kconfig-relations.mjs';
import { expandCompactRelations } from '../scripts/compact-relations.mjs';
import { gunzipSync } from 'node:zlib';
import { compactRelations, compareRelationSemantics } from '../scripts/compact-relations.mjs';
import { instrumentInstallationMetadata } from '../scripts/native-installation-metadata.mjs';

const runtimeTree = mkdtempSync(join(tmpdir(), 'catalog-native-runtime-'));
try {
  mkdirSync(join(runtimeTree, 'include'));
  const nativeDump = process.env.KCONFIG_NATIVE_TEST_TREE &&
    join(resolve(process.env.KCONFIG_NATIVE_TEST_TREE), 'include/package-dumpinfo.mk');
  const dump = nativeDump ? readFileSync(nativeDump, 'utf8') : [
    'define Dumpinfo/Package', '$(info Package: $(1)',
    'Depends: $(call PKG_FIXUP_DEPENDS,$(1),$(DEPENDS))', 'ABI-Version: $(ABI_VERSION)', ')', 'endef', '',
  ].join('\n');
  const dumpFile = join(runtimeTree, 'include/package-dumpinfo.mk');
  writeFileSync(dumpFile, dump);
  assert.equal(instrumentInstallationMetadata(runtimeTree).status, 'installed');
  const instrumented = readFileSync(dumpFile, 'utf8');
  assert.equal(instrumentInstallationMetadata(runtimeTree).status, 'present');
  assert.equal(readFileSync(dumpFile, 'utf8'), instrumented, 'instrumentation must be idempotent');
  const makeCommand = process.env.WEIG_MAKE || 'make';
  const makeAvailable = spawnSync(makeCommand, ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
  if (makeAvailable) {
    const source = [
      instrumented, 'PKG_FIXUP_DEPENDS = $(2)', 'CONFIG_EXTRA:=y', 'BASE:=daemon',
      'define Package/Default', 'DEPENDS:=+libc', 'EXTRA_DEPENDS:=', 'endef',
      'define Package/interface', 'EXTRA_DEPENDS:=$(BASE), $(if $(CONFIG_EXTRA),admin,other)', 'endef',
      'define BuildPackage', '$(eval $(Package/Default))', '$(eval $(Package/$(1)))', '$(Dumpinfo/Package)', 'endef',
      '$(eval $(call BuildPackage,interface))', '$(eval $(call BuildPackage,backend))',
      'FORCE: ;', '__metadata_only: ;', '',
    ].join('\n');
    const output = execFileSync(makeCommand, ['--no-print-directory', '-rR', 'DUMP=1', '-f', '-', '__metadata_only'],
      { input: source, encoding: 'utf8', env: { ...process.env, MAKEFLAGS: '', MFLAGS: '', GNUMAKEFLAGS: '' } });
    const rows = parsePackageInfo(output);
    assert.equal(rows[0].extraDepends, 'daemon, admin', 'native Make must resolve computed and conditional names');
    assert.equal(rows[1].extraDepends, '', 'Package/Default must reset EXTRA_DEPENDS between packages');
    assert.deepEqual(rows[0].depends, ['+libc'], 'runtime instrumentation must not change Kconfig Depends');
    const graph = buildKconfigRelations([], [...rows,
      { name: 'daemon', depends: [], provides: [], conflicts: [] },
      { name: 'admin', depends: [], provides: [], conflicts: [] }], []);
    const runtime = graph.records.find(row => row.package === 'interface').packageInfo.installation.runtime;
    assert.deepEqual(runtime.dependencies.map(row => row.packages[0]), ['daemon', 'admin']);
    const expanded = expandCompactRelations(compactRelations(graph));
    assert(compareRelationSemantics(graph, expanded).equal, 'runtime facts must survive the existing codec');
    assert.deepEqual(expanded.records.find(row => row.package === 'interface').packageInfo.installation.runtime, runtime);
    assert.equal(graph.records.find(row => row.package === 'backend').packageInfo.installation, undefined);
    const closure = derivePackageDependencyClosure([...rows,
      { name: 'daemon', depends: [], provides: [] }, { name: 'admin', depends: [], provides: [] },
      { name: 'libc', depends: [], provides: [] }], ['interface'], ['admin'],
      { installedPackages: new Set(['interface', 'admin', 'daemon']), selectedPackages: new Set(['interface']) });
    assert.equal(closure.result, 'reachable', 'Probe must follow the same native runtime fact');
    assert.equal(derivePackageDependencyClosure(rows, ['interface'], ['admin'],
      { installedPackages: new Set() }).paths.length, 0, 'compile-only roots must not imply runtime installation');
  } else assert(process.platform === 'win32' && !process.env.CI, 'native runtime oracle requires Make in CI');
  writeFileSync(dumpFile, 'define DifferentDump\nendef\n');
  assert.equal(instrumentInstallationMetadata(runtimeTree).status, 'unsupported');
  assert.equal(readFileSync(dumpFile, 'utf8'), 'define DifferentDump\nendef\n');
} finally { rmSync(runtimeTree, { recursive: true, force: true }); }

const packagingTree = mkdtempSync(join(tmpdir(), 'catalog-packaging-contract-'));
try {
  mkdirSync(join(packagingTree, 'include'));
  assert.equal(nativePackageInstallationContract(packagingTree), null, 'legacy trees must not assert APK semantics');
  const packFunctions = [
    'define AddProvide',
    '$(strip $(if $(filter @%,$(1)),$(patsubst @%,%,$(1)),$(if $(3),$(1) $(1)$(call FormatABISuffix,$(1),$(3))=$(2),$(1)=$(2))))',
    'endef', 'define FormatProvides',
    '$(strip $(if $(call FormatABISuffix,$(1),$(3)),$(1) $(foreach provide,$(filter-out $(1),$(4)),$(call AddProvide,$(provide),$(2),$(3))),$(foreach provide,$(filter-out $(1),$(4)),$(call AddProvide,$(provide),$(2)))))',
    'endef',
  ].join('\n');
  const abiFunction = [
    'define FormatABISuffix',
    '$(if $(filter-out kmod-%,$(1)),$(if $(2),$(if $(filter %0 %1 %2 %3 %4 %5 %6 %7 %8 %9,$(1)),-)$(2)))',
    'endef',
  ].join('\n');
  writeFileSync(join(packagingTree, 'include/package-pack.mk'), packFunctions);
  writeFileSync(join(packagingTree, 'include/package-dumpinfo.mk'), 'ABI-Version: $(ABI_VERSION)\n');
  writeFileSync(join(packagingTree, 'include/feeds.mk'), abiFunction);
  const contract = nativePackageInstallationContract(packagingTree);
  assert.equal(contract.kind, 'openwrt-apk-provides-v1');
  const nativePackages = parsePackageInfo([
    'Package: implementation-a', 'Provides: alias @shared-any', 'ABI-Version: 3',
    'Package: implementation-b', 'Provides: alias @shared-any', 'ABI-Version: 4',
    'Package: implementation2', 'Provides: alias2', 'ABI-Version: 0',
    'Package: kmod-implementation', 'Provides: kmod-alias ordinary-alias', 'ABI-Version: ignored',
  ].join('\n'));
  const installationGraph = buildKconfigRelations([], nativePackages, [], { packageInstallation: contract });
  const apk = name => installationGraph.records.find(row => row.package === name).packageInfo.installation.apk;
  assert.deepEqual(apk('implementation-a'), { name: 'implementation-a3', provides: ['alias3'] });
  assert.deepEqual(apk('implementation-b'), { name: 'implementation-b4', provides: ['alias4'] });
  assert.deepEqual(apk('implementation2'), { name: 'implementation2-0', provides: ['alias2-0'] });
  assert.deepEqual(apk('kmod-implementation'), { name: 'kmod-implementation', provides: ['kmod-alias', 'ordinary-alias'] });
  const makeCommand = process.env.WEIG_MAKE || 'make';
  const makeAvailable = spawnSync(makeCommand, ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
  if (makeAvailable) {
    for (const row of nativePackages) {
      const makeInput = [packFunctions, abiFunction,
        `$(info NAME|${row.name}$(call FormatABISuffix,${row.name},${row.abiVersion}))`,
        `$(info PROVIDES|$(call FormatProvides,${row.name},1,${row.abiVersion},${(row.rawProvides || row.provides || []).join(' ')}))`,
        '__metadata_only: ;', ''].join('\n');
      const output = execFileSync(makeCommand, ['--no-print-directory', '-rR', '-f', '-'],
        { input: makeInput, encoding: 'utf8', env: { ...process.env, MAKEFLAGS: '', MFLAGS: '', GNUMAKEFLAGS: '' } });
      const name = output.match(/^NAME\|(.*)$/m)[1];
      const provides = output.match(/^PROVIDES\|(.*)$/m)[1].split(/\s+/)
        .filter(token => token.includes('=')).map(token => token.split('=')[0]);
      assert.deepEqual(apk(row.name), { name, provides }, 'installation projection must match native GNU Make functions');
    }
  } else {
    assert(process.platform === 'win32' && !process.env.CI, 'native installation oracle requires GNU Make in CI');
  }
  const compact = compactRelations(installationGraph);
  const expanded = expandCompactRelations(compact);
  assert(compareRelationSemantics(installationGraph, expanded).equal,
    'installation facts must survive the existing positional codec without reinterpreting fields');
  assert.deepEqual(expanded.packageInstallation, contract);
  assert.deepEqual(expanded.records.find(row => row.package === 'implementation-a').packageInfo.installation.apk,
    apk('implementation-a'));
  writeFileSync(join(packagingTree, 'include/package-pack.mk'), packFunctions.replace('$(1)=$(2)', '$(1)'));
  assert.equal(nativePackageInstallationContract(packagingTree), null,
    'an upstream dialect change must not retain an unsupported installation assertion');
} finally { rmSync(packagingTree, { recursive: true, force: true }); }

const text = [
  'Source-Makefile: package/old/Makefile',
  'Package: duplicate', 'Title: Old definition', 'Depends: old-dependency',
  'Provides: @old-capability', 'Conflicts: old-conflict',
  'Source-Makefile: package/new/Makefile', 'Override: package/old',
  'Package: duplicate', 'Title: Effective definition', 'Depends: +TLS:tls-any @NETWORK',
  'Provides: @new-capability', 'Conflicts: provider,',
  'Description: Multiline metadata', 'Package: not-a-package', '@@',
  'Config:', 'Depends: not-a-dependency', '@@',
  'Package: provider', 'Provides: @tls-any versioned-capability=1.2',
  'Source-Makefile: package/firmware/Makefile',
  'Package: firmware/device', 'Build-Only: 1', '',
].join('\n');
const rows = parsePackageInfo(text);
assert.deepEqual(rows.map((row) => row.name), ['duplicate', 'provider', 'firmware/device']);
assert.equal(rows[0].sourceMakefile, 'package/new/Makefile');
assert.equal(rows[0].override, 'package/old');
assert.deepEqual(rows[0].rawProvides, ['@new-capability']);
assert.deepEqual(rows[0].depends, ['+TLS:tls-any', '@NETWORK']);
assert.deepEqual(rows[0].replacedSources[0].depends, ['old-dependency']);
assert.equal(rows[2].buildOnly, true);
const graph = buildKconfigRelations([], rows, []);
assert.equal(graph.packageClosureComplete, true);
assert.deepEqual(graph.indexes.providers['new-capability'], ['duplicate']);
assert.deepEqual(graph.indexes.providers['old-capability'], ['duplicate']);
assert.deepEqual(graph.indexes.providers['versioned-capability=1.2'], ['provider']);
assert.equal(graph.indexes.providers['versioned-capability'], undefined);
assert.equal(graph.records.find((row) => row.package === 'firmware/device').origin, 'packageinfo-only');

// Use the existing native integration source checkout when supplied. No
// pinned implementation copy or package/source-specific dependency fixture.
const implementation = process.env.KCONFIG_NATIVE_TEST_TREE;
if (implementation) {
  const root = mkdtempSync(join(tmpdir(), 'catalog-metadata-parity-'));
  try {
    const input = join(root, 'packageinfo');
    writeFileSync(input, text);
    const program = String.raw`use metadata; use JSON::PP;
      parse_package_metadata($ARGV[0]) or die "metadata parse failed";
      print encode_json({ packages => [map { my $p = $package{$_};
        +{name => $_, depends => $p->{depends}, provides => $p->{provides},
          conflicts => $p->{conflicts} || [], makefile => $p->{src}{makefile},
          buildOnly => $p->{buildonly} ? JSON::PP::true : JSON::PP::false}
      } sort keys %package], providers => {map { $_ => [map { $_->{name} } @{$vpackage{$_}}] } keys %vpackage}});`;
    const nativeResult = JSON.parse(execFileSync(process.env.PERL || 'perl', [
      '-I', join(resolve(implementation), 'scripts'), '-e', program, input,
    ], { encoding: 'utf8' }));
    const native = nativeResult.packages;
    for (const expected of native) {
      const row = rows.find((item) => item.name === expected.name);
      assert(row, `Missing native package ${expected.name}`);
      assert.deepEqual(row.depends, expected.depends);
      // Native generations differ in their internal Provides representation:
      // some retain the marker, others strip it in metadata.pm. Compare the
      // public capability projection on both sides; raw input is tested above.
      const capability = (name) => name.replace(/^@/, '');
      assert.deepEqual([row.name, ...(row.rawProvides || row.provides)].map(capability),
        expected.provides.map(capability));
      assert.deepEqual(row.conflicts, expected.conflicts);
      assert.equal(row.sourceMakefile, expected.makefile);
      assert.equal(Boolean(row.buildOnly), expected.buildOnly);
    }
    assert.equal(rows.length, native.length);
    for (const [name, providers] of Object.entries(nativeResult.providers)) {
      if (rows.some((row) => row.name === name)) continue;
      assert.deepEqual(graph.indexes.providers[name.replace(/^@/, '')], [...new Set(providers)].sort(), `Provider identity mismatch: ${name}`);
    }
    console.log('Native metadata.pm concrete-package projection parity passed');
  } finally {
    // root is a task-created mkdtemp child, never a repository or user path.
    rmSync(root, { recursive: true, force: true });
  }
} else console.log('Package metadata regression passed (native oracle requires KCONFIG_NATIVE_TEST_TREE)');

// Optional real-asset replay: this checks preserved package metadata across
// historical branches, not a substitute for regenerating from native source.
if (process.argv[2]) {
  const visit = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? visit(join(directory, entry.name)) :
      entry.name.endsWith('.graph.json.gz') ? [join(directory, entry.name)] : []);
  for (const path of visit(resolve(process.argv[2]))) {
    const document = JSON.parse(gunzipSync(readFileSync(path)));
    const relations = expandCompactRelations(document.relations);
    const metadata = relations.records.filter((row) => row.package && row.origin.includes('packageinfo')).map((row) => ({
      name: row.package, depends: row.packageInfo.rawDepends, provides: row.provides,
      conflicts: (row.conflictsRelations || []).map((relation) => relation.raw),
    }));
    const replay = buildKconfigRelations([], metadata, []);
    assert.equal(replay.packageClosureComplete, true,
      `${path}: ${JSON.stringify(replay.packageClosureValidation.reasons.slice(0, 3))}`);
    console.log(`Package metadata replay passed: ${document.source.id}/${document.source.branch} (${metadata.length} packages)`);
    global.gc?.();
  }
}
