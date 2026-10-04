#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTargetTree,
  incompleteSelectableTargets,
  lintKconfigOptions,
  parseInfoRecords,
  parseKconfigDefault,
  parseKconfigExpression,
  parseKconfigRelation,
  parseKconfigRange,
  parseKconfigTree,
  parsePackageInfo,
  resolvePackageOption,
  resolveTargetSelectors,
  targetBuildContract,
} from './lib.mjs';
import {
  buildKconfigRelations,
  derivePackageDependencyClosure,
  parsePackageDependency,
  validatePackageClosureGraph,
} from './kconfig-relations.mjs';
import {
  compactRelations,
  compareRelationSemantics,
  expandCompactRelations,
  validateCompactRoundTrip,
} from './compact-relations.mjs';
import { buildCatalogSizeReport } from './catalog-size-report.mjs';
import { applicableBuildDependencies, normalizeCompatibilityDocument } from './compatibility-rules.mjs';
import { buildProbeConfig, verifyProbeConfig } from './verify-target-contracts.mjs';
import { activeCuratedGroups, buildCuratedApplications } from './curated-applications.mjs';
import { parseApkDump, parseOpkgPackages } from './curated-sizes.mjs';
import { sourceAllowsBranch, sourceBranchVersion, compareBranches, validateSourcePolicy } from './source-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(ROOT, 'tests', 'fixture');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
const json = (...parts) => JSON.parse(read(...parts));

// Public project identity and licensing must remain self-contained for forks.
const license = read('LICENSE');
const notice = read('NOTICE');
const reuse = read('REUSE.toml');
const licenseZh = read('LICENSE.zh-CN.md');
assert(license.includes('GNU GENERAL PUBLIC LICENSE'));
assert(license.includes('Version 3, 29 June 2007'));
assert(license.includes('END OF TERMS AND CONDITIONS'));
assert(notice.includes('GPL-3.0-or-later'));
assert(notice.includes('weigefenxiang@gmail.com'));
assert(reuse.includes('SPDX-License-Identifier = "GPL-3.0-or-later"'));
assert(licenseZh.includes('非官方中文说明'));

const policy = json('catalog.config.json');
const compatibility = json('compatibility.json');
const automation = json('.github', 'automation-policy.json');
const translations = json('translations', 'zh-CN.json');
const menuI18n = json('translations', 'menu-i18n.json');

// Source/Branch policy is data-driven and future branches stay discoverable.
assert.equal(policy.sources.length, 6);
const immortal = policy.sources.find((row) => row.id === 'ImmortalWrt');
const openwrt = policy.sources.find((row) => row.id === 'OpenWrt');
const lede = policy.sources.find((row) => row.id === 'lede');
assert(immortal && openwrt && lede);
assert.deepEqual(immortal.branches?.include, ['master', 'openwrt-*']);
assert(sourceAllowsBranch(immortal, 'master'));
assert(sourceAllowsBranch(immortal, 'openwrt-30.01'));
assert(!sourceAllowsBranch(immortal, 'main'));
assert.deepEqual(openwrt.branches?.include, ['main', 'openwrt-*']);
assert(sourceAllowsBranch(openwrt, 'main'));
assert(!sourceAllowsBranch(openwrt, 'master'));
assert(sourceAllowsBranch(lede, 'master'));
assert(sourceAllowsBranch(lede, 'openwrt-30.01'));
const store = policy.sources.find((row) => row.id === 'iStoreOS');
const lienol = policy.sources.find((row) => row.id === 'Lienol');
for (const branch of ['istoreos-21.02', 'istoreos-22.03', 'istoreos-23.05', 'istoreos-24.10', 'istoreos-25.12', 'istoreos-30.01']) {
  assert(sourceAllowsBranch(store, branch), branch);
}
for (const branch of ['main', 'master', 'openwrt-25.12', 'istoreos-24.10.4', 'istoreos-24.10.0-rc4',
  'istoreos-22.03-dev', 'istoreos-24.10-rebase', 'istoreos-24.10-rk-opp-pvtm', 'istoreos-3.01', 'istoreos-next']) {
  assert(!sourceAllowsBranch(store, branch), branch);
}
for (const branch of ['19.07', '23.05', '24.10', '25.12', '30.01']) assert(sourceAllowsBranch(lienol, branch), branch);
for (const branch of ['main', 'master', '25.12.1', '25.12-dev', 'openwrt-25.12']) assert(!sourceAllowsBranch(lienol, branch), branch);
assert.equal(sourceBranchVersion(store, 'istoreos-24.10'), '24.10');
assert.equal(sourceBranchVersion(immortal, 'openwrt-18.06-k5.4'), '18.06-k5.4', 'existing version identities stay stable');
assert.deepEqual(['istoreos-23.05', 'istoreos-25.12', 'istoreos-24.10'].sort((a, b) => compareBranches(a, b, store)),
  ['istoreos-25.12', 'istoreos-24.10', 'istoreos-23.05']);
assert.deepEqual(['main', 'openwrt-23.05', 'openwrt-25.12'].sort((a, b) => compareBranches(a, b, openwrt)),
  ['openwrt-25.12', 'openwrt-23.05', 'main']);
assert.throws(() => validateSourcePolicy({ ...store, branches: { ...store.branches, versionFamily: { prefix: '*', components: 2, width: 2 } } }), /versionFamily/);
assert.throws(() => validateSourcePolicy({ ...store, branches: { ...store.branches, preferDefault: 'true' } }), /preferDefault/);
assert(store.branches.preferDefault && lienol.branches.preferDefault);
for (const source of [store, lienol]) {
  assert.deepEqual(source.build, { diy1: 'diy-generic.sh', diy2: 'diy2-generic.sh' });
  assert(!policy.curatedSizeSources.some((row) => row.id === source.id), 'never borrow another fork\'s package sizes');
}

// Official Target/Profile parsing and selector contracts.
const targets = parseInfoRecords(readFileSync(join(fixture, 'targetinfo'), 'utf8'));
const menu = parseKconfigTree(fixture);
assert.equal(menu.validation.capabilityMatrixComplete, true);
assert.equal(menu.validation.parserFixtureValidated, true);
assert.equal(menu.validation.parserFixture.cases, 12);
assert.deepEqual(menu.validation.missingRelationCapabilities, []);
assert(Object.values(menu.validation.capabilityMatrix).every((value) => value === true));
assert(Object.values(menu.validation.parserFixture.capabilityMatrix).every((value) => value === true));
assert(Object.values(menu.validation.parserOutput.capabilityMatrix).every((value) => value === true));
assert.equal(menu.validation.unsupportedDirectives.length, 0);
assert.equal(menu.validation.structuralErrors.length, 0);
assert.equal(menu.validation.relationsComplete, true);
// The generic golden tree exercises parser coverage that a small target
// fixture may not happen to use: typed scalars/defaults/ranges, expression
// ASTs, visibility, choice metadata, MODULES, and duplicate provenance.
const goldenMenu = parseKconfigTree(join(ROOT, 'tests', 'kconfig-capabilities'));
assert.equal(goldenMenu.validation.parserFixtureValidated, true);
assert.equal(goldenMenu.validation.capabilityMatrixComplete, true);
assert(Object.entries(goldenMenu.validation.parserOutput.observed).every(([, count]) => count > 0));
const goldenOption = (symbol) => goldenMenu.allOptions.find((row) => row.symbol === symbol);
assert.equal(goldenOption('GOLDEN_STRING')?.defaultsTyped[0]?.value, 'foo if bar');
assert.equal(goldenOption('GOLDEN_STRING')?.defaultsTyped[0]?.condition, 'GOLDEN_GATE');
assert.equal(goldenOption('GOLDEN_INT')?.rangesTyped[0]?.max, 64);
assert(goldenOption('GOLDEN_BOOL')?.dependsAst[0]?.alternatives?.length);
assert.deepEqual(goldenOption('GOLDEN_BOOL')?.visibleIf, ['GOLDEN_VISIBLE']);
assert.equal(goldenOption('GOLDEN_MODULE')?.modules, true);
assert.equal(goldenMenu.choices[0]?.optional, true);
assert.equal(goldenMenu.choices[0]?.modules, true);
assert.equal(goldenMenu.choices[0]?.resetIf?.[0], 'GOLDEN_RESET');
assert.equal(goldenMenu.choices[0]?.resetIfAst?.[0]?.complete, true);
assert(goldenMenu.choices[0]?.help?.includes('config, source and reset are help text'));
assert.equal(goldenOption('GOLDEN_DUPLICATE')?.nodes?.length, 2);
const sourceMenu = parseKconfigTree(join(ROOT, 'tests', 'kconfig-source'));
assert.equal(sourceMenu.validation.relationsComplete, false,
  'unevaluated dynamic Kconfig expressions cannot claim a complete source closure');
assert.deepEqual(sourceMenu.validation.structuralErrors, []);
assert.deepEqual(sourceMenu.validation.unsupportedDirectives, []);
assert(sourceMenu.allOptions.some((row) => row.symbol === 'SOURCE_GLOB_ONE'));
assert(sourceMenu.allOptions.some((row) => row.symbol === 'SOURCE_GLOB_TWO'));
assert(sourceMenu.allOptions.some((row) => row.symbol === 'SOURCE_NESTED_FALLBACK'));
assert(sourceMenu.allOptions.some((row) => row.symbol === 'SOURCE_RELATIVE'));
assert(sourceMenu.allOptions.some((row) => row.symbol === 'SOURCE_QUESTION_FALLBACK'));
assert(sourceMenu.allOptions.some((row) => row.symbol === 'SOURCE_RSOURCE_GLOB'));
assert(!sourceMenu.allOptions.some((row) => row.symbol === 'SOURCE_RELATIVE_ROOT'));
assert(!sourceMenu.allOptions.some((row) => row.symbol === 'SOURCE_HIDDEN_GLOB'));
assert(!sourceMenu.allOptions.some((row) => row.symbol === 'SOURCE_SOURCE_GLOB_FALLBACK'));
assert.equal(sourceMenu.validation.variableAssignments?.[0]?.operator, ':=');
assert(sourceMenu.validation.dynamicExpressions?.some((row) => row.text.includes('$(shell')));
const sourceRelations = buildKconfigRelations(sourceMenu.allOptions || sourceMenu.options, [], sourceMenu.choices, {
  parserValidation: sourceMenu.validation,
});
assert.equal(sourceRelations.relationsComplete, false,
  'relation completeness must retain the parser dynamic-expression failure');
const sourceExpanded = expandCompactRelations(compactRelations(sourceRelations));
assert(sourceExpanded.validation.variableAssignments?.some((row) => row.name === 'KCONFIG_CAPTURE'));
assert(sourceExpanded.validation.dynamicExpressions?.some((row) => row.text.includes('$(shell')));
const missingLiteralMenu = parseKconfigTree(join(ROOT, 'tests', 'kconfig-source-missing'));
assert.equal(missingLiteralMenu.validation.relationsComplete, false);
assert(missingLiteralMenu.validation.structuralErrors.some((row) => row.reason === 'missing-source'));
const zeroColumnHelp = parseKconfigTree(join(ROOT, 'tests', 'kconfig-help-zero'));
assert.equal(zeroColumnHelp.validation.relationsComplete, true);
assert(zeroColumnHelp.allOptions.find((row) => row.symbol === 'HELP_ZERO')?.help?.includes('Zero-column help text'));
assert(zeroColumnHelp.allOptions.some((row) => row.symbol === 'HELP_ZERO_NEXT'));
const wildcardMissing = parseKconfigTree(join(ROOT, 'tests', 'kconfig-source-patterns'));
assert.equal(wildcardMissing.validation.relationsComplete, false);
assert.equal(wildcardMissing.validation.structuralErrors.filter((row) => row.reason === 'missing-source').length, 2);
const symbols = new Set((menu.allOptions || menu.options).map((row) => row.symbol));
for (const target of targets) {
  target.contract = targetBuildContract(target, symbols);
  target.targetSelector = target.contract.targetSelector || '';
  const profileContracts = new Map((target.contract.profileContracts || []).map((row) => [row.id, row]));
  for (const profile of target.profiles) {
    const contract = profileContracts.get(profile.id);
    profile.selector = contract?.selector || '';
    profile.selectable = contract?.selectable !== false;
  }
}
assert.equal(targets.length, 4);
assert.equal(targets.find((row) => row.id === 'x86/64')?.arch, 'x86_64');
assert.equal(targets.find((row) => row.id === 'mediatek/filogic')?.arch, 'aarch64');
assert.equal(targetBuildContract(targets.find((row) => row.id === 'abstract-board')).kind, 'abstract');
assert.equal(targetBuildContract(targets.find((row) => row.id === 'unavailable-board')).kind, 'unavailable');
assert.deepEqual(incompleteSelectableTargets(targets).map((row) => row.id), ['unavailable-board']);

const targetTree = buildTargetTree(targets.filter((row) => row.contract.selectable), menu.options);
const x86 = targetTree.find((row) => row.value === 'x86');
const x8664 = x86?.children.find((row) => row.value === '64');
assert.equal(x86?.labelEn, 'x86');
assert.equal(x8664?.labelEn, 'x86_64');
assert.deepEqual(x8664?.children.map((row) => row.labelEn), ['Generic x86/64', 'QEMU Q35']);

const x86Target = targets.find((row) => row.id === 'x86/64');
const x86Profile = x86Target?.profiles[0];
const selectors = resolveTargetSelectors(x86Target, x86Profile);
const probe = buildProbeConfig(x86Target, x86Profile, selectors);
assert(probe.includes('CONFIG_TARGET_x86=y'));
assert(verifyProbeConfig(probe, x86Target, x86Profile, selectors).valid);
assert(!verifyProbeConfig(probe.replace(`CONFIG_${selectors.profile}=y`, `# CONFIG_${selectors.profile} is not set`),
  x86Target, x86Profile, selectors).valid);

// Package/menu metadata and generic Kconfig relation graph.
const packages = parsePackageInfo(readFileSync(join(fixture, 'packageinfo'), 'utf8'));
assert.equal(packages.length, 3);
assert.equal(packages[0].category, 'LuCI');
assert.equal(packages[0].description, 'Demonstration web interface package');
assert.deepEqual(packages[0].conflicts, ['kmod-demo']);
const packageInfoOnly = parsePackageInfo('Package: luci-app-packageinfo-only\nTitle: Metadata only\nDescription: No Kconfig symbol\n');
assert.equal(resolvePackageOption(packageInfoOnly[0], new Set(['packageinfo-only'])), '');

const demo = menu.options.find((row) => row.symbol === 'PACKAGE_luci-app-demo');
const luci = menu.options.find((row) => row.symbol === 'PACKAGE_luci');
const hiddenLanguage = (menu.allOptions || menu.options).find((row) => row.symbol === 'PACKAGE_luci-i18n-demo-zh-cn');
assert.equal(demo?.type, 'tristate');
assert(demo?.depends.includes('TARGET_x86'));
assert(demo?.help?.includes('if the application is enabled'));
assert.equal(demo?.parent, luci?.symbol);
assert.equal(hiddenLanguage?.visible, false);
assert.equal(hiddenLanguage?.userSettable, false);
assert.equal(menu.choices.length, 1);
assert.equal(menu.choices[0]?.type, '', 'an untyped choice must remain unknown, not be forced to bool');

const relations = buildKconfigRelations(menu.allOptions || menu.options, packages, menu.choices);
assert.equal(relations.schema, 2);
const demoRelations = relations.records.find((row) => row.package === 'luci-app-demo');
assert.deepEqual(demoRelations?.states, ['n', 'm', 'y']);
assert(demoRelations?.kconfig.depends.includes('PACKAGE_luci'));
assert(demoRelations?.dependencyPackages.includes('luci-base'));
assert(demoRelations?.conflicts.includes('kmod-demo'));
assert(relations.validation.structurallyValid);
assert.equal(relations.relationsComplete, true,
  'Kconfig completeness is independent of partial package closure metadata');
const compact = compactRelations(relations);
const expanded = expandCompactRelations(compact);
assert.equal(compact.schema, 4);
assert.equal(typeof compact.relationsComplete, 'boolean');
assert(Array.isArray(compact.relationCapabilities));
assert.equal(compact.relationsComplete, true);
assert(compact.relationCapabilities.includes('choice-reset-conditions-v1'));
assert.equal(compact.roundTripValidated, true);
assert(compact.relationCapabilities.includes('complete-kconfig-relations-v1'));
assert.equal(compact.validation.compactExpandSemanticEqual, true);
assert.equal(relations.packageClosureComplete, true,
  'unresolved package targets must not invalidate the global projection proof');
assert.equal(relations.packageClosureValidation.reasons.some((row) =>
  row.reason === 'unresolved-package-dependency-target'), false);
assert.equal(relations.packageClosureValidation.dependencyTargetsComplete, false);
assert(relations.packageClosureValidation.unresolvedDependencyTargets.some((row) =>
  row.target === 'luci-base'));
assert.equal(typeof relations.packageClosureValidation.forwardReverseValidated, 'boolean');
assert.equal(compact.packageClosureComplete, true);
assert.deepEqual(expanded.indexes.byPackage, relations.indexes.byPackage);
assert.deepEqual(expanded.indexes.bySymbol, relations.indexes.bySymbol);
assert.deepEqual(expanded.indexes.reverseDependencies, relations.indexes.reverseDependencies);
assert.deepEqual(expanded.indexes.reverseSelects, relations.indexes.reverseSelects);
assert.deepEqual(expanded.indexes.reverseImplies, relations.indexes.reverseImplies);
assert.equal(expanded.packageClosureComplete, true,
  'compact package closure projection proof must round-trip independently');
assert.equal(expanded.relationsComplete, true,
  'package closure incompleteness must not demote independent Kconfig completeness');
assert.equal(expanded.validation.roundTripValidated, true);
assert.equal(compareRelationSemantics(relations, expanded).equal, true);
assert.equal(expanded.choices[0]?.type, '', 'compact choice roundtrip must preserve an unknown choice type');
const goldenRelations = buildKconfigRelations(goldenMenu.allOptions || goldenMenu.options, [], goldenMenu.choices);
const goldenExpanded = expandCompactRelations(compactRelations(goldenRelations));
assert.deepEqual(goldenExpanded.choices[0]?.resetIf, goldenMenu.choices[0]?.resetIf);
assert.equal(goldenExpanded.choices[0]?.resetIfAst?.[0]?.complete, true);
assert(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(relations)) * 0.5);

// Typed Kconfig values retain type, source order, and unresolved expressions.
assert.deepEqual(parseKconfigDefault('"fast path" if FEATURE_GATE', 'string'), {
  type: 'string', value: 'fast path', raw: '"fast path" if FEATURE_GATE',
  valueKind: 'literal', valid: true, precise: true, condition: 'FEATURE_GATE',
});
assert.deepEqual(parseKconfigDefault('42 if FEATURE_GATE', 'int'), {
  type: 'int', value: 42, raw: '42 if FEATURE_GATE', valueKind: 'literal', valid: true, precise: true,
  condition: 'FEATURE_GATE',
});
assert.deepEqual(parseKconfigDefault('0x2a', 'hex'), {
  type: 'hex', value: 42, raw: '0x2a', valueKind: 'literal', valid: true, precise: true, condition: '',
});
assert.deepEqual(parseKconfigRange('1 64 if FEATURE_GATE', 'int'), {
  type: 'int', min: 1, max: 64, minRaw: '1', maxRaw: '64',
  minKind: 'literal', maxKind: 'literal', raw: '1 64 if FEATURE_GATE', condition: 'FEATURE_GATE', valid: true,
});
const quotedDefaultRelations = buildKconfigRelations([{
  symbol: 'QUOTED_DEFAULT', type: 'string', prompt: 'quoted', visible: true, userSettable: true,
  defaults: ['"foo if bar" if FEATURE_GATE'],
  defaultsTyped: [parseKconfigDefault('"foo if bar" if FEATURE_GATE', 'string')],
  ranges: [], rangesTyped: [], selects: [], implies: [], depends: [],
}], [], []);
const quotedDefaultExpanded = expandCompactRelations(compactRelations(quotedDefaultRelations));
const quotedDefaultRecord = quotedDefaultExpanded.records.find((row) => row.configSymbol === 'QUOTED_DEFAULT');
assert.deepEqual(quotedDefaultRecord?.defaults, ['"foo if bar" if FEATURE_GATE'],
  'compact defaults must split `if` outside quoted Kconfig strings');
assert.equal(quotedDefaultRecord?.defaultsTyped[0]?.raw, '"foo if bar" if FEATURE_GATE');
assert.equal(compareRelationSemantics(quotedDefaultRelations, quotedDefaultExpanded).equal, true);
assert.deepEqual(parseKconfigExpression('A || B && !C').alternatives, [['A'], ['B', 'C']]);
assert.deepEqual(parseKconfigExpression('A || B && !C').symbols, ['A', 'B', 'C']);
assert.equal(parseKconfigExpression('A || B && !C').complete, true);
const relation = parseKconfigRelation('TARGET_FEATURE if GATE && OTHER');
assert.equal(relation.target, 'TARGET_FEATURE');
assert.deepEqual(relation.conditionSymbols, ['GATE', 'OTHER']);
assert.equal(relation.complete, true);
const nativeUndefinedRelations = buildKconfigRelations([{
  symbol: 'NATIVE_UNDEFINED_ROOT', type: 'bool', prompt: 'root', visible: true, userSettable: true,
  depends: ['NATIVE_UNDEFINED_CONTEXT'], defaults: [], selects: [], implies: [],
}], [], [], { externalSymbols: [] });
assert.equal(nativeUndefinedRelations.relationsComplete, false,
  'without a full parser proof, a missing Kconfig definition remains unresolved');
assert.deepEqual(nativeUndefinedRelations.validation.unresolvedKconfig, [{
  symbol: 'NATIVE_UNDEFINED_ROOT', missing: ['NATIVE_UNDEFINED_CONTEXT'],
}]);
assert.deepEqual(nativeUndefinedRelations.validation.kconfigUndefinedSymbols, []);

// A complete active-root parse proves that these references are genuinely
// undefined in the evaluated Kconfig context.  The proof must retain the
// native unknown identity: boolean evaluation is n, while string comparison
// keeps the symbol name rather than fabricating the string "n".
const undefinedMenu = parseKconfigTree(join(ROOT, 'tests', 'kconfig-undefined'));
assert.equal(undefinedMenu.validation.relationsComplete, true);
const undefinedRelations = buildKconfigRelations(undefinedMenu.allOptions, [], undefinedMenu.choices, {
  parserValidation: undefinedMenu.validation,
});
assert.equal(undefinedRelations.relationsComplete, true,
  'authoritatively undefined active-root symbols do not make a complete graph incomplete');
assert(undefinedRelations.validation.kconfigUndefinedSymbols.some((row) =>
  row.symbol === 'UNDEFINED_ROOT' && row.missing === 'UNDEFINED_CONTEXT' &&
  row.nativeType === 'unknown' && row.booleanValue === 'n' && row.stringValue === 'UNDEFINED_CONTEXT'));
assert(undefinedRelations.validation.kconfigUndefinedSymbols.some((row) =>
  row.symbol === 'UNDEFINED_STRING' && row.missing === 'UNDEFINED_STRING_DEFAULT' &&
  row.nativeType === 'unknown' && row.booleanValue === 'n' && row.stringValue === 'UNDEFINED_STRING_DEFAULT'));
assert(undefinedRelations.validation.kconfigUndefinedSymbols.some((row) =>
  row.choice === 'choice-1' && row.missing === 'UNDEFINED_CHOICE_RESET'));
assert(undefinedRelations.validation.kconfigUndefinedSymbols.some((row) =>
  row.missing === 'UNDEFINED_MIN' || row.missing === 'UNDEFINED_MAX' ||
  row.missing === 'UNDEFINED_RANGE_GATE'));

// A symbol that is present in the authoritative parser set but omitted from
// the graph projection is not native-undefined; it is a projection loss and
// must remain unresolved.
const omittedOptions = undefinedMenu.allOptions.filter((row) => row.symbol !== 'DEFINED_BUT_OMITTED');
const omittedRelations = buildKconfigRelations(omittedOptions, [], undefinedMenu.choices, {
  parserValidation: undefinedMenu.validation,
});
assert.equal(omittedRelations.relationsComplete, false);
assert(omittedRelations.validation.unresolvedKconfig.some((row) =>
  row.symbol === 'OMITTED_REFERENCE_ROOT' && row.missing.includes('DEFINED_BUT_OMITTED')));
assert(!omittedRelations.validation.kconfigUndefinedSymbols.some((row) =>
  row.missing === 'DEFINED_BUT_OMITTED'));
const targetProjectionRelations = buildKconfigRelations(omittedOptions, [], undefinedMenu.choices, {
  parserValidation: undefinedMenu.validation,
  externalSymbols: ['DEFINED_BUT_OMITTED'],
  externalSymbolSources: { DEFINED_BUT_OMITTED: ['parsed-target-filter'] },
});
assert(targetProjectionRelations.validation.externalSymbols.includes('DEFINED_BUT_OMITTED'));
assert.deepEqual(targetProjectionRelations.validation.externalSymbolDefinitions, [
  { symbol: 'DEFINED_BUT_OMITTED', type: 'bool' },
]);
assert(!targetProjectionRelations.validation.unresolvedKconfig.some((row) =>
  row.missing.includes('DEFINED_BUT_OMITTED')));
const forgedExternalRelations = buildKconfigRelations(undefinedMenu.allOptions, [], undefinedMenu.choices, {
  parserValidation: undefinedMenu.validation,
  externalSymbols: ['UNDEFINED_CONTEXT'],
  externalSymbolSources: { UNDEFINED_CONTEXT: ['parsed-target-filter'] },
});
assert(!forgedExternalRelations.validation.externalSymbols.includes('UNDEFINED_CONTEXT'),
  'external provenance must point to a parsed definition, not merely supply a source label');
assert(forgedExternalRelations.validation.kconfigUndefinedSymbols.some((row) =>
  row.missing === 'UNDEFINED_CONTEXT'));
assert.equal(parseKconfigDefault('m', 'bool').valid, true,
  'bool defaults may use the native tristate literal before bool-domain narrowing');
assert.equal(parseKconfigRange('20 50000 # inline rationale', 'int').valid, true,
  'Kconfig range comments must be removed before typed validation');
assert.equal(parseKconfigExpression('!FEATURE_GATE # inline rationale').complete, true,
  'Kconfig expression comments must not become trailing tokens');
const packageSelectorExpression = parseKconfigExpression('@(!boost-shared-libs&&!boost-static-and-shared-libs)');
assert.equal(packageSelectorExpression.complete, true,
  'the native lexer ignores @ but continues parsing the ordinary Kconfig expression');
assert.equal(packageSelectorExpression.ast?.kind, 'and');
assert.deepEqual(packageSelectorExpression.symbols,
  ['boost-shared-libs', 'boost-static-and-shared-libs']);
assert.deepEqual(packageSelectorExpression.warnings, [
  { kind: 'ignored-character', character: '@', index: 0 },
]);
const architectureSelectorExpression = parseKconfigExpression('@arm||@x86_64');
assert.equal(architectureSelectorExpression.complete, true);
assert.deepEqual(architectureSelectorExpression.symbols, ['arm', 'x86_64']);
assert.equal(architectureSelectorExpression.warnings.length, 2);
assert.deepEqual(parseKconfigExpression('"quoted@literal"').symbols, []);
assert.deepEqual(parseKconfigExpression('"quoted@literal"').warnings, []);
assert.deepEqual(parseKconfigExpression('A').symbols, ['A']);
const packageSelectorRelations = buildKconfigRelations([{
  symbol: 'PACKAGE_selector-demo', type: 'tristate', prompt: 'selector demo', visible: true,
  userSettable: true, depends: ['@(!boost-shared-libs&&!boost-static-and-shared-libs)'],
  defaults: [], selects: [], implies: [],
}], [], []);
assert.equal(packageSelectorRelations.relationsComplete, false,
  'raw Kconfig @ conditions retain their ordinary symbol dependencies');
assert(packageSelectorRelations.validation.unresolvedKconfig.some((row) =>
  row.missing.includes('boost-shared-libs')));
const packageSelectorMenu = parseKconfigTree(join(ROOT, 'tests', 'kconfig-package-selector'));
assert.equal(packageSelectorMenu.validation.relationsComplete, true);
assert.deepEqual(packageSelectorMenu.allOptions[0]?.dependsAst[0]?.symbols,
  ['boost-shared-libs', 'boost-static-and-shared-libs']);
const packageSelectorParsedRelations = buildKconfigRelations(packageSelectorMenu.allOptions,
  [], packageSelectorMenu.choices, { parserValidation: packageSelectorMenu.validation });
assert.equal(packageSelectorParsedRelations.relationsComplete, true);
assert(packageSelectorParsedRelations.validation.kconfigUndefinedSymbols.some((row) =>
  row.missing === 'boost-shared-libs'));
assert.deepEqual(parsePackageDependency('@(!boost-shared-libs&&!boost-static-and-shared-libs)'), {
  raw: '@(!boost-shared-libs&&!boost-static-and-shared-libs)', required: false,
  kind: 'menu-condition', condition: '(!boost-shared-libs&&!boost-static-and-shared-libs)', packages: [],
}, 'package selector conditions use package metadata syntax, not Kconfig expression tokenization');
assert.deepEqual(parseKconfigDefault('m', 'tristate'), {
  type: 'tristate', value: 'm', raw: 'm', valueKind: 'literal', valid: true, precise: true, condition: '',
});
assert.deepEqual(parseKconfigDefault(String.raw`"path\q"`, 'string'), {
  type: 'string', value: 'pathq', raw: String.raw`"path\q"`,
  valueKind: 'literal', valid: true, precise: true, condition: '',
}, 'Kconfig string escaping must not use JSON semantics');
assert.equal(parseKconfigDefault('"unterminated', 'string').valid, false, 'malformed Kconfig strings must fail closed');
const largeInteger = parseKconfigDefault('9223372036854775808', 'int');
assert.equal(largeInteger.value, '9223372036854775808', 'large integer tokens must remain exact strings');
assert.equal(largeInteger.precise, false, 'large integer tokens must not be rounded');
assert.equal(parseKconfigRange('1 2 3', 'int').valid, false, 'ranges require exactly two bounds');

// OR conditions and package alternatives remain explicit in the readable and
// compact graph; neither branch is emitted as a mandatory edge.
const alternativeOptions = [
  { symbol: 'PACKAGE_root', type: 'bool', prompt: 'root', visible: true, userSettable: true,
    depends: ['A || B'], dependsVariants: [['A || B']], defaults: [], selects: [], implies: [], modules: true, optional: true },
  { symbol: 'A', type: 'bool', prompt: 'A', visible: true, userSettable: true, depends: [], defaults: [], selects: [], implies: [] },
  { symbol: 'B', type: 'bool', prompt: 'B', visible: true, userSettable: true, depends: [], defaults: [], selects: [], implies: [] },
];
const alternativeRelations = buildKconfigRelations(alternativeOptions, [], []);
const alternativeEdge = alternativeRelations.edges.find((edge) => edge.from === 'PACKAGE_root');
assert.equal(alternativeEdge?.required, null);
assert.deepEqual(alternativeEdge?.alternatives, [['A'], ['B']]);
const alternativeExpanded = expandCompactRelations(compactRelations(alternativeRelations));
const alternativeExpandedEdge = alternativeExpanded.edges.find((edge) => edge.from === 'PACKAGE_root');
assert.deepEqual(alternativeExpandedEdge?.alternatives, [['A'], ['B']]);
assert.equal(alternativeExpandedEdge?.required, null, 'compact roundtrip must preserve unresolved required=null');
const alternativeExpandedRecord = alternativeExpanded.records.find((record) => record.configSymbol === 'PACKAGE_root');
assert.equal(alternativeExpandedRecord?.modules, true, 'MODULES semantics must survive compact records');
assert.equal(alternativeExpandedRecord?.optional, true, 'optional semantics must survive compact records');
const packageAlternativeRelations = buildKconfigRelations([], parsePackageInfo([
  'Package: root', 'Depends: a||b', '', 'Package: a', '', 'Package: b', '',
].join('\n')), []);
assert.equal(packageAlternativeRelations.packageClosureComplete, true);
assert.equal(packageAlternativeRelations.edges.find((edge) => edge.from === 'root')?.required, null,
  'package alternatives must not become two mandatory graph edges');

const incompletePackageClosure = validatePackageClosureGraph([
  { name: 'root', depends: ['missing'], provides: [], conflicts: [] },
]);
assert.equal(incompletePackageClosure.complete, true,
  'unresolved targets do not invalidate a package-info projection proof');
assert.equal(incompletePackageClosure.validation.reasons.some((row) =>
  row.reason === 'unresolved-package-dependency-target'), false);
assert.deepEqual(incompletePackageClosure.validation.unresolvedDependencyTargets.map((row) => row.target), ['missing']);
assert.equal(incompletePackageClosure.validation.projectionValidated, true);

// Kconfig-only PACKAGE_* rows may coexist with complete package-info rows;
// they must not invalidate the independent package closure contract.
const completePackageRows = parsePackageInfo([
  'Package: root', 'Depends: a||cap', '',
  'Package: a', '',
  'Package: provider', 'Provides: cap', '',
].join('\n'));
const completePackageRelations = buildKconfigRelations([
  { symbol: 'PACKAGE_root', type: 'tristate', prompt: 'root', visible: true, userSettable: true,
    depends: [], defaults: [], selects: [], implies: [] },
  { symbol: 'PACKAGE_a', type: 'tristate', prompt: 'a', visible: true, userSettable: true,
    depends: [], defaults: [], selects: [], implies: [] },
  { symbol: 'PACKAGE_provider', type: 'tristate', prompt: 'provider', visible: true, userSettable: true,
    depends: [], defaults: [], selects: [], implies: [] },
  { symbol: 'PACKAGE_kconfig-only', type: 'tristate', prompt: 'kconfig-only', visible: true, userSettable: true,
    depends: [], defaults: [], selects: [], implies: [] },
], completePackageRows, []);
assert.equal(completePackageRelations.packageClosureComplete, true,
  'complete package-info closure may ignore unrelated Kconfig-only rows');
assert(completePackageRelations.packageClosureCapabilities.includes('complete-package-build-closure-v1'));
assert.equal(completePackageRelations.relationsComplete, true,
  'package closure is independent from typed Kconfig completeness');
const completePackageProjection = validatePackageClosureGraph(completePackageRows,
  completePackageRelations.records, { edges: completePackageRelations.edges, indexes: completePackageRelations.indexes });
assert.equal(completePackageProjection.complete, true);
const brokenPackageEdges = completePackageRelations.edges.map((edge) =>
  edge.relation === 'package-depends' && edge.to === 'a' ? { ...edge, kind: 'unknown' } : edge);
const brokenPackageProjection = validatePackageClosureGraph(completePackageRows,
  completePackageRelations.records, { edges: brokenPackageEdges, indexes: completePackageRelations.indexes });
assert.equal(brokenPackageProjection.complete, false);
assert(brokenPackageProjection.validation.reasons.some((row) => row.reason === 'package-edge-projection-mismatch'));
const completePackageCompact = compactRelations(completePackageRelations);
const completePackageExpanded = expandCompactRelations(completePackageCompact);
assert.equal(completePackageExpanded.packageClosureComplete, true);
assert(completePackageExpanded.packageClosureCapabilities.includes('complete-package-build-closure-v1'));
assert.equal(completePackageExpanded.relationsComplete, true);

// APK Provides markers are metadata syntax, not capability identity. A
// condition in Depends must retain its own @ semantics independently.
const markedProviderRows = parsePackageInfo([
  'Package: consumer', 'Depends: +TLS:tls-any +!TLS:tls-any @HAS_NETWORK', '',
  'Package: provider', 'Provides: @tls-any @provider-any', '',
  'Conflicts: other,', '', 'Package: other', '',
].join('\n'));
const markedProviderGraph = buildKconfigRelations([], markedProviderRows, []);
assert.equal(markedProviderGraph.packageClosureComplete, true);
assert.deepEqual(markedProviderGraph.indexes.providers['tls-any'], ['provider']);
assert.equal(markedProviderGraph.indexes.providers['@tls-any'], undefined);
assert.equal(markedProviderGraph.records.find((row) => row.package === 'provider').providesRelations[0].raw, '@tls-any');
assert.equal(markedProviderGraph.records.find((row) => row.package === 'provider').conflicts[0], 'other,');
assert.equal(markedProviderGraph.records.find((row) => row.package === 'provider').conflictsRelations[0].kind, 'unknown');
assert.equal(markedProviderGraph.records.find((row) => row.package === 'consumer').dependencyRelations[2].kind, 'menu-condition');
const markedEdges = markedProviderGraph.edges.filter((edge) => edge.relation === 'package-depends');
assert.deepEqual(markedEdges.map((edge) => edge.condition).sort(), ['!TLS', 'TLS']);
const damagedConditions = markedProviderGraph.edges.map((edge) =>
  edge.condition === 'TLS' ? { ...edge, condition: 'UNRELATED' } : edge);
assert.equal(validatePackageClosureGraph(markedProviderRows, markedProviderGraph.records,
  { edges: damagedConditions, indexes: markedProviderGraph.indexes }).complete, false,
  'matching another same-pair edge must not conceal a lost condition');
assert.equal(validateCompactRoundTrip(markedProviderGraph, compactRelations(markedProviderGraph)).valid, true);
const markedClosure = derivePackageDependencyClosure([
  { name: 'consumer', depends: ['tls-any'] },
  { name: 'provider', depends: [], provides: ['@tls-any'] },
], ['consumer'], ['provider'], { selectedPackages: ['consumer', 'provider'] });
assert.equal(markedClosure.result, 'reachable');

// Compact data loss and malformed Kconfig sources are fail-closed. The
// producer may retain a diagnostic false relation object for debugging, but a
// publish path must reject it before writing schema-5/schema-6 assets.
const compactMutationSource = buildKconfigRelations(alternativeOptions, [], []);
const compactMutation = compactRelations(compactMutationSource);
compactMutation.records[0][0] = -1;
const compactMutationValidation = validateCompactRoundTrip(
  compactMutationSource, compactMutation,
);
assert.equal(compactMutationValidation.valid, false);
const malformed = buildKconfigRelations([
  { symbol: 'BROKEN', type: 'bool', prompt: 'broken', visible: true, userSettable: true,
    depends: ['A $ B'], defaults: [], selects: [], implies: [] },
], [], []);
assert.equal(malformed.relationsComplete, false);
assert(malformed.validation.kconfigUnknownRelations.length > 0);

// Generic package closure proof uses concrete packages and selected virtual
// providers; unresolved alternatives/providers stay inconclusive.
const closureRecords = [
  { name: 'root', depends: ['mid'] },
  { name: 'mid', depends: ['+failed'] },
  { name: 'failed', depends: [] },
];
const closure = derivePackageDependencyClosure(closureRecords, ['root'], ['failed']);
assert.equal(closure.result, 'reachable');
assert.deepEqual(closure.paths[0]?.path, ['root', 'mid', 'failed']);
const alternativeClosure = derivePackageDependencyClosure([
  { name: 'root', depends: ['a||b'] }, { name: 'a', depends: [] }, { name: 'b', depends: [] },
], ['root'], ['a']);
assert.equal(alternativeClosure.result, 'inconclusive');
const unresolvedTargetClosure = derivePackageDependencyClosure([
  { name: 'root', depends: ['missing'] }, { name: 'failed', depends: [] },
], ['root'], ['failed']);
assert.equal(unresolvedTargetClosure.result, 'inconclusive');
assert.equal(unresolvedTargetClosure.unknown[0]?.reason, 'package-metadata-unresolved');
const selectedAlternativeClosure = derivePackageDependencyClosure([
  { name: 'root', depends: ['a||b'] }, { name: 'a', depends: [] }, { name: 'b', depends: [] },
], ['root'], ['a'], { selectedPackages: ['root', 'a'] });
assert.equal(selectedAlternativeClosure.result, 'reachable');
const providerClosure = derivePackageDependencyClosure([
  { name: 'root', depends: ['cap'] }, { name: 'provider-a', provides: ['cap'], depends: [] },
  { name: 'provider-b', provides: ['cap'], depends: [] },
], ['root'], ['provider-a'], { selectedPackages: ['root', 'provider-a'] });
assert.equal(providerClosure.result, 'reachable');
const ambiguousProviderClosure = derivePackageDependencyClosure([
  { name: 'root', depends: ['cap'] }, { name: 'provider-a', provides: ['cap'], depends: [] },
  { name: 'provider-b', provides: ['cap'], depends: [] },
], ['root'], ['provider-a']);
assert.equal(ambiguousProviderClosure.result, 'inconclusive');

// Virtual capabilities never become fake CONFIG/PACKAGE symbols, and a
// provider's own capability conflict is excluded from effective providers.
const virtualPackages = parsePackageInfo([
  'Package: libudev-zero', 'Provides: libudev', 'Conflicts: libudev', '',
].join('\n'));
const virtualRelations = buildKconfigRelations([], virtualPackages, []);
const virtualRecord = virtualRelations.records.find((row) => row.package === 'libudev-zero');
assert.equal(virtualRecord?.configSymbol, 'PACKAGE_libudev-zero');
assert.equal(virtualRecord?.origin, 'packageinfo-only');
assert.equal(virtualRecord?.kconfigSymbol, '');
assert.equal(virtualRecord?.providesRelations[0]?.kind, 'virtual');
assert.equal(virtualRecord?.conflictsRelations[0]?.ownerSelf, true);
assert.deepEqual(virtualRecord?.conflictsRelations[0]?.effectiveProviders, []);
assert.equal(virtualRelations.records.some((row) => row.configSymbol === 'PACKAGE_libudev'), false);

// Duplicate symbols must be merged generically, not by package-specific exceptions.
const duplicate = parseKconfigTree(join(ROOT, 'tests', 'duplicate'));
const rustdesk = duplicate.options.find((row) => row.symbol === 'PACKAGE_luci-app-rustdesk-server');
assert.equal(duplicate.options.length, 1);
assert.equal(rustdesk?.nodes?.length, 2);
assert.equal(duplicate.validation.duplicateCount, 1);
assert.equal(duplicate.validation.conflicts.length, 0);
const hardDuplicate = parseKconfigTree(join(ROOT, 'tests', 'duplicate-hard'));
assert(hardDuplicate.validation.conflicts.length > 0);

// Kconfig scope semantics: comments and visibility guards must never become
// value dependencies of the preceding or following symbol.
const semantics = parseKconfigTree(join(ROOT, 'tests', 'kconfig-semantics'));
const semanticOption = (symbol) => semantics.allOptions.find((row) => row.symbol === symbol);
const ifOption = semanticOption('IF_OPTION');
assert.deepEqual(ifOption?.inheritedDepends, ['OUTER_GATE', 'IF_GATE']);
assert.deepEqual(ifOption?.directDepends, ['DIRECT_GATE']);
assert.deepEqual(ifOption?.depends, ['OUTER_GATE', 'IF_GATE', 'DIRECT_GATE']);
assert.deepEqual(ifOption?.promptIf, ['PROMPT_GATE']);
assert(!ifOption?.depends.includes('PROMPT_GATE'));
assert.deepEqual(ifOption?.menuVisibleIf, ['OUTER_VISIBLE']);
assert(!ifOption?.depends.includes('OUTER_VISIBLE'));
const nestedOption = semanticOption('NESTED_OPTION');
assert(nestedOption?.depends.includes('NESTED_GATE'));
assert(!nestedOption?.depends.includes('NESTED_VISIBLE'));
assert.deepEqual(nestedOption?.visibleIf, ['OUTER_VISIBLE', 'NESTED_VISIBLE']);
assert.deepEqual(semanticOption('AFTER_COMMENT')?.depends, ['OUTER_GATE', 'IF_GATE']);
const semanticWarning = semantics.comments.find((row) => row.prompt === 'A warning must not modify IF_OPTION');
assert.deepEqual(semanticWarning?.directDepends, ['!IF_OPTION']);
assert.deepEqual(semanticWarning?.depends, ['OUTER_GATE', 'IF_GATE', '!IF_OPTION']);
assert(!semanticOption('IF_OPTION')?.depends.includes('!IF_OPTION'));
const trailingOption = semanticOption('TRAILING_OPTION');
assert.equal(trailingOption?.type, 'bool');
assert.deepEqual(trailingOption?.defaults, ['y']);
assert.deepEqual(trailingOption?.depends, ['OUTER_GATE', 'TRAILING_GATE']);
assert(!trailingOption?.depends.includes('TRAILING_VISIBLE'));
assert.equal(semantics.comments.length, 3);
assert(semantics.menus.some((row) => row.prompt === 'Nested menu' && row.directDepends.includes('NESTED_GATE')));
assert(semantics.menus.some((row) => row.prompt === 'Nested menu' && row.directVisibleIf.includes('NESTED_VISIBLE')));
assert.equal(semantics.validation.semantic.valid, true);
const semanticChoice = semantics.choices.find((row) => row.prompt === 'Choice');
assert.deepEqual(semanticChoice?.directDepends, ['CHOICE_GATE']);
assert.deepEqual(semanticOption('CHOICE_A')?.inheritedDepends, ['OUTER_GATE', 'CHOICE_GATE']);
assert.deepEqual(semanticOption('CHOICE_A')?.menuVisibleIf, ['OUTER_VISIBLE']);
assert.deepEqual(semanticOption('CHOICE_A')?.visibleIf, ['OUTER_VISIBLE', 'CHOICE_VISIBLE']);
assert.deepEqual(semanticOption('NESTED_CHOICE')?.inheritedDepends, ['OUTER_GATE', 'IF_GATE']);

// The eight Dropbear options and NASM are real-world regression cases for
// comment bleed and prompt-if handling.  Their warning comments are retained
// separately, while the options keep only their actual Kconfig relations.
const dropbear = parseKconfigTree(join(ROOT, 'tests', 'kconfig-dropbear'));
const dropbearSymbols = [
  'DROPBEAR_CHACHA20POLY1305', 'DROPBEAR_CLI_NETCAT', 'DROPBEAR_ECC_521',
  'DROPBEAR_ED25519', 'DROPBEAR_ENABLE_GCM_MODE', 'DROPBEAR_SHA2_512_HMAC',
  'DROPBEAR_SK_ED25519', 'DROPBEAR_SNTRUP761',
];
for (const symbol of dropbearSymbols) {
  const option = dropbear.allOptions.find((row) => row.symbol === symbol);
  assert(option, `missing Dropbear regression symbol: ${symbol}`);
  assert(!option.depends.some((expression) => expression.includes(`!${symbol}`)));
  assert(!option.depends.some((expression) => expression.includes(symbol) && expression.includes('= n')));
}
const nasm = dropbear.allOptions.find((row) => row.symbol === 'NASM');
assert.deepEqual(nasm?.depends, ['(i386 || x86_64)']);
assert.deepEqual(nasm?.promptIf, ['TOOLCHAINOPTS']);
assert(!nasm?.depends.includes('TOOLCHAINOPTS'));
assert.equal(dropbear.validation.semantic.valid, true);
assert.equal(dropbear.comments.length, 9);
const dropbearWarning = dropbear.comments.find((row) => row.prompt === 'KEX warning');
assert.deepEqual(dropbearWarning?.depends, ['PACKAGE_dropbear', '!DROPBEAR_CHACHA20POLY1305']);
assert(!dropbear.allOptions.find((row) => row.symbol === 'DROPBEAR_CHACHA20POLY1305')?.depends
  .includes('!DROPBEAR_CHACHA20POLY1305'));
assert.equal(lintKconfigOptions([{ symbol: 'SELF', type: 'bool', depends: ['!SELF'], defaults: ['y'] }]).valid, false);
assert.equal(lintKconfigOptions([{ symbol: 'SAFE', type: 'bool', depends: ['OTHER'], defaults: ['y'] }]).valid, true);

// Curated applications/groups and size aggregation remain generic data contracts.
const curated = policy.curatedApplications || [];
const activeGroups = activeCuratedGroups(policy.curatedGroups, curated);
const groupFixture = activeCuratedGroups(['alpha', 'empty', 'alpha', 'beta'], [{ group: 'beta' }, { group: 'alpha' }]);
assert.deepEqual(groupFixture, ['alpha', 'beta']);
assert.equal(activeGroups.length, policy.curatedGroups.length);
const curatedDocument = buildCuratedApplications(ROOT);
assert.deepEqual(curatedDocument.groups, activeGroups);
assert.equal(curatedDocument.items.length, curated.length);
assert(curatedDocument.items.every((row) => row.id && row.titleZh && row.usageZh));
assert.equal(new Set(curated.flatMap((row) => row.packages || [])).size,
  curated.reduce((count, row) => count + (row.packages?.length || 0), 0));

const opkg = parseOpkgPackages('Package: luci-app-demo\nSize: 100\nInstalled-Size: 250\nDepends: demo-lib (>= 1), +demo-data\n\n' +
  'Package: demo-lib\nSize: 20\n\nPackage: demo-data\nSize: 5\n');
const apk = parseApkDump({ packages: [
  { info: { name: 'luci-app-demo', file_size: 120, installed_size: 280, depends: ['demo-lib>=1'] } },
  { info: { name: 'demo-lib', file_size: 30, depends: [] } },
] });
assert.equal(opkg[0].installedSize, 250);
assert.equal(apk[0].installedSize, 280);
const sizeRows = buildCatalogSizeReport([{ source: { id: 'fixture', branch: 'test', commit: 'a'.repeat(40) },
  sizeReport: { legacy: { bytes: 1000 }, split: { initialBytes: 300, bytes: 700 }, readableRelationsJsonBytes: 10000, compactRelationsJsonBytes: 2500 } }]);
assert.equal(sizeRows[0].initialReductionPercent, 70);
assert.equal(sizeRows[0].relationsReductionPercent, 75);

// Compatibility v5 separates a global preventive applicability policy from exact evidence.
const normalizedCompatibility = normalizeCompatibilityDocument(compatibility, policy);
assert.equal(normalizedCompatibility.schema, 6);
assert.equal(normalizedCompatibility.rules.length, 8);
assert.equal(normalizedCompatibility.rules.find(rule => rule.id === 'OWN-0001')?.issue, 'file-ownership');
const preferredOwnershipRule = normalizedCompatibility.rules.find(rule => rule.id === 'OWN-0002');
assert.deepEqual(preferredOwnershipRule.preferredDisable, ['autosamba']);
assert.throws(() => normalizeCompatibilityDocument({ schema: 5, rules: [preferredOwnershipRule] }, policy), /preferredDisable/);
assert.throws(() => normalizeCompatibilityDocument({ schema: 6,
  rules: [{ ...preferredOwnershipRule, preferredDisable: ['unrelated-package'] }] }, policy), /participants/);
assert.throws(() => normalizeCompatibilityDocument({ schema: 1, rules: [] }, policy));
assert.equal(normalizeCompatibilityDocument({ schema: 2, rules: [] }, policy).schema, 2);
assert.equal(normalizeCompatibilityDocument({ schema: 3, rules: [] }, policy).schema, 3);
assert.equal(normalizeCompatibilityDocument({ schema: 4, rules: [] }, policy).schema, 4);
const dockerdRule = normalizedCompatibility.rules.find((rule) => rule.id === 'BLD-0003');
assert.equal(dockerdRule?.policy, 'preventive');
assert.deepEqual(dockerdRule?.environments, [{
  source: '*', branch: '*', packageAvailability: 'if-present', targetScope: {},
}]);
assert.equal(dockerdRule?.evidence?.[0]?.sourceCommit,
  '6081813a7ec91aba6555a74dc3f4d34f504f8a53');
assert.deepEqual(dockerdRule?.buildDependency, {
  package: 'dockerd',
});
assert.deepEqual(applicableBuildDependencies(normalizedCompatibility, {
  source: 'OpenWrt', branch: 'main', availablePackages: ['dockerd'],
}).packages, ['dockerd'], 'failed packages must come from the applicable reviewed rule');
assert.deepEqual(applicableBuildDependencies(normalizedCompatibility, {
  source: 'OpenWrt', branch: 'main', availablePackages: [],
}).packages, [], 'if-present rules must skip unavailable failed packages');
const pppoeRule = normalizedCompatibility.rules.find((rule) => rule.id === 'OWN-0003');
assert.deepEqual(pppoeRule.packages, ['luci-app-pppoe-server', 'rp-pppoe-server']);
assert.deepEqual(pppoeRule.preferredDisable, ['rp-pppoe-server']);
assert.equal(pppoeRule.match, 'all-installed');
assert.deepEqual(pppoeRule.environments.map(row => row.source), ['lede', 'ImmortalWrt', 'hanwckf']);
assert(pppoeRule.environments.every(row => row.branch === '*' && row.packageAvailability === 'if-present'));
assert.equal(normalizedCompatibility.rules.find((rule) => rule.id === 'BLD-0004'), undefined,
  'retired rule IDs must not be recycled for another failure');
const oafRule = normalizedCompatibility.rules.find((rule) => rule.id === 'BLD-0006');
assert.deepEqual(oafRule.packages, ['kmod-oaf']);
assert.deepEqual(oafRule.buildDependency, { package: 'kmod-oaf' });
assert.equal(oafRule.policy, 'preventive');
assert.equal(oafRule.sourceCommits, undefined, 'evidence commits must not restrict preventive applicability');
assert.deepEqual(oafRule.environments, [{ source: 'lede', branch: 'master', packageAvailability: 'if-present',
  targetScope: { system: ['x86'], subtarget: ['64'] } }]);
assert.deepEqual(oafRule.evidence.map(row => row.sourceCommit), [
  '6248ca158b90d640ece2c1a56c392cb0c430b665', 'bfec801a42f344bb7566d1f4f8960fb0cdb08350',
]);
assert.equal(oafRule.if, 'LINUX_6_18');
const oafDocument = { schema: 6, rules: [oafRule] };
const oafContext = { source: 'lede', branch: 'master', system: 'x86', subtarget: '64',
  upstreamCommit: 'f'.repeat(40), conditions: ['LINUX_6_18'], availablePackages: ['kmod-oaf'] };
assert.deepEqual(applicableBuildDependencies(oafDocument, oafContext).packages, ['kmod-oaf'],
  'reviewed preventive scope must survive an unrelated source commit change');
for (const overrides of [{ source: 'ImmortalWrt' }, { branch: 'stable' }, { system: 'armvirt' },
  { subtarget: '32' }, { conditions: [] }, { availablePackages: [] }]) {
  assert.deepEqual(applicableBuildDependencies(oafDocument, { ...oafContext, ...overrides }).packages, [],
    `preventive OAF scope must not expand: ${JSON.stringify(overrides)}`);
}
assert.equal(normalizedCompatibility.rules.find((rule) => rule.id === 'BLD-0005')?.failure?.phase,
  'rootfs-install');
assert.equal(dockerdRule.buildDependency.triggerPackages, undefined);

// Schema-4 build dependency evidence is strict, bounded by exact source commits,
// and unavailable to file-ownership or legacy schema-3 rules.
const rawDockerdRule = compatibility.rules.find((rule) => rule.id === 'BLD-0003');
const { policy: ignoredPolicy, environments: ignoredEnvironments, evidence: exactEvidence,
  ...legacyDockerdFields } = rawDockerdRule;
const legacyDockerdRule = {
  ...legacyDockerdFields,
  scope: { ImmortalWrt: ['openwrt-25.12'] },
  sourceCommits: exactEvidence.map((row) => row.sourceCommit),
  refs: [...new Set(exactEvidence.flatMap((row) => row.refs))],
};
const withBuildDependency = (buildDependency, overrides = {}) => ({
  ...legacyDockerdRule, ...overrides, buildDependency,
});
const packageOnlyBuildDependency = normalizeCompatibilityDocument({
  schema: 4, rules: [withBuildDependency({ package: 'dockerd' })],
}, policy);
assert.deepEqual(packageOnlyBuildDependency.rules[0].buildDependency, { package: 'dockerd' });
assert.throws(() => normalizeCompatibilityDocument({
  schema: 4, rules: [withBuildDependency({ package: 'dockerd', triggerPackages: ['docker'], extra: true })],
}, policy), /buildDependency contains unsupported field: extra/);
assert.throws(() => normalizeCompatibilityDocument({
  schema: 4, rules: [withBuildDependency({ package: 'dockerd', triggerPackages: ['docker'] }, { sourceCommits: undefined })],
}, policy), /buildDependency requires exact sourceCommits/);
assert.throws(() => normalizeCompatibilityDocument({
  schema: 4, rules: [withBuildDependency({ package: 'dockerd', triggerPackages: ['docker/compose'] })],
}, policy), /triggerPackages\[0\] must be a valid package ID/);
assert.throws(() => normalizeCompatibilityDocument({
  schema: 4, rules: [withBuildDependency({ package: 'not-dockerd', triggerPackages: ['docker'] })],
}, policy), /buildDependency\.package must be listed in the rule packages/);
assert.throws(() => normalizeCompatibilityDocument({
  schema: 4, rules: [withBuildDependency({ package: 'dockerd', triggerPackages: ['dockerd'] })],
}, policy), /triggerPackages must not include the failed package/);
assert.throws(() => normalizeCompatibilityDocument({
  schema: 4, rules: [{ ...compatibility.rules.find(rule => rule.id === 'OWN-0001'), buildDependency: { package: 'openvpn-openssl', triggerPackages: ['openvpn-openssl'] } }],
}, policy), /buildDependency is only valid for build-failure/);
assert.throws(() => normalizeCompatibilityDocument({
  schema: 3, rules: [withBuildDependency({ package: 'dockerd', triggerPackages: ['docker'] })],
}, policy), /contains unsupported field: buildDependency/);
const preventiveWithoutEvidence = structuredClone(rawDockerdRule);
delete preventiveWithoutEvidence.evidence;
assert.throws(() => normalizeCompatibilityDocument({
  schema: 5, rules: [preventiveWithoutEvidence],
}, policy), /evidence/);
const preventiveWithLegacyScope = structuredClone(rawDockerdRule);
preventiveWithLegacyScope.scope = { '*': ['*'] };
assert.throws(() => normalizeCompatibilityDocument({
  schema: 5, rules: [preventiveWithLegacyScope],
}, policy), /preventive policy uses environments and evidence/);

// Public translation and automation policy contracts.
assert.deepEqual(translations.policy?.languages, ['en', 'zh-CN', 'zh-TW', 'ru', 'es', 'pt', 'ja', 'ko', 'de', 'fr', 'vi']);
assert(translations.entries?.['PACKAGE_luci-app-samba4']?.usageZh);
assert(translations.entries?.['PACKAGE_luci-app-samba4']?.usageI18n?.de);
for (const label of ['Top level', 'General settings', 'Global build settings', 'LuCI']) {
  for (const language of ['zh-CN', 'zh-TW', 'ru', 'es', 'pt', 'ja', 'ko', 'de', 'fr', 'vi']) {
    assert(menuI18n[label]?.[language], `missing menu i18n: ${label}/${language}`);
  }
}
assert.equal(automation.schema, 1);
assert.equal(automation.probe?.collaboratorMaxParallel, 3);
assert.equal(automation.probe?.maxMatrixJobs, 256);
assert.equal(automation.probe?.normalizedEvidenceDays, 60);
assert.equal(automation.probe?.fullLogDays, 30);
assert.equal(automation.translation?.defaultDataBranch, 'catalog-candidate');
assert.equal(automation.translation?.batchSize, 500);
assert.equal(automation.translation?.batchCount, 5);
assert.equal(automation.translation?.totalItemLimit, 5000);
assert.equal(automation.translation?.totalTimeBudgetSeconds, 3000);
assert.equal(automation.catalog?.cloneAttempts, 3);

console.log(`catalog checks passed: ${targets.length} targets, ${packages.length} packages, ${(menu.options || []).length} visible / ${(menu.allOptions || menu.options).length} total Kconfig options`);
