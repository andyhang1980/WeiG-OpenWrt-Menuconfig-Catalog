#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTargetTree, incompleteSelectableTargets, parseInfoRecords, parseKconfigTree, parsePackageInfo, safeSlug,
  resolvePackageOption, targetBuildContract,
} from './lib.mjs';
import { buildKconfigRelations } from './kconfig-relations.mjs';
import { compactRelations, validateCompactRoundTrip } from './compact-relations.mjs';
import { encodeCompactRelationTables } from './relation-table-codec.mjs';
import { traceNativeKconfig, createNativeExpansionReplay } from './native-kconfig-preprocess.mjs';
import { measureJsonBytes } from './catalog-size-report.mjs';
import { captureCatalogInputs, catalogInputsHash } from './catalog-inputs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const key of ['source-id', 'repo', 'branch', 'tree']) {
  if (!args[key]) throw new Error(`缺少 --${key}`);
}
const tree = resolve(args.tree);
const outDir = resolve(args.out || join(ROOT, 'dist'));
const targetInfo = join(tree, 'tmp', '.targetinfo');
const packageInfo = join(tree, 'tmp', '.packageinfo');
const slug = `${safeSlug(args['source-id'])}--${safeSlug(args.branch)}`;
mkdirSync(outDir, { recursive: true });
let commit = '';
try { commit = execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
const buildInputs = args['feeds-runtime']
  ? captureCatalogInputs(tree, JSON.parse(readFileSync(args['feeds-runtime'], 'utf8'))) : null;
const source = {
  id: args['source-id'], label: args.label || args['source-id'],
  repo: args.repo, branch: args.branch,
  commit, legacy: args.legacy === 'true',
  ...(buildInputs ? { inputsHash: catalogInputsHash(buildInputs) } : {}),
};
const targets = parseInfoRecords(readFileSync(targetInfo, 'utf8'));
const packages = parsePackageInfo(readFileSync(packageInfo, 'utf8'));
let menu = parseKconfigTree(tree);
if (menu.validation.dynamicExpressions.length) {
  // Preserve the actual source locations before a native backend can reject
  // an unsupported dialect. A backend error alone hides the causal input.
  console.log('Native Kconfig expansion required:', JSON.stringify(menu.validation.dynamicExpressions.slice(0, 20)));
  const events = traceNativeKconfig(tree);
  menu = parseKconfigTree(tree, join(tree, 'Config.in'), {
    nativeReplay: createNativeExpansionReplay(tree, events),
  });
}
const allMenuOptions = menu.allOptions || menu.options;
const duplicateReport = {
  schema: 1,
  source,
  generatedAt: new Date().toISOString(),
  summary: {
    symbols: allMenuOptions.length,
    duplicateSymbols: menu.validation?.duplicates?.length || 0,
    duplicateNodes: menu.validation?.duplicateCount || 0,
    conflicts: menu.validation?.conflicts?.length || 0,
  },
  duplicates: menu.validation?.duplicates || [],
  conflicts: menu.validation?.conflicts || [],
};
writeFileSync(join(outDir, `${slug}.duplicates.json`), JSON.stringify(duplicateReport, null, 2) + '\n');
if (duplicateReport.summary.conflicts) {
  throw new Error(`Kconfig symbol merge conflicts: ${duplicateReport.conflicts
    .slice(0, 20).map((item) => item.symbol).join(', ')}`);
}
const kconfigSymbols = new Set(allMenuOptions.map((option) => option.symbol));
const translations = JSON.parse(readFileSync(join(ROOT, 'translations', 'zh-CN.json'), 'utf8'));
const menuI18n = JSON.parse(readFileSync(join(ROOT, 'translations', 'menu-i18n.json'), 'utf8'));
if (!targets.length || !allMenuOptions.length) {
  throw new Error(`目录异常:targets=${targets.length},menu options=${allMenuOptions.length}`);
}
for (const target of targets) {
  target.contract = targetBuildContract(target, kconfigSymbols);
  target.targetSelector = target.contract.targetSelector || '';
  const profileContracts = new Map((target.contract.profileContracts || []).map((item) => [item.id, item]));
  for (const profile of target.profiles) {
    const profileContract = profileContracts.get(profile.id);
    profile.selector = profileContract?.selector || '';
    profile.targetSelector = profileContract?.targetSelector || target.contract.targetSelector || '';
    profile.boardSelector = profileContract?.boardSelector || target.contract.boardSelector || '';
    profile.selectable = profileContract?.selectable !== false;
    profile.unavailableReason = profileContract?.reason || '';
  }
}
const selectableTargets = targets.filter((target) => target.contract.selectable);
const unavailableTargets = incompleteSelectableTargets(targets, kconfigSymbols);
const contractReport = {
  schema: 1, source, generatedAt: new Date().toISOString(),
  summary: {
    targets: targets.length, selectableTargets: selectableTargets.length,
    unavailableTargets: unavailableTargets.length,
    abstractTargets: targets.filter((target) => target.contract.kind === 'abstract').length,
  },
  unavailable: unavailableTargets.map((target) => ({
    target: target.id, board: target.board, subtarget: target.subtarget,
    profiles: target.contract.profiles, missing: target.contract.missing,
  })),
};
writeFileSync(join(outDir, `${slug}.contract.json`), JSON.stringify(contractReport, null, 2) + '\n');
if (!selectableTargets.length) {
  throw new Error(`No buildable Target/Profile contract: ${targets.slice(0, 20)
    .map((target) => `${target.id}[${target.contract.kind}]`).join(', ')}`);
}
const targetSymbols = new Set(['TARGET_BOARD', 'TARGET_SUBTARGET', 'TARGET_PROFILE']);
for (const target of targets) {
  if (target.contract.boardSelector) targetSymbols.add(target.contract.boardSelector);
  if (target.contract.targetSelector) targetSymbols.add(target.contract.targetSelector);
  for (const profile of target.profiles) {
    if (profile.targetSelector) targetSymbols.add(profile.targetSelector);
    if (profile.selector) targetSymbols.add(profile.selector);
  }
}
const relationOptions = allMenuOptions.filter((option) =>
  option.path[0] !== 'Target Devices' && !targetSymbols.has(option.symbol));
const relationOptionSet = new Set(relationOptions);

// Relations deliberately exclude Target Devices from the selectable graph,
// but expressions emitted by the native target/package metadata still refer
// to symbols in that filtered context. Keep only exact symbols that were
// actually parsed and then removed by this projection; an unresolved name in
// a generated file is not proof that a definition exists.
const externalSymbolSources = {};
const addExternalSymbol = (symbol, source) => {
  const name = String(symbol || '').trim();
  if (!name || ['n', 'm', 'y'].includes(name)) return;
  const rows = externalSymbolSources[name] || [];
  if (!rows.includes(source)) rows.push(source);
  externalSymbolSources[name] = rows;
};
for (const option of allMenuOptions) {
  if (!relationOptionSet.has(option)) addExternalSymbol(option.symbol, 'parsed-target-filter');
}
const menuOptions = relationOptions.filter((option) => option.visible !== false);
const pollutedDependencies = menuOptions.flatMap((option) =>
  (option.depends || []).filter((expression) =>
    /\s/.test(expression) && !/[&|=!<>]/.test(expression))
    .map((expression) => `${option.symbol}: ${expression}`));
if (pollutedDependencies.length) {
  throw new Error(`Kconfig 依赖疑似混入 help 正文:\n${pollutedDependencies.slice(0, 20).join('\n')}`);
}
const packageByName = new Map(packages.map((item) => [item.name, item]));
const catalogPolicy = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
const curatedCandidates = Array.isArray(catalogPolicy.curatedApplications)
  ? catalogPolicy.curatedApplications
  : [];
if (curatedCandidates.some((candidate) => !candidate || typeof candidate !== 'object' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(String(candidate.id || '')) ||
    !Array.isArray(candidate.packages) || candidate.packages.length === 0 ||
    candidate.packages.some((name) => !/^luci-app-[A-Za-z0-9_.+@-]+$/.test(String(name || ''))))) {
  throw new Error('catalog.config.json curatedApplications must use {id, packages:[luci-app-*],group} objects');
}
const packageSymbols = new Set(allMenuOptions
  .filter((option) => option.symbol.startsWith('PACKAGE_') && packageByName.has(option.symbol.slice('PACKAGE_'.length)))
  .map((option) => option.symbol.slice('PACKAGE_'.length)));
const curatedByPackage = new Map(curatedCandidates.flatMap((candidate) =>
  (candidate.packages || []).map((packageName) => [packageName, candidate])));
const luciApplicationOptions = allMenuOptions.filter((option) =>
  /^PACKAGE_luci-app-[A-Za-z0-9_.+@-]+$/.test(String(option.symbol || '')) &&
  packageSymbols.has(option.symbol.slice('PACKAGE_'.length)))
  .sort((a, b) => a.symbol.localeCompare(b.symbol));
const applicationRows = luciApplicationOptions.map((option) => {
  const packageName = option.symbol.slice('PACKAGE_'.length);
  const curated = curatedByPackage.get(packageName);
  const path = (option.path || []).map((part) => String(part || '').trim()).filter(Boolean);
  const luciIndex = path.findIndex((part) => /^luci$/i.test(part));
  const derivedGroup = path[luciIndex + 1] || path.at(-1) || 'Applications';
  return [option.symbol, packageName, curated?.group || derivedGroup, curated?.hot === true ? 1 : 0];
});
const branchApplications = {
  schema: 1,
  kind: 'branch-applications',
  encoding: 'positional-rows-v1',
  fields: ['symbol', 'package', 'group', 'hot'],
  rows: applicationRows,
};
const resolveCandidate = (candidate) => resolvePackageOption(candidate, packageSymbols);
const candidateRows = curatedCandidates.map((candidate) => {
  const packageName = resolveCandidate(candidate);
  return {
    id: candidate.id,
    packages: [...candidate.packages],
    package: packageName,
    available: Boolean(packageName),
  };
});
const luciApplications = applicationRows.map((row) => row[1]);
const candidateReport = {
  schema: 1, source, generatedAt: new Date().toISOString(),
  curated: candidateRows,
  available: candidateRows.filter((item) => item.available).map((item) => item.package),
  missing: candidateRows.filter((item) => !item.available).map((item) => item.id),
  applications: { count: luciApplications.length, unique: [...new Set(luciApplications)].length, names: luciApplications },
};
writeFileSync(join(outDir, `${slug}.curated-candidates.json`), JSON.stringify(candidateReport, null, 2) + '\n');
const promptTranslations = translations.prompts || {};
const entryTranslations = translations.entries || {};
const translatedOptions = menuOptions.map((option) => {
  const packageName = option.symbol.startsWith('PACKAGE_') ? option.symbol.slice(8) : '';
  const packageRow = packageByName.get(packageName);
  // Keep package conflicts as concrete package/capability names.  A bare
  // Provides/Conflicts entry may be a virtual capability (for example
  // libudev); mechanically prefixing it creates the invalid CONFIG_PACKAGE_
  // identity PACKAGE_libudev.  The typed relations asset carries provider
  // resolution for consumers while this presentation payload stays raw.
  const conflicts = [...(packageRow?.conflicts || [])];
  const translated = entryTranslations[option.symbol] || {};
  const promptRow = promptTranslations[option.prompt] || {};
  return {
    ...option,
    conflicts,
    promptEn: packageRow?.title || option.prompt,
    promptZh: translated.titleZh || promptRow.titleZh || '',
    promptI18n: translated.titleI18n || {},
    usageEn: packageRow?.description || option.help || translated.usageEn || promptRow.usageEn || '',
    usageZh: translated.usageZh || promptRow.usageZh || '',
    usageI18n: translated.usageI18n || {},
    translationSource: translated.source || (promptRow.titleZh ? 'Catalog glossary' : ''),
  };
});
const relations = buildKconfigRelations(relationOptions, packages, menu.choices, {
  // The parser report is a data-support matrix, not an evaluator result. The
  // relation builder checks it together with source/graph diagnostics; the
  // compact serializer independently proves the readable round-trip below.
  parserValidation: menu.validation,
  // A projected symbol table must not truncate native choice membership.
  // External members are resolved by the exact Native Profile context.
  choiceOptions: allMenuOptions,
  externalSymbols: Object.keys(externalSymbolSources),
  externalSymbolSources,
});
if (!relations.validation.structurallyValid) {
  throw new Error(`Invalid Kconfig relation structure: ${JSON.stringify({
    invalidChoices: relations.validation.invalidChoices,
    unsupportedDirectives: relations.validation.unsupportedDirectives,
    structuralErrors: relations.validation.structuralErrors,
  })}`);
}
const menuPathNames = [...new Set(menuOptions.flatMap((option) => option.path || []))];
const menuLabels = Object.fromEntries(menuPathNames.map((name) => [
  name,
  {
    en: name,
    zhCN: promptTranslations[name]?.titleZh || '',
    i18n: menuI18n[name] || {},
    usageEn: promptTranslations[name]?.usageEn || '',
    usageZh: promptTranslations[name]?.usageZh || '',
  },
]));
const choiceIds = new Set(menuOptions.map((option) => option.choice).filter(Boolean));
const compactMenu = {
  categories: menu.categories.filter((name) => name !== 'Target Devices'),
  labels: menuLabels,
  options: translatedOptions,
  choices: menu.choices.filter((choice) => choiceIds.has(choice.id)).map((choice) => {
    const row = promptTranslations[choice.prompt] || {};
    return {
      ...choice,
      promptEn: choice.prompt,
      promptZh: row.titleZh || '',
      promptI18n: menuI18n[choice.prompt] || {},
      usageEn: row.usageEn || '',
      usageZh: row.usageZh || '',
      usageI18n: {},
    };
  }),
};
const targetTree = buildTargetTree(selectableTargets, allMenuOptions);
const targetSelectors = [
  { id: 'system', labelEn: 'Target System', labelZh: '目标系统' },
  { id: 'subtarget', labelEn: 'Subtarget', labelZh: '子目标' },
  { id: 'profile', labelEn: 'Target Profile', labelZh: '目标配置' },
];
const missingTranslations = translatedOptions.filter((item) => !item.promptZh).map((item) => ({
  symbol: item.symbol, promptEn: item.promptEn || item.prompt, path: item.path,
}));
const missingMenuTranslations = menuPathNames.filter((name) => !promptTranslations[name]?.titleZh);
const missingChoiceTranslations = compactMenu.choices.filter((choice) => !choice.promptZh)
  .map((choice) => ({ id: choice.id, promptEn: choice.promptEn || choice.prompt }));
const translationReport = {
  schema: 1,
  source: { id: args['source-id'], branch: args.branch },
  generatedAt: new Date().toISOString(),
  languages: ['en', 'zh-CN', 'zh-TW', 'ru', 'es', 'pt', 'ja', 'ko', 'de', 'fr', 'vi'],
  options: translatedOptions.length,
  translatedZhCN: translatedOptions.length - missingTranslations.length,
  missingZhCN: missingTranslations,
  missingMenusZhCN: missingMenuTranslations,
  missingChoicesZhCN: missingChoiceTranslations,
};
const generatedAt = new Date().toISOString();
const payload = {
  schema: 5,
  capabilities: [
    'hidden-kconfig-symbols',
    'dependency-expressions-v2',
    'reverse-dependencies-v1',
    'source-commit-contract-v1',
  ],
  engine: { minimumVersion: 1 },
  generatedAt,
  source,
  validation: {
    symbolsUnique: true,
    duplicateSymbols: duplicateReport.summary.duplicateSymbols,
    duplicateNodes: duplicateReport.summary.duplicateNodes,
    duplicateReport: `${slug}.duplicates.json`,
    curatedCandidatesReport: `${slug}.curated-candidates.json`,
  },
  counts: {
    targets: targets.length,
    selectableTargets: selectableTargets.length,
    unavailableTargets: unavailableTargets.length,
    abstractTargets: targets.filter((target) => target.contract.kind === 'abstract').length,
    profiles: selectableTargets.reduce((n, item) => n + item.profiles.length, 0),
    menuOptions: compactMenu.options.length, hiddenMenuOptions: relationOptions.length - compactMenu.options.length,
    packages: packages.length,
    applications: branchApplications.rows.length,
    translatedZhCN: translationReport.translatedZhCN,
    missingZhCN: missingTranslations.length,
  },
  targetSelectors,
  targetTree,
  targets,
  menu: compactMenu,
  relations,
  translation: {
    languages: translationReport.languages,
    fallback: 'en',
    translatedZhCN: translationReport.translatedZhCN,
    missingZhCN: missingTranslations.length,
  },
  applications: branchApplications,
};

function summarizeText(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
function writeGzipAsset(logical, filename, value) {
  const json = JSON.stringify(value);
  const compressed = gzipSync(Buffer.from(json), { level: 9 });
  writeFileSync(join(outDir, filename), compressed);
  return {
    logical,
    asset: filename,
    hash: createHash('sha256').update(compressed).digest('hex'),
    bytes: compressed.byteLength,
    sha256: createHash('sha256').update(json).digest('hex'),
    jsonBytes: Buffer.byteLength(json),
  };
}

// Complete Kconfig relations are a publish-time contract. The readable graph
// must pass parser/data diagnostics and the compact serializer must independently
// prove a field-preserving round-trip before any legacy or schema-6 asset is
// written. Package closure is intentionally checked and advertised separately.
const compact = compactRelations(relations);
const relationCompleteness = {
  relationsComplete: compact.relationsComplete === true,
  relationCapability: compact.relationCapabilities?.includes('complete-kconfig-relations-v1') === true,
  roundTripValidated: compact.roundTripValidated === true,
  capabilityMatrixComplete: relations.validation?.capabilityMatrixComplete === true,
  parserFixtureValidated: relations.validation?.parserFixtureValidated === true,
  unsupportedDirectives: relations.validation?.unsupportedDirectives || [],
  structuralErrors: relations.validation?.structuralErrors || [],
  kconfigUnknownRelations: relations.validation?.kconfigUnknownRelations || [],
  roundTripErrors: compact.validation?.compactExpandValidation || [],
};
if (!relationCompleteness.relationsComplete || !relationCompleteness.relationCapability ||
    !relationCompleteness.roundTripValidated || !relationCompleteness.capabilityMatrixComplete ||
    !relationCompleteness.parserFixtureValidated || relationCompleteness.unsupportedDirectives.length ||
    relationCompleteness.structuralErrors.length || relationCompleteness.kconfigUnknownRelations.length ||
    relationCompleteness.roundTripErrors.length) {
  throw new Error(`Kconfig relations completeness contract failed: ${JSON.stringify(relationCompleteness)}`);
}

// Keep the schema-5 single bundle during the migration window. Schema-6 consumers
// use the split assets below and never download menu/help data before Advanced opens.
const legacyJson = JSON.stringify(payload);
const asset = `${slug}.json.gz`;
const legacyCompressed = gzipSync(Buffer.from(legacyJson), { level: 9 });
writeFileSync(join(outDir, asset), legacyCompressed);

const corePayload = {
  schema: 6,
  capabilities: [
    ...payload.capabilities,
    'compact-relations-v4',
    ...(compact.relationsComplete === true ? ['complete-kconfig-relations-v1'] : []),
    ...(compact.packageClosureComplete === true ? ['complete-package-build-closure-v1'] : []),
    'split-catalog-assets-v1',
    'lazy-menu-v1',
    'branch-applications-v1',
    'package-sizes-v1',
  ],
  engine: payload.engine,
  generatedAt,
  source,
  validation: payload.validation,
  counts: payload.counts,
  targetSelectors,
  targetTree,
  targets,
  applications: branchApplications,
  translation: payload.translation,
};
const graphPayload = {
  schema: 6, kind: 'graph', generatedAt, source,
  relationsComplete: compact.relationsComplete === true,
  capabilityMatrixComplete: compact.validation?.capabilityMatrixComplete === true,
  roundTripValidated: compact.roundTripValidated === true,
  relationCapabilities: compact.relationCapabilities || [],
  packageClosureComplete: compact.packageClosureComplete === true,
  packageClosureCapabilities: compact.packageClosureCapabilities || [],
  packageClosureValidation: compact.packageClosureValidation || {},
  relations: compact,
};
const compactTables = encodeCompactRelationTables(compact);
const compactTableProof = validateCompactRoundTrip(relations, compactTables);
if (!compactTableProof.valid) throw new Error(`Compact relation table mismatch: ${JSON.stringify(compactTableProof.reasons)}`);
const menuPayload = {
  schema: 1,
  kind: 'menu',
  generatedAt,
  source,
  categories: compactMenu.categories,
  labels: Object.fromEntries(Object.entries(compactMenu.labels).map(([name, row]) => [name, {
    en: row.en || name,
    usageEn: summarizeText(row.usageEn),
  }])),
  options: translatedOptions.map((option) => ({
    symbol: option.symbol,
    kind: option.kind,
    prompt: option.prompt,
    promptEn: option.promptEn,
    usageEn: summarizeText(option.usageEn || option.help),
    path: option.path || [],
    parent: option.parent || '',
    choice: option.choice || '',
    translationSource: option.translationSource || '',
  })),
  choices: compactMenu.choices.map((choice) => ({
    id: choice.id,
    prompt: choice.prompt,
    promptEn: choice.promptEn || choice.prompt,
    usageEn: summarizeText(choice.usageEn),
    defaults: choice.defaults || [],
    optional: choice.optional === true,
  })),
};
const visibleSymbols = new Set(translatedOptions.map((option) => option.symbol));
const hiddenPayload = {
  schema: 1,
  kind: 'hidden',
  generatedAt,
  source,
  options: relations.records.filter((record) => !visibleSymbols.has(record.configSymbol)).map((record) => ({
    symbol: record.configSymbol,
    promptEn: record.title || record.prompt || record.package || record.configSymbol,
    usageEn: summarizeText(record.description),
    path: record.path || [],
    parent: record.parent || '',
    origin: record.origin || '',
  })),
};
const helpPayload = {
  schema: 1,
  kind: 'help',
  generatedAt,
  source,
  options: translatedOptions.filter((option) => option.help || option.usageEn || option.usageZh ||
    Object.keys(option.usageI18n || {}).length).map((option) => ({
    symbol: option.symbol,
    en: option.usageEn || option.help || '',
    zhCN: option.usageZh || '',
    i18n: option.usageI18n || {},
  })),
};
const languagePayloads = Object.fromEntries(translationReport.languages.filter((lang) => lang !== 'en').map((lang) => [lang, {
  schema: 1,
  kind: 'menu-language',
  language: lang,
  generatedAt,
  source,
  options: translatedOptions.map((option) => {
    const title = lang === 'zh-CN' ? option.promptZh : option.promptI18n?.[lang];
    const usage = lang === 'zh-CN' ? option.usageZh : option.usageI18n?.[lang];
    return title || usage ? [option.symbol, title || '', usage || ''] : null;
  }).filter(Boolean),
  labels: Object.entries(compactMenu.labels).map(([name, row]) => {
    const title = lang === 'zh-CN' ? row.zhCN : row.i18n?.[lang];
    const usage = lang === 'zh-CN' ? row.usageZh : row.usageI18n?.[lang];
    return title || usage ? [name, title || '', usage || ''] : null;
  }).filter(Boolean),
  choices: compactMenu.choices.map((choice) => {
    const title = lang === 'zh-CN' ? choice.promptZh : choice.promptI18n?.[lang];
    const usage = lang === 'zh-CN' ? choice.usageZh : choice.usageI18n?.[lang];
    return title || usage ? [choice.id, title || '', usage || ''] : null;
  }).filter(Boolean),
}]));

function packageSizeDocument() {
  let sample = null;
  const samplePath = args['size-sample'] ? resolve(args['size-sample']) : '';
  if (samplePath && existsSync(samplePath)) {
    try { sample = JSON.parse(readFileSync(samplePath, 'utf8')); } catch { sample = null; }
  }
  const exact = sample?.source === source.id && sample?.branch === source.branch && sample?.available === true;
  const observed = new Map((exact && Array.isArray(sample.packages) ? sample.packages : [])
    .filter((row) => row && typeof row.name === 'string')
    .map((row) => [row.name, row]));
  const names = [...packageSymbols].sort((a, b) => a.localeCompare(b));
  const rows = names.flatMap((name) => {
    const row = observed.get(name);
    if (!row || !Number.isSafeInteger(Number(row.size)) || Number(row.size) < 0) return [];
    const installed = Number(row.installedSize);
    return [[name, Number(row.size), Number.isSafeInteger(installed) && installed > 0 ? installed : null]];
  });
  return {
    schema: 1,
    kind: 'package-sizes',
    encoding: 'positional-rows-v1',
    fields: ['package', 'archiveBytes', 'installedBytes'],
    metric: {
      archiveBytes: 'compressed package archive bytes',
      installedBytes: 'installed bytes when published by the package index',
    },
    generatedAt,
    source,
    observation: exact ? {
      generatedAt: sample.generatedAt || '',
      architecture: sample.architecture || '',
      format: sample.format || '',
      baseUrl: sample.baseUrl || '',
      match: 'exact-source-branch',
    } : {
      architecture: '',
      match: 'unavailable',
      reason: sample?.reason || 'no-exact-official-index-observation',
    },
    coverage: { known: rows.length, total: names.length, unknown: names.length - rows.length },
    rows,
  };
}
const packageSizesPayload = packageSizeDocument();

const assets = {};
for (const contract of [
  writeGzipAsset('core', `${slug}.core.json.gz`, corePayload),
  writeGzipAsset('graph', `${slug}.graph.json.gz`, graphPayload),
  // Keep the old graph contract for already-deployed consumers. New readers
  // choose the independently hashed compact representation of the same data.
  writeGzipAsset('graphCompact', `${slug}.graph.compact.json.gz`, {
    ...graphPayload, relations: compactTables,
  }),
  writeGzipAsset('menu', `${slug}.menu.json.gz`, menuPayload),
  writeGzipAsset('hidden', `${slug}.hidden.json.gz`, hiddenPayload),
  writeGzipAsset('help', `${slug}.help.json.gz`, helpPayload),
]) assets[contract.logical] = contract;
const packageSizesContract = writeGzipAsset('packageSizes', `${slug}.package-sizes.json.gz`, packageSizesPayload);
Object.assign(packageSizesContract, {
  schema: packageSizesPayload.schema,
  kind: packageSizesPayload.kind,
  items: packageSizesPayload.rows.length,
  totalPackages: packageSizesPayload.coverage.total,
  architecture: packageSizesPayload.observation.architecture || '',
});
assets.packageSizes = packageSizesContract;
for (const [lang, value] of Object.entries(languagePayloads)) {
  const logical = `menu:${lang}`;
  assets[logical] = writeGzipAsset(logical, `${slug}.menu.${safeSlug(lang)}.json.gz`, value);
}
writeFileSync(join(outDir, `${slug}.relations.json.gz`), gzipSync(Buffer.from(JSON.stringify({
  schema: compact.schema,
  source,
  generatedAt,
  relations: compact,
})), { level: 9 }));
if (process.env.CATALOG_DEBUG_RELATIONS === 'true') {
  // This optional diagnostic keeps readable field names, but not indentation:
  // deeply nested ASTs can inflate pretty JSON past the engine string limit.
  // Runtime assets already use this same compact JSON whitespace convention.
  writeFileSync(join(outDir, `${slug}.relations.debug.json.gz`), gzipSync(Buffer.from(JSON.stringify({
    schema: relations.schema, source, generatedAt,
    summary: relations.summary, validation: relations.validation,
    indexes: relations.indexes, records: relations.records,
  }) + '\n'), { level: 9 }));
}
writeFileSync(join(outDir, `${slug}.translations.json`), JSON.stringify(translationReport, null, 2) + '\n');
const legacyContract = {
  asset,
  hash: createHash('sha256').update(legacyCompressed).digest('hex'),
  bytes: legacyCompressed.byteLength,
  catalogSchema: Number(payload.schema || 0),
  relationsSchema: Number(payload.relations?.schema || 0),
};
writeFileSync(join(outDir, `${slug}.meta.json`), JSON.stringify({
  schema: 6,
  source: payload.source,
  ...(buildInputs ? { buildInputs } : {}),
  counts: payload.counts,
  // Root fields remain mirrored during the schema-6 migration for old consumers.
  asset: legacyContract.asset,
  generatedAt,
  commit: payload.source.commit,
  hash: legacyContract.hash,
  sha256: createHash('sha256').update(legacyJson).digest('hex'),
  bytes: legacyContract.bytes,
  jsonBytes: Buffer.byteLength(legacyJson),
  legacy: legacyContract,
  assets,
  sizeReport: {
    legacy: { bytes: legacyCompressed.byteLength, jsonBytes: Buffer.byteLength(legacyJson) },
    split: {
      bytes: Object.values(assets).reduce((sum, item) => sum + item.bytes, 0),
      initialBytes: assets.core.bytes + assets.graph.bytes,
      graphJsonBytes: assets.graph.jsonBytes,
    },
    readableRelationsJsonBytes: measureJsonBytes(relations, 2) + 1,
    compactRelationsJsonBytes: measureJsonBytes(compact),
  },
}, null, 2) + '\n');
console.log(`${asset}: ${payload.counts.selectableTargets}/${targets.length} selectable targets / ` +
  `${payload.counts.profiles} profiles / ${compactMenu.options.length} menu options / ${packages.length} packages` +
  ` / schema6 initial ${assets.core.bytes + assets.graph.bytes} bytes` +
  (unavailableTargets.length ? ` / unavailable contracts: ${unavailableTargets.length}` : ''));
