import { KCONFIG_RELATION_CAPABILITIES, parseKconfigExpression, splitKconfigIfClause } from './lib.mjs';
import { decodeCompactRelationTables } from './relation-table-codec.mjs';

const TYPE_CODES = Object.freeze({ '': 0, bool: 1, tristate: 2, string: 3, int: 4, hex: 5 });
const TYPES = Object.freeze(['', 'bool', 'tristate', 'string', 'int', 'hex']);
const ORIGIN_CODES = Object.freeze({
  '': 0,
  'kconfig-only': 1,
  'kconfig+packageinfo': 2,
  'hidden-kconfig-only': 3,
  'hidden-kconfig+packageinfo': 4,
  'packageinfo-only': 5,
});
const ORIGINS = Object.freeze([
  '', 'kconfig-only', 'kconfig+packageinfo', 'hidden-kconfig-only',
  'hidden-kconfig+packageinfo', 'packageinfo-only',
]);
const VALUE_KIND_CODES = Object.freeze({ literal: 1, expression: 2, unknown: 3 });
const VALUE_KINDS = Object.freeze(['', 'literal', 'expression', 'unknown']);
const FLAG_VISIBLE = 1;
const FLAG_USER_SETTABLE = 2;
const FLAG_CAN_DISABLE = 4;
const FLAG_HAS_KCONFIG = 8;
const FLAG_PACKAGE = 16;
const FLAG_MODULES = 32;
const FLAG_OPTIONAL = 64;

function pool() {
  const values = [];
  const indexes = new Map();
  return {
    values,
    id(value) {
      const text = String(value ?? '');
      if (!indexes.has(text)) {
        indexes.set(text, values.length);
        values.push(text);
      }
      return indexes.get(text);
    },
  };
}

function tablePool() {
  const values = [];
  const indexes = new Map();
  return {
    values,
    id(value) {
      const key = JSON.stringify(value);
      if (!indexes.has(key)) {
        indexes.set(key, values.length);
        values.push(value);
      }
      return indexes.get(key);
    },
  };
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function statesMask(states = []) {
  return (states.includes('n') ? 1 : 0) | (states.includes('m') ? 2 : 0) | (states.includes('y') ? 4 : 0);
}

function statesFromMask(mask) {
  return ['n', 'm', 'y'].filter((_, index) => mask & (1 << index));
}

function parseDefault(raw) {
  const { value, condition } = splitKconfigIfClause(raw);
  return [value, condition];
}

function expressionVariants(record, key) {
  const rows = record.kconfig?.[`${key}Expressions`] || record.kconfig?.[`${key}Variants`] || [];
  return array(rows).map((row) => array(row).map(String));
}

function stringListId(values, strings, lists) {
  return lists.id(array(values).map((value) => strings.id(value)));
}

function expressionId(value, expressions) {
  return value ? expressions.id(value) : -1;
}

function expressionVariantsId(record, key, strings, expressions, expressionLists, variants) {
  return variants.id(expressionVariants(record, key).map((row) =>
    expressionLists.id(row.map((value) => expressions.id(value)))));
}

function normalizedTypedDefault(row, fallbackType, strings, expressions) {
  // Empty type is explicit provenance of an untyped definition, not missing
  // data. A later definition may type the symbol, but compression must not
  // rewrite the earlier typed row with the merged symbol type.
  const type = String(row?.type ?? fallbackType ?? '');
  const valueKind = String(row?.valueKind || 'unknown');
  return {
    typeCode: TYPE_CODES[type] ?? 0,
    value: row?.value === undefined ? String(row?.raw ?? '') : row.value,
    rawId: strings.id(row?.raw ?? ''),
    conditionId: expressionId(row?.condition || '', expressions),
    valueKindCode: VALUE_KIND_CODES[valueKind] || 0,
    valid: row?.valid === false ? false : true,
    precise: row?.precise === false ? false : true,
  };
}

function normalizedTypedRange(row, fallbackType, strings, expressions) {
  const type = String(row?.type ?? fallbackType ?? '');
  return {
    typeCode: TYPE_CODES[type] ?? 0,
    min: row?.min === undefined ? String(row?.minRaw ?? '') : row.min,
    max: row?.max === undefined ? String(row?.maxRaw ?? '') : row.max,
    minRawId: strings.id(row?.minRaw ?? ''),
    maxRawId: strings.id(row?.maxRaw ?? ''),
    rawId: strings.id(row?.raw ?? ''),
    conditionId: expressionId(row?.condition || '', expressions),
    minKindCode: VALUE_KIND_CODES[row?.minKind] || 0,
    maxKindCode: VALUE_KIND_CODES[row?.maxKind] || 0,
    valid: row?.valid === false ? false : true,
  };
}

function normalizeDefinition(node) {
  const expressionAsts = (values) => array(values).map((value) => value?.ast ? value : parseKconfigExpression(value));
  const dependsAsts = array(node?.dependsAst).length ? node.dependsAst : node?.depends;
  return {
    kind: node?.kind || '', type: node?.type || '', symbol: node?.symbol || '', prompt: node?.prompt || '',
    path: array(node?.path), parent: node?.parent || '', depends: array(node?.depends), directDepends: array(node?.directDepends),
    inheritedDepends: array(node?.inheritedDepends), directVisibleIf: array(node?.directVisibleIf),
    inheritedVisibleIf: array(node?.inheritedVisibleIf), inheritedMenuVisibleIf: array(node?.inheritedMenuVisibleIf),
    visibleIf: array(node?.visibleIf), menuVisibleIf: array(node?.menuVisibleIf), promptIf: array(node?.promptIf),
    dependsAst: expressionAsts(dependsAsts), directDependsAst: expressionAsts(node?.directDependsAst || node?.directDepends),
    inheritedDependsAst: expressionAsts(node?.inheritedDependsAst || node?.inheritedDepends),
    selectRelations: array(node?.selectRelations),
    implyRelations: array(node?.implyRelations),
    promptIfAst: expressionAsts(node?.promptIf), visibleIfAst: expressionAsts(node?.visibleIf),
    menuVisibleIfAst: expressionAsts(node?.menuVisibleIf), directVisibleIfAst: expressionAsts(node?.directVisibleIf),
    inheritedVisibleIfAst: expressionAsts(node?.inheritedVisibleIf),
    inheritedMenuVisibleIfAst: expressionAsts(node?.inheritedMenuVisibleIf),
    defaults: array(node?.defaults), defaultsTyped: array(node?.defaultsTyped), selects: array(node?.selects),
    implies: array(node?.implies), ranges: array(node?.ranges), rangesTyped: array(node?.rangesTyped),
    options: array(node?.options), optionFlags: array(node?.optionFlags), modules: node?.modules === true,
    optional: node?.optional === true, choice: node?.choice || '', help: node?.help || '',
    kconfigConflicts: array(node?.kconfigConflicts), packageConflicts: array(node?.packageConflicts),
    source: node?.source || '', location: node?.location || null,
  };
}

function normalizeCapabilityRelation(row) {
  return {
    raw: row?.raw ?? '', name: row?.name ?? '', kind: row?.kind || 'unknown',
    providers: array(row?.providers), effectiveProviders: array(row?.effectiveProviders),
    ownerSelf: row?.ownerSelf === true,
  };
}

function normalizeAlternativeBranches(value) {
  const rows = array(value);
  if (!rows.length) return [];
  // Older readable callers supplied a flat string list. Preserve it as one
  // branch while schema-4 producers use the nested lossless form.
  if (rows.every((item) => typeof item === 'string')) return [rows];
  return rows.map((branch) => array(branch).map(String).filter(Boolean)).filter((branch) => branch.length);
}

function normalizeEdge(edge, strings, expressions, stringLists, expressionAsts, alternativeLists) {
  const alternatives = normalizeAlternativeBranches(edge?.alternatives);
  return {
    fromId: strings.id(edge?.from || ''), toId: strings.id(edge?.to || ''),
    relationId: strings.id(edge?.relation || ''), conditionId: expressionId(edge?.condition || '', expressions),
    expressionId: expressionId(edge?.expression || '', expressions),
    expressionAstId: edge?.expressionAst ? expressionAsts.id(edge.expressionAst) : -1,
    conditionAstId: edge?.conditionAst ? expressionAsts.id(edge.conditionAst) : -1,
    required: edge?.required === undefined || edge?.required === null ? null : edge.required === true,
    kindId: strings.id(edge?.kind || ''),
    alternativesId: alternativeLists.id(alternatives.map((branch) => stringListId(branch, strings, stringLists))),
    providersId: stringListId(edge?.providers || [], strings, stringLists),
    ownerSelf: edge?.ownerSelf === true,
  };
}

function encodeStringIndex(object, strings, lists) {
  return Object.entries(object || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [
    strings.id(key), lists.id(array(rows).map((item) => strings.id(item))),
  ]);
}

function encodeNumberIndex(object, lists) {
  return Object.entries(object || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [
    key, lists.id(array(rows).map(Number)),
  ]);
}

function encodeRecordIndex(object, strings) {
  return Object.entries(object || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [
    strings.id(key), Number(value),
  ]);
}

function decodeStringList(id, strings, lists) {
  return id < 0 ? [] : (lists[id] || []).map((item) => strings[item] || '');
}

function decodeAlternativeBranches(id, strings, stringLists, alternativeLists) {
  if (id < 0) return [];
  return (alternativeLists?.[id] || []).map((listId) => decodeStringList(listId, strings, stringLists));
}

function decodeExpressionRows(id, expressions, expressionLists, variants) {
  return id < 0 ? [] : (variants[id] || []).map((listId) =>
    (expressionLists[listId] || []).map((item) => expressions[item] || ''));
}

function decodeStringIndex(rows, strings, lists) {
  return Object.fromEntries((rows || []).map(([keyId, listId]) => [
    strings[keyId] || '', decodeStringList(listId, strings, lists),
  ]));
}

function decodeNumberIndex(rows, lists = []) {
  return Object.fromEntries((rows || []).map(([key, listId]) => [key, (lists[listId] || []).map(Number)]));
}

function decodeRecordIndex(rows, strings) {
  return Object.fromEntries((rows || []).map(([keyId, value]) => [strings[keyId] || '', Number(value)]));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function pick(object, fields) {
  return Object.fromEntries(fields.map((field) => [field, object?.[field]]).filter(([, value]) => value !== undefined));
}

const ROUND_TRIP_DIFF_LIMIT = 8;
const ROUND_TRIP_VALUE_LIMIT = 320;

function summarizeDifferenceValue(value) {
  if (value === undefined) return '<undefined>';
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  if (text === undefined) text = String(value);
  return text.length > ROUND_TRIP_VALUE_LIMIT
    ? `${text.slice(0, ROUND_TRIP_VALUE_LIMIT)}…`
    : text;
}

function collectStructuralDifferences(expected, actual, path = '$', differences = []) {
  if (differences.length >= ROUND_TRIP_DIFF_LIMIT || Object.is(expected, actual)) return differences;
  const expectedArray = Array.isArray(expected);
  const actualArray = Array.isArray(actual);
  if (expectedArray || actualArray) {
    if (!expectedArray || !actualArray) {
      differences.push({ path, expected: summarizeDifferenceValue(expected), actual: summarizeDifferenceValue(actual) });
      return differences;
    }
    if (expected.length !== actual.length) {
      differences.push({ path: `${path}.length`, expected: expected.length, actual: actual.length });
    }
    for (let index = 0; index < Math.max(expected.length, actual.length) && differences.length < ROUND_TRIP_DIFF_LIMIT; index += 1) {
      collectStructuralDifferences(expected[index], actual[index], `${path}[${index}]`, differences);
    }
    return differences;
  }
  const expectedObject = expected && typeof expected === 'object';
  const actualObject = actual && typeof actual === 'object';
  if (expectedObject || actualObject) {
    if (!expectedObject || !actualObject) {
      differences.push({ path, expected: summarizeDifferenceValue(expected), actual: summarizeDifferenceValue(actual) });
      return differences;
    }
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      if (differences.length >= ROUND_TRIP_DIFF_LIMIT) break;
      collectStructuralDifferences(expected[key], actual[key], `${path}.${key}`, differences);
    }
    return differences;
  }
  differences.push({ path, expected: summarizeDifferenceValue(expected), actual: summarizeDifferenceValue(actual) });
  return differences;
}

const RELATION_RECORD_FIELDS = Object.freeze([
  'kind', 'package', 'configSymbol', 'kconfigSymbol', 'symbol', 'origin', 'states',
  'visible', 'hidden', 'userSettable', 'canDisable', 'choice', 'type', 'defaults',
  'defaultsTyped', 'ranges', 'rangesTyped', 'promptIf', 'promptConditions',
  'visibleIf', 'menuVisibleIf', 'directVisibleIf', 'inheritedVisibleIf',
  'inheritedMenuVisibleIf', 'visibility', 'optionFlags', 'options', 'modules',
  'optional', 'packageConflicts', 'kconfigConflicts', 'path', 'parent', 'locations',
  'sources', 'packageDepends', 'dependencyPackages', 'provides', 'conflicts',
  'providesRelations', 'conflictsRelations', 'dependencyRelations',
]);
const RELATION_KCONFIG_FIELDS = Object.freeze([
  'depends', 'selects', 'implies', 'dependsVariants', 'selectsVariants', 'impliesVariants',
  'dependsExpressions', 'selectsExpressions', 'impliesExpressions', 'dependsAst',
  'dependsAstVariants', 'selectRelations', 'selectRelationsVariants', 'implyRelations',
  'implyRelationsVariants', 'promptIfAst', 'visibleIfAst', 'menuVisibleIfAst',
  'directVisibleIfAst', 'inheritedVisibleIfAst', 'inheritedMenuVisibleIfAst',
  'relationIssues', 'dependsAllSymbols', 'selectsAllSymbols', 'impliesAllSymbols',
]);
const RELATION_PACKAGE_FIELDS = Object.freeze([
  'depends', 'rawDepends', 'provides', 'conflicts', 'packageConflicts', 'kconfigConflicts',
  'providesRelations', 'conflictsRelations', 'dependencyRelations',
]);

function relationRecordSemantics(record) {
  const kconfig = record?.kconfig || {};
  return {
    ...pick(record, RELATION_RECORD_FIELDS),
    nodes: array(record?.nodes).map(normalizeDefinition),
    // Decoders materialize empty relation arrays for package-info-only rows;
    // normalize the readable side to the same semantic defaults.
    kconfig: Object.fromEntries(RELATION_KCONFIG_FIELDS.map((field) => [field, kconfig[field] ?? []])),
    packageInfo: Object.fromEntries(RELATION_PACKAGE_FIELDS.map((field) => [field, record?.packageInfo?.[field] ?? []])),
    ...(record?.packageInfo?.installation ? { packageInstallation: record.packageInfo.installation } : {}),
  };
}

function edgeSemantics(edge) {
  return {
    from: edge?.from || '', to: edge?.to || '', relation: edge?.relation || '',
    condition: edge?.condition || '', expression: edge?.expression || '',
    expressionAst: edge?.expressionAst ?? null, conditionAst: edge?.conditionAst ?? null,
    required: edge?.required === null || edge?.required === undefined ? null : edge.required === true,
    kind: edge?.kind || '', alternatives: normalizeAlternativeBranches(edge?.alternatives),
    providers: array(edge?.providers), ownerSelf: edge?.ownerSelf === true,
  };
}

/**
 * Return the evaluator-facing relation data in a stable, field-by-field form.
 * Presentation-only text (title/help/category) is intentionally excluded;
 * every field consumed by the Kconfig/package graph is included here.
 */
export function relationSemanticProjection(relations = {}) {
  return stableValue({
    schema: Number(relations?.schema || 0),
    records: array(relations?.records).map(relationRecordSemantics),
    choices: array(relations?.choices),
    edges: array(relations?.edges).map(edgeSemantics),
    indexes: {
      byPackage: relations?.indexes?.byPackage || {}, bySymbol: relations?.indexes?.bySymbol || {},
      providers: relations?.indexes?.providers || {}, reverseDependencies: relations?.indexes?.reverseDependencies || {},
      reverseKconfig: relations?.indexes?.reverseKconfig || {}, reverseSelects: relations?.indexes?.reverseSelects || {},
      reverseImplies: relations?.indexes?.reverseImplies || {}, forwardEdges: relations?.indexes?.forwardEdges || {},
      reverseEdges: relations?.indexes?.reverseEdges || {}, choices: relations?.indexes?.choices || {},
    },
    summary: relations?.summary || {}, validation: relations?.validation || {},
    capabilities: relations?.capabilities || relations?.relationCapabilities || [],
    relationsComplete: relations?.relationsComplete === true,
    packageClosureComplete: relations?.packageClosureComplete === true,
    packageClosureCapabilities: relations?.packageClosureCapabilities || [],
    packageClosureValidation: relations?.packageClosureValidation || {},
    ...(relations.packageInstallation ? { packageInstallation: relations.packageInstallation } : {}),
  });
}

export function compareRelationSemantics(readable, expanded) {
  const expectedProjection = relationSemanticProjection(readable);
  const actualProjection = relationSemanticProjection(expanded);
  const expected = JSON.stringify(expectedProjection);
  const actual = JSON.stringify(actualProjection);
  return {
    equal: expected === actual,
    expected,
    actual,
    differences: expected === actual ? [] : collectStructuralDifferences(expectedProjection, actualProjection),
  };
}

export function validateCompactRoundTrip(readable, compact, expanded = expandCompactRelations(compact)) {
  const comparison = compareRelationSemantics(readable, expanded);
  return {
    valid: comparison.equal,
    comparison,
    schema: Number(compact?.schema || 0),
    reasons: comparison.equal ? [] : [{
      reason: 'compact-expand-semantic-mismatch',
      differences: comparison.differences,
    }],
  };
}

function compactRelationsV3(relations) {
  const strings = pool();
  const expressions = pool();
  const stringLists = tablePool();
  const expressionLists = tablePool();
  const expressionVariants = tablePool();
  const defaults = tablePool();
  const packageDependencies = tablePool();
  const expressionIdV3 = (value) => value ? expressions.id(value) : -1;
  const stringListIdV3 = (values) => stringLists.id(array(values).map((value) => strings.id(value)));
  const variantIdV3 = (rows) => expressionVariants.id(array(rows).map((row) =>
    expressionLists.id(array(row).map((value) => expressions.id(value)))));
  const records = (relations.records || []).map((record) => {
    const symbol = record.configSymbol || record.symbol || (record.package ? `PACKAGE_${record.package}` : '');
    let flags = 0;
    if (record.visible !== false) flags |= FLAG_VISIBLE;
    if (record.userSettable !== false && record.visible !== false) flags |= FLAG_USER_SETTABLE;
    if (record.canDisable !== false) flags |= FLAG_CAN_DISABLE;
    if (record.kconfigSymbol || record.symbol || record.origin !== 'packageinfo-only') flags |= FLAG_HAS_KCONFIG;
    if (record.kind === 'package' || record.package) flags |= FLAG_PACKAGE;
    const defaultRows = array(record.defaults).map(parseDefault).map(([value, condition]) => [
      strings.id(value), expressionIdV3(condition),
    ]);
    const dependencies = array(record.packageInfo?.depends).map((dependency) => [
      dependency.required === false ? 0 : 1,
      expressionIdV3(dependency.condition || ''),
      strings.id(dependency.raw ?? ''),
      stringListIdV3(dependency.packages || []),
    ]);
    return [
      strings.id(symbol), flags, TYPE_CODES[record.type || ''] ?? 0, ORIGIN_CODES[record.origin || ''] ?? 0,
      statesMask(record.states), record.choice ? strings.id(record.choice) : -1,
      defaults.id(defaultRows), variantIdV3((record.kconfig?.dependsExpressions || [])),
      variantIdV3((record.kconfig?.selectsExpressions || [])), variantIdV3((record.kconfig?.impliesExpressions || [])),
      packageDependencies.id(dependencies), stringListIdV3(record.provides || record.packageInfo?.provides || []),
      stringListIdV3(record.conflicts || record.packageInfo?.conflicts || []),
    ];
  });
  const indexes = {
    providers: encodeStringIndex(relations.indexes?.providers, strings, stringLists),
    reverseDependencies: encodeStringIndex(relations.indexes?.reverseDependencies, strings, stringLists),
    reverseKconfig: encodeStringIndex(relations.indexes?.reverseKconfig, strings, stringLists),
    choices: encodeStringIndex(relations.indexes?.choices, strings, stringLists),
  };
  return {
    schema: 3,
    fields: [
      'symbolId', 'flags', 'typeCode', 'originCode', 'statesMask', 'choiceId', 'defaultsId',
      'dependsVariantsId', 'selectsVariantsId', 'impliesVariantsId', 'packageDependenciesId',
      'providesId', 'conflictsId',
    ],
    flags: { visible: FLAG_VISIBLE, userSettable: FLAG_USER_SETTABLE, canDisable: FLAG_CAN_DISABLE,
      hasKconfig: FLAG_HAS_KCONFIG, package: FLAG_PACKAGE },
    types: TYPES, origins: ORIGINS, strings: strings.values, expressions: expressions.values,
    stringLists: stringLists.values, expressionLists: expressionLists.values,
    expressionVariants: expressionVariants.values, defaults: defaults.values,
    packageDependencies: packageDependencies.values, records, indexes,
    packageClosureComplete: false, packageClosureCapabilities: [],
    packageClosureValidation: { format: 'openwrt-packageinfo-v1', reasons: ['legacy-relations-schema'] },
    summary: relations.summary || {}, validation: relations.validation || {},
  };
}

/**
 * Convert readable relations schema 2 into compact relations schema 4.
 * Schema 4 retains all evaluator inputs and provenance that schema 3 omitted;
 * schema 3 remains readable through expandCompactRelations for old snapshots.
 */
export function compactRelations(relations) {
  if (Number(relations?.schema || 0) < 2) throw new Error('relations schema 2 is required');
  const packageClosureComplete = relations.packageClosureComplete === true;
  const packageClosureCapabilities = [...new Set([
    ...array(relations.packageClosureCapabilities),
    ...(packageClosureComplete ? ['complete-package-build-closure-v1'] : []),
  ])];
  const strings = pool();
  const expressions = pool();
  const stringLists = tablePool();
  const expressionLists = tablePool();
  const expressionVariants = tablePool();
  const defaults = tablePool();
  const typedDefaults = tablePool();
  const ranges = tablePool();
  const packageDependencies = tablePool();
  const capabilities = tablePool();
  const kconfigConflicts = tablePool();
  const definitions = tablePool();
  const choices = tablePool();
  const expressionAsts = tablePool();
  const alternativeLists = tablePool();
  const numberLists = tablePool();
  const expressionIdFor = (value) => expressionId(value, expressions);
  const stringListIdFor = (values) => stringListId(values, strings, stringLists);
  const variantIdFor = (record, key) => expressionVariantsId(record, key, strings, expressions, expressionLists, expressionVariants);
  const typedDefaultsId = (record) => typedDefaults.id(array(record.defaultsTyped).length
    ? array(record.defaultsTyped).map((row) => normalizedTypedDefault(row, record.type, strings, expressions))
    : array(record.defaults).map((raw) => {
      const [value, condition] = parseDefault(raw);
      return normalizedTypedDefault({ type: record.type, value, raw, condition, valueKind: 'expression' }, record.type, strings, expressions);
    }));
  const rangesId = (record) => ranges.id(array(record.rangesTyped).length
    ? array(record.rangesTyped).map((row) => normalizedTypedRange(row, record.type, strings, expressions))
    : array(record.ranges).map((raw) => normalizedTypedRange({ type: record.type, raw }, record.type, strings, expressions)));
  const rawDefaultsId = (record) => defaults.id(
    array(record.defaults).length
      ? array(record.defaults).map((raw) => {
        const [value, condition] = parseDefault(raw);
        // Keep the original source spelling as well as the parsed value and
        // condition.  Kconfig accepts alignment whitespace before `if`, and
        // that spelling is part of the readable relation contract.
        return [strings.id(value), expressionIdFor(condition), strings.id(raw)];
      })
      : array(record.defaultsTyped).map((row) => {
        const raw = row?.raw ?? '';
        const [value, condition] = parseDefault(raw);
        return [strings.id(value), expressionIdFor(condition), strings.id(raw)];
      }),
  );
  const capabilityRelationsId = (record) => capabilities.id({
    ...(record.packageInfo?.installation ? { installation: record.packageInfo.installation } : {}),
    provides: array(record.providesRelations).map(normalizeCapabilityRelation),
    conflicts: array(record.conflictsRelations).map(normalizeCapabilityRelation),
  });
  const kconfigConflictsId = (record) => kconfigConflicts.id(array(record.kconfigConflicts).map((row) => ({
    field: String(row?.field ?? ''), values: array(row?.values).map(String),
  })));
  const dependencyRelationsId = (record) => packageDependencies.id(
    array(record.dependencyRelations || record.packageInfo?.dependencyRelations || record.packageInfo?.depends).map((dependency) => ({
      raw: dependency.raw ?? '', required: dependency.required !== false, kind: dependency.kind || 'package',
      condition: dependency.condition || '', packages: array(dependency.packages),
      targets: array(dependency.targets).map(normalizeCapabilityRelation),
    })),
  );
  const definitionId = (record) => definitions.id(array(record.nodes).map(normalizeDefinition));
  const records = (relations.records || []).map((record) => {
    const symbol = record.configSymbol || record.symbol || (record.package ? `PACKAGE_${record.package}` : '');
    let flags = 0;
    if (record.visible !== false) flags |= FLAG_VISIBLE;
    if (record.userSettable !== false && record.visible !== false) flags |= FLAG_USER_SETTABLE;
    if (record.canDisable !== false) flags |= FLAG_CAN_DISABLE;
    if (record.kconfigSymbol || record.symbol || record.origin !== 'packageinfo-only') flags |= FLAG_HAS_KCONFIG;
    if (record.kind === 'package' || record.package) flags |= FLAG_PACKAGE;
    if (record.modules === true) flags |= FLAG_MODULES;
    if (record.optional === true) flags |= FLAG_OPTIONAL;
    return [
      strings.id(symbol), flags, TYPE_CODES[record.type || ''] ?? 0, ORIGIN_CODES[record.origin || ''] ?? 0,
      statesMask(record.states), record.choice ? strings.id(record.choice) : -1,
      rawDefaultsId(record), variantIdFor(record, 'depends'), variantIdFor(record, 'selects'),
      variantIdFor(record, 'implies'), dependencyRelationsId(record),
      stringListIdFor(record.provides || record.packageInfo?.provides || []),
      stringListIdFor(record.conflicts || record.packageConflicts || record.packageInfo?.conflicts || []),
      stringListIdFor(record.packageConflicts || record.conflicts || record.packageInfo?.conflicts || []),
      kconfigConflictsId(record),
      typedDefaultsId(record), rangesId(record), stringListIdFor(record.promptIf || []),
      stringListIdFor(record.promptConditions || record.promptIf || []),
      stringListIdFor(record.visibleIf || []), stringListIdFor(record.menuVisibleIf || []),
      stringListIdFor(record.directDepends || []), stringListIdFor(record.inheritedDepends || []),
      stringListIdFor(record.directVisibleIf || record.visibility?.direct || []),
      stringListIdFor(record.inheritedVisibleIf || record.visibility?.inherited || []),
      stringListIdFor(record.inheritedMenuVisibleIf || record.visibility?.inheritedMenu || []),
      stringListIdFor(record.optionFlags || []), stringListIdFor(record.options || []), definitionId(record),
      capabilityRelationsId(record),
    ];
  });
  const indexRows = {
    byPackage: encodeRecordIndex(relations.indexes?.byPackage, strings),
    bySymbol: encodeRecordIndex(relations.indexes?.bySymbol, strings),
    providers: encodeStringIndex(relations.indexes?.providers, strings, stringLists),
    reverseDependencies: encodeStringIndex(relations.indexes?.reverseDependencies, strings, stringLists),
    reverseKconfig: encodeStringIndex(relations.indexes?.reverseKconfig, strings, stringLists),
    reverseSelects: encodeStringIndex(relations.indexes?.reverseSelects, strings, stringLists),
    reverseImplies: encodeStringIndex(relations.indexes?.reverseImplies, strings, stringLists),
    choices: encodeStringIndex(relations.indexes?.choices, strings, stringLists),
    forwardEdges: encodeNumberIndex(relations.indexes?.forwardEdges, numberLists),
    reverseEdges: encodeNumberIndex(relations.indexes?.reverseEdges, numberLists),
  };
  // Edge indexes are authored against the source edge position.  Do not
  // deduplicate this table: two source rows can normalize to the same wire
  // edge while their forward/reverse indexes still refer to distinct IDs.
  const edgeRows = array(relations.edges).map((edge) =>
    normalizeEdge(edge, strings, expressions, stringLists, expressionAsts, alternativeLists));
  const choiceRows = array(relations.choices).map((choice) => ({
    ...choice,
    defaultsTyped: array(choice.defaultsTyped), rangesTyped: array(choice.rangesTyped),
  }));
  const compact = {
    schema: 4,
    fields: [
      'symbolId', 'flags', 'typeCode', 'originCode', 'statesMask', 'choiceId', 'defaultsId',
      'dependsVariantsId', 'selectsVariantsId', 'impliesVariantsId', 'packageDependenciesId',
      'providesId', 'conflictsId', 'packageConflictsId', 'kconfigConflictsId', 'typedDefaultsId', 'rangesId',
      'promptIfId', 'promptConditionsId',
      'visibleIfId', 'menuVisibleIfId', 'directDependsId', 'inheritedDependsId', 'directVisibleIfId',
      'inheritedVisibleIfId', 'inheritedMenuVisibleIfId', 'optionFlagsId', 'optionsId', 'definitionsId',
      'capabilityRelationsId',
    ],
    defaultsFields: ['valueId', 'conditionId', 'rawId'],
    flags: { visible: FLAG_VISIBLE, userSettable: FLAG_USER_SETTABLE, canDisable: FLAG_CAN_DISABLE,
      hasKconfig: FLAG_HAS_KCONFIG, package: FLAG_PACKAGE, modules: FLAG_MODULES, optional: FLAG_OPTIONAL },
    types: TYPES, origins: ORIGINS, valueKinds: VALUE_KINDS,
    relationCapabilities: [
      ...KCONFIG_RELATION_CAPABILITIES,
      ...(relations.relationsComplete === true ? ['complete-kconfig-relations-v1'] : []),
    ],
    relationsComplete: relations.relationsComplete === true,
    roundTripValidated: false,
    packageClosureComplete,
    ...(relations.packageInstallation ? { packageInstallation: relations.packageInstallation } : {}),
    packageClosureCapabilities,
    packageClosureValidation: relations.packageClosureValidation || {
      format: 'openwrt-packageinfo-v1', reasons: ['package-closure-validation-missing'],
    },
    strings: strings.values, expressions: expressions.values,
    stringLists: stringLists.values, expressionLists: expressionLists.values,
    expressionVariants: expressionVariants.values, defaults: defaults.values,
    typedDefaults: typedDefaults.values, ranges: ranges.values,
    packageDependencies: packageDependencies.values, capabilities: capabilities.values,
    kconfigConflicts: kconfigConflicts.values,
    definitions: definitions.values, choices: choiceRows, expressionAsts: expressionAsts.values,
    alternativeLists: alternativeLists.values,
    numberLists: numberLists.values,
    edges: edgeRows, indexes: indexRows, records,
    summary: relations.summary || {}, validation: relations.validation || {},
  };
  const roundTrip = validateCompactRoundTrip(relations, compact);
  const complete = relations.relationsComplete === true && roundTrip.valid;
  const relationCapabilities = [
    ...KCONFIG_RELATION_CAPABILITIES,
    ...(complete ? ['complete-kconfig-relations-v1'] : []),
  ];
  compact.relationsComplete = complete;
  compact.roundTripValidated = roundTrip.valid;
  compact.relationCapabilities = relationCapabilities;
  compact.validation = {
    ...(relations.validation || {}),
    relationsComplete: complete,
    dataComplete: relations.validation?.dataComplete !== false && relations.relationsComplete === true,
    roundTripValidated: roundTrip.valid,
    compactExpandSemanticEqual: roundTrip.valid,
    compactExpandValidation: roundTrip.reasons,
    relationCapabilities,
  };
  // Keep the readable legacy shard and compact graph stamped from the same
  // final decision. This prevents schema-5 and schema-6 assets from disagreeing.
  relations.relationsComplete = complete;
  relations.capabilities = relationCapabilities;
  relations.validation = compact.validation;
  return compact;
}

function expandSchema3(compact) {
  const strings = compact.strings || [];
  const expressions = compact.expressions || [];
  const stringLists = compact.stringLists || [];
  const expressionLists = compact.expressionLists || [];
  const variants = compact.expressionVariants || [];
  const list = (id) => decodeStringList(id, strings, stringLists);
  const expressionRows = (id) => decodeExpressionRows(id, expressions, expressionLists, variants);
  const records = (compact.records || []).map((row) => {
    const [symbolId, flags, typeCode, originCode, mask, choiceId, defaultsId,
      dependsId, selectsId, impliesId, packageDependenciesId, providesId, conflictsId] = row;
    const symbol = strings[symbolId] || '';
    const hasKconfig = Boolean(flags & FLAG_HAS_KCONFIG);
    const isPackage = Boolean(flags & FLAG_PACKAGE);
    const dependsExpressions = expressionRows(dependsId);
    const selectsExpressions = expressionRows(selectsId);
    const impliesExpressions = expressionRows(impliesId);
    const packageDepends = (compact.packageDependencies?.[packageDependenciesId] || []).map(
      ([required, conditionId, rawId, packagesId]) => ({
        raw: strings[rawId] || '', required: Boolean(required),
        condition: conditionId < 0 ? '' : expressions[conditionId] || '', packages: list(packagesId),
      }),
    );
    const defaultRows = (compact.defaults?.[defaultsId] || []).map(([valueId, conditionId]) => {
      const value = strings[valueId] || ''; const condition = conditionId < 0 ? '' : expressions[conditionId] || '';
      return condition ? `${value} if ${condition}` : value;
    });
    const packageName = isPackage && symbol.startsWith('PACKAGE_') ? symbol.slice(8) : '';
    const provides = list(providesId);
    const conflicts = list(conflictsId);
    // Schema 3 had one ambiguous conflicts column.  Treat it as package
    // metadata for compatibility; schema 4 is the first format that can
    // distinguish package capability conflicts from Kconfig type conflicts.
    const packageConflicts = conflicts;
    return {
      kind: isPackage ? 'package' : 'config', package: packageName, configSymbol: symbol,
      kconfigSymbol: hasKconfig ? symbol : '', symbol: hasKconfig ? symbol : '',
      origin: compact.origins?.[originCode] || '', states: statesFromMask(mask),
      visible: Boolean(flags & FLAG_VISIBLE), hidden: !(flags & FLAG_VISIBLE),
      userSettable: Boolean(flags & FLAG_USER_SETTABLE), canDisable: Boolean(flags & FLAG_CAN_DISABLE),
      choice: choiceId < 0 ? '' : strings[choiceId] || '', type: compact.types?.[typeCode] || '',
      defaults: defaultRows, kconfig: { dependsExpressions, selectsExpressions, impliesExpressions },
      packageInfo: { depends: packageDepends, provides, conflicts }, provides, conflicts,
    };
  });
  return {
    schema: 2, relationsComplete: false, roundTripValidated: false, packageClosureComplete: false,
    packageClosureCapabilities: [],
    packageClosureValidation: { format: 'openwrt-packageinfo-v1', reasons: ['legacy-relations-schema'] }, records,
    indexes: {
      byPackage: decodeRecordIndex(compact.indexes?.byPackage, strings),
      bySymbol: decodeRecordIndex(compact.indexes?.bySymbol, strings),
      providers: decodeStringIndex(compact.indexes?.providers, strings, stringLists),
      reverseDependencies: decodeStringIndex(compact.indexes?.reverseDependencies, strings, stringLists),
      reverseKconfig: decodeStringIndex(compact.indexes?.reverseKconfig, strings, stringLists),
      choices: decodeStringIndex(compact.indexes?.choices, strings, stringLists),
    }, summary: compact.summary || {}, validation: compact.validation || {},
  };
}

function expandSchema4(compact) {
  const strings = compact.strings || [];
  const expressions = compact.expressions || [];
  const stringLists = compact.stringLists || [];
  const expressionLists = compact.expressionLists || [];
  const variants = compact.expressionVariants || [];
  const list = (id) => decodeStringList(id, strings, stringLists);
  const alternatives = (id) => decodeAlternativeBranches(id, strings, stringLists, compact.alternativeLists);
  const expressionRows = (id) => decodeExpressionRows(id, expressions, expressionLists, variants);
  const expression = (id) => id < 0 ? '' : expressions[id] || '';
  const typeConflicts = (id) => (compact.kconfigConflicts?.[id] || []).map((row) => ({
    field: row.field || '', values: array(row.values).map(String),
  }));
  const typedDefaults = (id) => (compact.typedDefaults?.[id] || []).map((row) => ({
    type: compact.types?.[row.typeCode] || '', value: row.value, raw: strings[row.rawId] || '',
    condition: expression(row.conditionId), valueKind: compact.valueKinds?.[row.valueKindCode] || '',
    valid: row.valid !== false, precise: row.precise !== false,
  }));
  const typedRanges = (id) => (compact.ranges?.[id] || []).map((row) => ({
    type: compact.types?.[row.typeCode] || '', min: row.min, max: row.max,
    minRaw: strings[row.minRawId] || '', maxRaw: strings[row.maxRawId] || '', raw: strings[row.rawId] || '',
    condition: expression(row.conditionId),
    minKind: compact.valueKinds?.[row.minKindCode] || '', maxKind: compact.valueKinds?.[row.maxKindCode] || '',
    valid: row.valid !== false,
  }));
  const capabilitiesFor = (id) => compact.capabilities?.[id] || { provides: [], conflicts: [] };
  const packageDependenciesFor = (id) => (compact.packageDependencies?.[id] || []).map((row) => ({
    raw: row.raw ?? '', required: row.required !== false, kind: row.kind || 'package', condition: row.condition || '',
    packages: array(row.packages), targets: array(row.targets),
  }));
  const definitionsFor = (id) => compact.definitions?.[id] || [];
  const decodeEdges = () => (compact.edges || []).map((edge) => ({
    from: strings[edge.fromId] || '', to: strings[edge.toId] || '', relation: strings[edge.relationId] || '',
    condition: expression(edge.conditionId), expression: expression(edge.expressionId),
    ...(edge.expressionAstId < 0 ? {} : { expressionAst: compact.expressionAsts?.[edge.expressionAstId] || null }),
    ...(edge.conditionAstId < 0 ? {} : { conditionAst: compact.expressionAsts?.[edge.conditionAstId] || null }),
    // Keep `null` explicit: it means the edge is only a candidate/reference
    // and must not be interpreted as a mandatory dependency by consumers.
    required: edge.required === null ? null : edge.required === true,
    kind: strings[edge.kindId] || '', alternatives: alternatives(edge.alternativesId), providers: list(edge.providersId),
    ownerSelf: edge.ownerSelf === true,
  }));
  const records = (compact.records || []).map((row) => {
    const [symbolId, flags, typeCode, originCode, mask, choiceId, defaultsId,
      dependsId, selectsId, impliesId, packageDependenciesId, providesId, conflictsId,
      packageConflictsId, kconfigConflictsId, typedDefaultsId, rangesId, promptIfId, promptConditionsId,
      visibleIfId, menuVisibleIfId,
      directDependsId, inheritedDependsId, directVisibleIfId, inheritedVisibleIfId,
      inheritedMenuVisibleIfId, optionFlagsId, optionsId, definitionsId, capabilityRelationsId] = row;
    const symbol = strings[symbolId] || '';
    const hasKconfig = Boolean(flags & FLAG_HAS_KCONFIG);
    const isPackage = Boolean(flags & FLAG_PACKAGE);
    const dependsExpressions = expressionRows(dependsId);
    const selectsExpressions = expressionRows(selectsId);
    const impliesExpressions = expressionRows(impliesId);
    const packageSymbolVariants = (rows) => rows.map((row) => [...new Set(row
      .flatMap((item) => parseKconfigExpression(item).symbols)
      .filter((symbol) => symbol.startsWith('PACKAGE_')))]);
    const allSymbols = (rows) => [...new Set(rows.flatMap((row) => row
      .flatMap((item) => parseKconfigExpression(item).symbols)))];
    const dependsVariants = packageSymbolVariants(dependsExpressions);
    const selectsVariants = packageSymbolVariants(selectsExpressions);
    const impliesVariants = packageSymbolVariants(impliesExpressions);
    const kconfig = {
      dependsExpressions, selectsExpressions, impliesExpressions,
      dependsVariants, selectsVariants, impliesVariants,
      depends: [...new Set(dependsVariants.flat())],
      selects: [...new Set(selectsVariants.flat())],
      implies: [...new Set(impliesVariants.flat())],
      dependsAllSymbols: allSymbols(dependsExpressions),
      selectsAllSymbols: allSymbols(selectsExpressions),
      impliesAllSymbols: allSymbols(impliesExpressions),
    };
    const defaultRows = (compact.defaults?.[defaultsId] || []).map(([valueId, conditionId, rawId]) => {
      const value = strings[valueId] || ''; const condition = expression(conditionId);
      const fallback = condition ? `${value} if ${condition}` : value;
      return rawId === undefined ? fallback : (strings[rawId] ?? fallback);
    });
    const packageName = isPackage && symbol.startsWith('PACKAGE_') ? symbol.slice(8) : '';
    const provides = list(providesId);
    const conflicts = list(conflictsId);
    const packageConflicts = list(packageConflictsId);
    const typeConflictRows = typeConflicts(kconfigConflictsId);
    const capabilityRows = capabilitiesFor(capabilityRelationsId);
    const packageDepends = packageDependenciesFor(packageDependenciesId);
    const definitionRows = definitionsFor(definitionsId);
    const definitionDependsAst = definitionRows.map((definition) => array(definition.dependsAst));
    const definitionDirectDependsAst = definitionRows.map((definition) => array(definition.directDependsAst));
    const definitionInheritedDependsAst = definitionRows.map((definition) => array(definition.inheritedDependsAst));
    const definitionSelectRelations = definitionRows.map((definition) => array(definition.selectRelations));
    const definitionImplyRelations = definitionRows.map((definition) => array(definition.implyRelations));
    const definitionPromptIfAst = definitionRows.map((definition) => array(definition.promptIfAst));
    const definitionVisibleIfAst = definitionRows.map((definition) => array(definition.visibleIfAst));
    const definitionMenuVisibleIfAst = definitionRows.map((definition) => array(definition.menuVisibleIfAst));
    const definitionDirectVisibleIfAst = definitionRows.map((definition) => array(definition.directVisibleIfAst));
    const definitionInheritedVisibleIfAst = definitionRows.map((definition) => array(definition.inheritedVisibleIfAst));
    const definitionInheritedMenuVisibleIfAst = definitionRows.map((definition) => array(definition.inheritedMenuVisibleIfAst));
    const kconfigConflicts = [...typeConflictRows,
      ...definitionRows.flatMap((definition) => array(definition.kconfigConflicts))];
    const firstDefinition = definitionRows[0] || {};
    const locations = definitionRows.map((definition) => definition.location).filter(Boolean);
    const sources = [...new Set(definitionRows.map((definition) => definition.source).filter(Boolean))];
    return {
      kind: isPackage ? 'package' : 'config', package: packageName, configSymbol: symbol,
      kconfigSymbol: hasKconfig ? symbol : '', symbol: hasKconfig ? symbol : '',
      origin: compact.origins?.[originCode] || '', states: statesFromMask(mask),
      visible: Boolean(flags & FLAG_VISIBLE), hidden: !(flags & FLAG_VISIBLE),
      userSettable: Boolean(flags & FLAG_USER_SETTABLE), canDisable: Boolean(flags & FLAG_CAN_DISABLE),
      choice: choiceId < 0 ? '' : strings[choiceId] || '', type: compact.types?.[typeCode] || '',
      defaults: defaultRows, defaultsTyped: typedDefaults(typedDefaultsId),
      ranges: typedRanges(rangesId).map((row) => row.raw ?? `${row.minRaw} ${row.maxRaw}`),
      rangesTyped: typedRanges(rangesId), promptIf: list(promptIfId), promptConditions: list(promptConditionsId),
      visibleIf: list(visibleIfId), menuVisibleIf: list(menuVisibleIfId),
      directVisibleIf: list(directVisibleIfId), inheritedVisibleIf: list(inheritedVisibleIfId),
      inheritedMenuVisibleIf: list(inheritedMenuVisibleIfId),
      visibility: { promptIf: list(promptIfId), menuVisibleIf: list(menuVisibleIfId), effective: list(visibleIfId),
        direct: list(directVisibleIfId), inherited: list(inheritedVisibleIfId), inheritedMenu: list(inheritedMenuVisibleIfId) },
      directDepends: list(directDependsId), inheritedDepends: list(inheritedDependsId),
      path: array(firstDefinition.path), parent: firstDefinition.parent || '',
      locations, sources,
      optionFlags: list(optionFlagsId), options: list(optionsId),
      modules: Boolean(flags & FLAG_MODULES) || list(optionFlagsId).includes('modules'),
      optional: Boolean(flags & FLAG_OPTIONAL),
      // The readable builder exposes the first definition as the aggregate
      // AST and keeps every definition in the corresponding variants field.
      // Flattening here duplicates conditions for multi-definition symbols.
      dependsAst: array(firstDefinition.dependsAst), dependsAstVariants: definitionDependsAst,
      directDependsAst: array(firstDefinition.directDependsAst), directDependsAstVariants: definitionDirectDependsAst,
      inheritedDependsAst: array(firstDefinition.inheritedDependsAst), inheritedDependsAstVariants: definitionInheritedDependsAst,
      selectRelations: definitionSelectRelations.flat(), selectRelationsVariants: definitionSelectRelations,
      implyRelations: definitionImplyRelations.flat(), implyRelationsVariants: definitionImplyRelations,
      promptIfAst: array(firstDefinition.promptIfAst), visibleIfAst: array(firstDefinition.visibleIfAst),
      menuVisibleIfAst: array(firstDefinition.menuVisibleIfAst), directVisibleIfAst: array(firstDefinition.directVisibleIfAst),
      inheritedVisibleIfAst: array(firstDefinition.inheritedVisibleIfAst),
      inheritedMenuVisibleIfAst: array(firstDefinition.inheritedMenuVisibleIfAst),
      kconfigConflicts, packageConflicts, conflicts: packageConflicts,
      nodes: definitionRows, kconfig: { ...kconfig, dependsAst: array(firstDefinition.dependsAst),
        directDependsAst: array(firstDefinition.directDependsAst), directDependsAstVariants: definitionDirectDependsAst,
        inheritedDependsAst: array(firstDefinition.inheritedDependsAst), inheritedDependsAstVariants: definitionInheritedDependsAst,
        dependsAstVariants: definitionDependsAst, selectRelations: definitionSelectRelations.flat(),
        selectRelationsVariants: definitionSelectRelations, implyRelations: definitionImplyRelations.flat(),
        implyRelationsVariants: definitionImplyRelations, promptIfAst: array(firstDefinition.promptIfAst),
        visibleIfAst: array(firstDefinition.visibleIfAst), menuVisibleIfAst: array(firstDefinition.menuVisibleIfAst),
        directVisibleIfAst: array(firstDefinition.directVisibleIfAst), inheritedVisibleIfAst: array(firstDefinition.inheritedVisibleIfAst),
      inheritedMenuVisibleIfAst: array(firstDefinition.inheritedMenuVisibleIfAst) }, packageInfo: {
        depends: packageDepends, rawDepends: packageDepends.map((row) => row.raw), provides, conflicts,
        packageConflicts, kconfigConflicts,
        providesRelations: capabilityRows.provides || [], conflictsRelations: capabilityRows.conflicts || [],
        ...(capabilityRows.installation ? { installation: capabilityRows.installation } : {}),
        dependencyRelations: packageDepends,
      }, packageDepends: packageDepends.map((row) => row.raw), dependencyPackages: [...new Set(packageDepends.flatMap((row) => row.packages))],
      provides, conflicts, providesRelations: capabilityRows.provides || [], conflictsRelations: capabilityRows.conflicts || [],
      dependencyRelations: packageDepends,
    };
  });
  return {
    schema: 2, relationsComplete: compact.relationsComplete === true,
    roundTripValidated: compact.roundTripValidated === true,
    packageClosureComplete: compact.packageClosureComplete === true,
    ...(compact.packageInstallation ? { packageInstallation: compact.packageInstallation } : {}),
    packageClosureCapabilities: compact.packageClosureCapabilities || [],
    packageClosureValidation: compact.packageClosureValidation || {
      format: 'openwrt-packageinfo-v1', reasons: ['package-closure-validation-missing'],
    }, capabilities: compact.relationCapabilities || [],
    records, choices: compact.choices || [], edges: decodeEdges(),
    indexes: {
      byPackage: decodeRecordIndex(compact.indexes?.byPackage, strings),
      bySymbol: decodeRecordIndex(compact.indexes?.bySymbol, strings),
      providers: decodeStringIndex(compact.indexes?.providers, strings, stringLists),
      reverseDependencies: decodeStringIndex(compact.indexes?.reverseDependencies, strings, stringLists),
      reverseKconfig: decodeStringIndex(compact.indexes?.reverseKconfig, strings, stringLists),
      reverseSelects: decodeStringIndex(compact.indexes?.reverseSelects, strings, stringLists),
      reverseImplies: decodeStringIndex(compact.indexes?.reverseImplies, strings, stringLists),
      choices: decodeStringIndex(compact.indexes?.choices, strings, stringLists),
      forwardEdges: decodeNumberIndex(compact.indexes?.forwardEdges, compact.numberLists || []),
      reverseEdges: decodeNumberIndex(compact.indexes?.reverseEdges, compact.numberLists || []),
    }, summary: compact.summary || {}, validation: compact.validation || {},
  };
}

/** Expand schema 3 or 4 into the canonical readable relation shape. */
export function expandCompactRelations(compact) {
  if (Number(compact?.schema) === 5) return expandCompactRelations(decodeCompactRelationTables(compact));
  const schema = Number(compact?.schema || 0);
  if (schema === 3) return expandSchema3(compact);
  if (schema === 4) return expandSchema4(compact);
  throw new Error('relations schema 3 or 4 is required');
}

export const COMPACT_RELATIONS_FLAGS = Object.freeze({
  visible: FLAG_VISIBLE, userSettable: FLAG_USER_SETTABLE, canDisable: FLAG_CAN_DISABLE,
  hasKconfig: FLAG_HAS_KCONFIG, package: FLAG_PACKAGE,
});

export const COMPACT_RELATIONS_SCHEMA = 4;
