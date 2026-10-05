import {
  KCONFIG_RELATION_CAPABILITIES,
  parseKconfigExpression,
  parseKconfigRelation,
  projectNativePackageInstallation,
  splitKconfigIfClause,
} from './lib.mjs';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function packageName(value) {
  return String(value || '').trim().replace(/^PACKAGE_/, '');
}

// metadata.pm removes the APK marker only in Provides. It is not a
// normalization for Depends, where @ introduces a Kconfig condition.
function providedCapabilityName(value) {
  return packageName(value).replace(/^@/, '');
}

function packageSymbols(expressions = []) {
  return unique(expressions.flatMap((expression) =>
    parseKconfigExpression(expression).symbols.filter((symbol) => symbol.startsWith('PACKAGE_'))));
}

function allExpressionSymbols(expressions = []) {
  return unique(expressions.flatMap((expression) =>
    parseKconfigExpression(expression).symbols));
}

function statesFor(option) {
  if (option?.type === 'tristate') return ['n', 'm', 'y'];
  if (option?.type === 'bool') return ['n', 'y'];
  return [];
}

function expressionVariants(option, field) {
  const variants = option?.[`${field}Variants`];
  const rows = Array.isArray(variants) && variants.length ? variants : [option?.[field] || []];
  return rows.map((items) => (Array.isArray(items) ? items : [items]).filter(Boolean));
}

function expressionAstVariants(option, field) {
  const variants = option?.[`${field}AstVariants`];
  if (Array.isArray(variants) && variants.length) return variants.map((rows) => rows.filter(Boolean));
  const ast = option?.[`${field}Ast`];
  if (Array.isArray(ast) && ast.length && !Array.isArray(option?.[field])) return [ast.filter(Boolean)];
  const rows = expressionVariants(option, field.replace(/Ast$/, ''));
  return rows.map((items) => items.map((item) => item?.ast ? item : parseKconfigExpression(item)));
}

function relationVariants(option, field, rawField) {
  const variants = option?.[`${field}Variants`];
  if (Array.isArray(variants) && variants.length) {
    return variants.map((rows) => rows.map((item) => item?.targetAst !== undefined ? item : parseKconfigRelation(item)));
  }
  const rows = Array.isArray(option?.[field]) && option[field].length ? option[field]
    : expressionVariants(option, rawField).flat();
  return [rows.map((item) => item?.targetAst !== undefined ? item : parseKconfigRelation(item))];
}

export function parsePackageDependency(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  const required = raw.startsWith('+') || !raw.startsWith('@');
  const clean = raw.replace(/^\+/, '');
  if (clean.startsWith('@')) {
    return { raw, required: false, kind: 'menu-condition', condition: clean.slice(1), packages: [] };
  }
  const colon = clean.lastIndexOf(':');
  const condition = colon >= 0 ? clean.slice(0, colon) : '';
  const target = colon >= 0 ? clean.slice(colon + 1) : clean;
  const packages = unique(target.split(/\|\|/).map((item) => packageName(item.trim())));
  if (!packages.length) return { raw, required: false, kind: 'unknown', condition, packages: [] };
  return {
    raw,
    required,
    kind: packages.length > 1 ? 'alternative' : 'package',
    condition,
    packages,
  };
}

function closurePackageRecord(raw) {
  const name = packageName(raw?.name || raw?.package || raw?.configSymbol?.replace(/^PACKAGE_/, ''));
  if (!name) return null;
  const rawDepends = Array.isArray(raw?.depends) ? raw.depends
    : Array.isArray(raw?.rawDepends) ? raw.rawDepends
      : Array.isArray(raw?.packageInfo?.rawDepends) ? raw.packageInfo.rawDepends
        : Array.isArray(raw?.packageInfo?.depends) ? raw.packageInfo.depends.map((row) => row?.raw || row).filter(Boolean)
          : Array.isArray(raw?.dependencyRelations) ? raw.dependencyRelations.map((row) => row?.raw || row).filter(Boolean) : [];
  return {
    name,
    depends: rawDepends.map((row) => typeof row === 'string' ? row : row?.raw || '').filter(Boolean),
    provides: Array.isArray(raw?.provides) ? raw.provides : raw?.packageInfo?.provides || [],
    runtime: projectNativePackageInstallation(raw)?.runtime || raw?.packageInfo?.installation?.runtime || null,
  };
}

const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.+@/-]*$/;
export const PACKAGE_CLOSURE_CAPABILITY = 'complete-package-build-closure-v1';
const PACKAGE_CLOSURE_DATA_CAPABILITIES = Object.freeze([
  'packageinfo-dependencies-v1',
  'packageinfo-alternatives-v1',
  'packageinfo-conditions-v1',
  'packageinfo-virtual-providers-v1',
  'package-forward-reverse-edges-v1',
]);

function exactPackageId(value) {
  const text = String(value || '').trim().replace(/^PACKAGE_/, '');
  return PACKAGE_ID_RE.test(text) ? text : '';
}

function packageInfoRawDependencies(row) {
  const values = Array.isArray(row?.depends) ? row.depends
    : Array.isArray(row?.rawDepends) ? row.rawDepends
      : Array.isArray(row?.packageInfo?.rawDepends) ? row.packageInfo.rawDepends
        : Array.isArray(row?.packageInfo?.depends) ? row.packageInfo.depends : null;
  if (!values) return null;
  return values.map((value) => typeof value === 'string' ? value : value?.raw || '')
    .map((value) => String(value || '').trim()).filter(Boolean);
}

function packageInfoRawCapabilities(row, field) {
  const values = Array.isArray(row?.[field]) ? row[field] : row?.packageInfo?.[field];
  return Array.isArray(values) ? values.map((value) => String(value || '').trim()).filter(Boolean) : null;
}

function sortedEqual(left = [], right = []) {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

/**
 * Validate the deliberately narrow package-build graph contract.  This does
 * not inspect Kconfig defaults, visibility, choice semantics, or any other
 * typed relation.  It only proves that an exact package-info table preserves
 * package dependency tokens (including alternatives and conditions), virtual
 * provider ownership, and the forward/reverse package edges used by failed
 * package closure analysis.
 *
 * `graph` is optional for Probe callers: when omitted, the function verifies
 * the same forward/reverse projection built directly from the refreshed
 * package-info rows.  Catalog generation passes its actual graph so the
 * published indexes are checked rather than merely assumed.
 */
export function validatePackageClosureGraph(packageRows = [], records, graph = {}) {
  const rows = Array.isArray(packageRows) ? packageRows : [];
  // The Probe has only refreshed .packageinfo rows.  It deliberately does not
  // have a Catalog record projection to compare, so an omitted `records`
  // argument must not be treated as an empty projection.  Catalog generation
  // passes the second argument explicitly and therefore opts into the
  // field/edge projection checks below.
  const hasRecordProjection = arguments.length >= 2 && Array.isArray(records);
  const reasons = [];
  const unresolvedTargets = [];
  const names = new Set();
  const rawDependencies = new Map();
  const rawProvides = new Map();
  const rawConflicts = new Map();
  const addReason = (reason, detail = {}) => reasons.push({ reason, ...detail });
  let metadataComplete = rows.length > 0;

  if (!rows.length) addReason('packageinfo-empty');
  rows.forEach((row, index) => {
    const name = exactPackageId(row?.name || row?.package || row?.configSymbol);
    if (!name) {
      metadataComplete = false;
      addReason('invalid-package-name', { index, value: row?.name || row?.package || '' });
      return;
    }
    if (names.has(name)) {
      metadataComplete = false;
      addReason('duplicate-package-name', { package: name });
    }
    names.add(name);
    const depends = packageInfoRawDependencies(row);
    const provides = packageInfoRawCapabilities(row, 'provides');
    const conflicts = packageInfoRawCapabilities(row, 'conflicts');
    if (!depends || !provides || !conflicts) {
      metadataComplete = false;
      addReason('packageinfo-field-missing', { package: name,
        fields: ['depends', 'provides', 'conflicts'].filter((field) =>
          (field === 'depends' ? !depends : field === 'provides' ? !provides : !conflicts)) });
    }
    rawDependencies.set(name, depends || []);
    rawProvides.set(name, provides || []);
    rawConflicts.set(name, conflicts || []);
  });

  const providerMap = new Map();
  const validateCapabilityList = (field, source) => {
    for (const [owner, values] of source) for (const raw of values) {
      // Provides entries are opaque metadata tokens, not concrete Kconfig
      // package identifiers. Native metadata also preserves versioned tokens
      // such as capability=1.2 literally; do not truncate or reject them.
      const token = field === 'provides' ? providedCapabilityName(raw) : raw;
      const name = /^[^\s\0]+$/.test(token) ? token : '';
      if (!name) {
        // Native mconf_conflicts ignores unknown literal names. Preserve
        // their spelling in metadata instead of inventing a concrete target
        // by truncating punctuation (for example, a trailing comma).
        if (field === 'conflicts') continue;
        metadataComplete = false;
        addReason('invalid-package-capability', { package: owner, field, value: raw });
      }
      else if (field === 'provides' && !names.has(name)) {
        const providers = providerMap.get(name) || [];
        providers.push(owner);
        providerMap.set(name, providers);
      }
    }
  };
  validateCapabilityList('provides', rawProvides);
  validateCapabilityList('conflicts', rawConflicts);
  for (const [capability, providers] of providerMap) providerMap.set(capability, unique(providers).sort());

  const expectedEdges = [];
  const expectedReverseDependencies = new Map();
  let dependencyCount = 0;
  let alternativeCount = 0;
  let conditionalCount = 0;
  for (const [owner, values] of rawDependencies) {
    for (const raw of values) {
      const dependency = parsePackageDependency(raw);
      if (!dependency || dependency.kind === 'unknown') {
        metadataComplete = false;
        addReason('invalid-package-dependency', { package: owner, raw });
        continue;
      }
      dependencyCount += 1;
      if (dependency.kind === 'alternative') alternativeCount += 1;
      if (dependency.condition || dependency.kind === 'menu-condition') {
        conditionalCount += 1;
        if (!dependency.condition) addReason('empty-package-condition', { package: owner, raw });
      }
      if (dependency.kind === 'menu-condition') continue;
      for (const target of dependency.packages) {
        if (!exactPackageId(target)) {
          metadataComplete = false;
          addReason('invalid-package-dependency-target', { package: owner, raw, target });
          continue;
        }
        if (!names.has(target) && !providerMap.has(target)) {
          unresolvedTargets.push({ package: owner, raw, target });
        }
        const targetKind = names.has(target) ? 'concrete' : providerMap.has(target) ? 'virtual' : 'unknown';
        expectedEdges.push({
          from: owner, to: target, relation: 'package-depends',
          required: dependency.kind === 'alternative' || dependency.condition || targetKind !== 'concrete'
            ? null : dependency.required,
          kind: targetKind, condition: dependency.condition,
          alternatives: dependency.packages.length > 1 ? [dependency.packages] : [],
        });
        const owners = expectedReverseDependencies.get(target) || [];
        owners.push(owner); expectedReverseDependencies.set(target, owners);
      }
    }
  }

  const packageRecords = hasRecordProjection
    ? (records.length
    ? records.filter((record) => record?.package).map((record) => ({
      name: exactPackageId(record.package), record,
    }))
    : [])
    : [];
  const packageRecordByName = new Map(packageRecords.filter((row) => row.name).map((row) => [row.name, row.record]));
  for (const name of hasRecordProjection ? names : []) {
    const entry = packageRecordByName.get(name);
    if (!entry) {
      metadataComplete = false;
      addReason('package-record-missing', { package: name });
      continue;
    }
    if (entry && !String(entry.origin || '').includes('packageinfo')) {
      metadataComplete = false;
      addReason('package-record-not-packageinfo-backed', { package: name, origin: entry.origin || '' });
    }
    const projectedDependencies = packageInfoRawDependencies(entry);
    if (!projectedDependencies || JSON.stringify(projectedDependencies) !==
        JSON.stringify(rawDependencies.get(name) || [])) {
      metadataComplete = false;
      addReason('packageinfo-dependency-projection-mismatch', { package: name });
    }
    for (const field of ['provides', 'conflicts']) {
      const projected = packageInfoRawCapabilities(entry, field);
      const expected = field === 'provides' ? rawProvides.get(name) || [] : rawConflicts.get(name) || [];
      if (!projected || JSON.stringify(projected) !== JSON.stringify(expected)) {
        metadataComplete = false;
        addReason('packageinfo-capability-projection-mismatch', { package: name, field });
      }
    }
    const relationRows = Array.isArray(entry.dependencyRelations) ? entry.dependencyRelations
      : entry.packageInfo?.dependencyRelations;
    if (!Array.isArray(relationRows)) {
      metadataComplete = false;
      addReason('packageinfo-dependency-relations-missing', { package: name });
    } else {
      const relationByRaw = new Map(relationRows.map((row) => [String(row?.raw || ''), row]));
      for (const raw of rawDependencies.get(name) || []) {
        const expected = parsePackageDependency(raw);
        const actual = relationByRaw.get(raw);
        if (!actual || actual.kind !== expected?.kind || actual.condition !== expected?.condition ||
            actual.required !== expected?.required || !sortedEqual(actual.packages, expected?.packages || [])) {
          metadataComplete = false;
          addReason('packageinfo-dependency-relation-mismatch', { package: name, raw });
        }
      }
    }
    for (const field of ['providesRelations', 'conflictsRelations']) {
      const relationRowsForField = Array.isArray(entry[field]) ? entry[field] : entry.packageInfo?.[field];
      if (!Array.isArray(relationRowsForField)) {
        metadataComplete = false;
        addReason('packageinfo-capability-relations-missing', { package: name, field });
      } else {
        const relationByRaw = new Map(relationRowsForField.map((row) => [String(row?.raw || ''), row]));
        const expectedRows = field === 'providesRelations' ? rawProvides.get(name) || [] : rawConflicts.get(name) || [];
        for (const raw of expectedRows) {
          const actual = relationByRaw.get(raw);
          if (!actual || !actual.name || !['concrete', 'virtual', 'unknown'].includes(actual.kind)) {
            metadataComplete = false;
            addReason('packageinfo-capability-relation-mismatch', { package: name, field, raw });
          }
        }
      }
    }
  }

  const actualEdges = Array.isArray(graph?.edges) ? graph.edges : null;
  const actualIndexes = graph?.indexes && typeof graph.indexes === 'object' ? graph.indexes : null;
  let forwardReverseValidated = true;
  if (actualEdges && actualIndexes) {
    const edgeKey = (edge) => `${edge?.from || ''}\u0000${edge?.to || ''}\u0000${edge?.relation || ''}`;
    const actualEdgesByKey = new Map();
    for (const edge of actualEdges) {
      const key = edgeKey(edge);
      const rows = actualEdgesByKey.get(key) || [];
      rows.push(edge); actualEdgesByKey.set(key, rows);
    }
    const normalizedAlternatives = (value) => (Array.isArray(value) ? value : [])
      .map((row) => Array.isArray(row) ? row.map(String) : [String(row)])
      .filter((row) => row.length);
    for (const expected of expectedEdges) {
      const candidates = actualEdgesByKey.get(edgeKey(expected)) || [];
      if (!candidates.length) {
        forwardReverseValidated = false;
        addReason('package-edge-missing', expected);
        continue;
      }
      const actual = candidates.find((edge) => edge.required === expected.required &&
        String(edge.kind || '') === expected.kind && String(edge.condition || '') === expected.condition &&
        JSON.stringify(normalizedAlternatives(edge.alternatives)) ===
          JSON.stringify(normalizedAlternatives(expected.alternatives)));
      if (!actual) {
        forwardReverseValidated = false;
        addReason('package-edge-projection-mismatch', { expected, actual: candidates });
      }
    }
    actualEdges.forEach((edge, id) => {
      const forward = actualIndexes.forwardEdges?.[edge.from] || [];
      const reverse = actualIndexes.reverseEdges?.[edge.to] || [];
      if (!forward.includes(id) || !reverse.includes(id)) {
        forwardReverseValidated = false;
        addReason('edge-index-not-bidirectional', { id, from: edge.from, to: edge.to });
      }
    });
    for (const [target, owners] of expectedReverseDependencies) {
      const indexed = actualIndexes.reverseDependencies?.[target] || [];
      if (!sortedEqual(indexed, owners)) {
        forwardReverseValidated = false;
        addReason('reverse-dependency-index-mismatch', { target, expected: [...new Set(owners)].sort(), actual: indexed });
      }
    }
    for (const [capability, providers] of providerMap) {
      const indexed = actualIndexes.providers?.[capability] || [];
      if (!sortedEqual(indexed, providers)) {
        forwardReverseValidated = false;
        addReason('provider-index-mismatch', { capability, expected: providers, actual: indexed });
      }
    }
  } else {
    // Probe supplies freshly parsed .packageinfo rows, not Catalog records.
    // Its local projection is exact by construction once every target/provider
    // has been resolved above; the runtime closure still proves active paths.
    const syntheticForward = new Map();
    const syntheticReverse = new Map();
    expectedEdges.forEach((edge, id) => {
      const forward = syntheticForward.get(edge.from) || [];
      forward.push(id); syntheticForward.set(edge.from, forward);
      const reverse = syntheticReverse.get(edge.to) || [];
      reverse.push(id); syntheticReverse.set(edge.to, reverse);
    });
    forwardReverseValidated = expectedEdges.every((edge, id) =>
      syntheticForward.get(edge.from)?.includes(id) && syntheticReverse.get(edge.to)?.includes(id));
  }

  const complete = reasons.length === 0 && names.size > 0 && forwardReverseValidated;
  const capabilities = [...PACKAGE_CLOSURE_DATA_CAPABILITIES,
    ...(complete ? [PACKAGE_CLOSURE_CAPABILITY] : [])];
  return {
    complete,
    capabilities,
    validation: {
      format: 'openwrt-packageinfo-v1',
      metadataComplete,
      packageCount: names.size,
      dependencyCount,
      alternativeCount,
      conditionalCount,
      virtualProviderCount: providerMap.size,
      dependencyTargetsComplete: !reasons.some((row) =>
        ['invalid-package-dependency', 'invalid-package-dependency-target',
          'unresolved-package-dependency-target'].includes(row.reason)) && unresolvedTargets.length === 0,
      providerResolutionComplete: !reasons.some((row) => row.reason === 'invalid-package-capability'),
      forwardReverseValidated,
      // Unknown targets are validly preserved package-info references. They
      // affect a selected build closure, not the global projection proof.
      unresolvedDependencyTargets: unresolvedTargets,
      projectionValidated: metadataComplete && (!hasRecordProjection || !reasons.some((row) =>
        row.reason.startsWith('package-record-') || row.reason.startsWith('packageinfo-'))),
      reasons,
    },
  };
}

/**
 * Resolve the current package metadata forward from selected concrete roots
 * and report whether a compatibility rule's failed concrete package can be
 * reached.  The function intentionally returns `inconclusive` for missing or
 * conditional metadata; it never treats a virtual capability as a concrete
 * package and never contains a package-name exception.
 */
export function derivePackageDependencyClosure(records = [], roots = [], failedPackages = [], options = {}) {
  const installed = options.installedPackages instanceof Set ? options.installedPackages :
    new Set((options.installedPackages || []).map(packageName));
  const runtimeUnknown = new Map();
  const byName = new Map();
  for (const raw of records) {
    const record = closurePackageRecord(raw);
    if (!record) continue;
    const current = byName.get(record.name) || { name: record.name, depends: [], provides: [] };
    current.depends.push(...record.depends);
    if (installed.has(record.name) && record.runtime?.schema === 1) {
      current.depends.push(...(record.runtime.dependencies || []).map(row => '+' + row.packages[0]));
      if (record.runtime.unresolved?.length) runtimeUnknown.set(record.name, record.runtime.unresolved);
    }
    current.provides.push(...record.provides);
    byName.set(record.name, current);
  }
  for (const record of byName.values()) {
    record.depends = unique(record.depends);
    record.provides = unique(record.provides);
  }
  const providerMap = new Map();
  for (const record of byName.values()) {
    for (const provided of record.provides) {
      const capability = providedCapabilityName(provided);
      if (!capability || byName.has(capability)) continue;
      const providers = providerMap.get(capability) || [];
      providers.push(record.name);
      providerMap.set(capability, providers);
    }
  }
  for (const [capability, providers] of providerMap) providerMap.set(capability, unique(providers).sort());
  const targetNames = unique(failedPackages.map((value) => packageName(value)).filter(Boolean));
  const rootNames = unique(roots.map((value) => packageName(value)).filter(Boolean));
  if (!targetNames.length) return {
    result: 'not-run', roots: rootNames, failedPackages: [], paths: [], unknown: [], packageCount: byName.size,
  };
  const failedSet = new Set(targetNames);
  const selectedPackages = options.selectedPackages instanceof Set
    ? options.selectedPackages
    : new Set((options.selectedPackages || []).map((value) => packageName(value)).filter(Boolean));
  const hasSelection = selectedPackages.size > 0;
  const paths = [];
  const unknown = [];
  const pathKeys = new Set();
  const unknownKeys = new Set();
  const maxVisits = Number.isSafeInteger(options.maxVisits) && options.maxVisits > 0 ? options.maxVisits : 50000;
  let visits = 0;
  const addUnknown = (row) => {
    const key = JSON.stringify(row);
    if (unknownKeys.has(key)) return;
    unknownKeys.add(key); unknown.push(row);
  };
  const addPath = (root, target, path, edges) => {
    const row = { root, target, path: [...path], edges: [...edges] };
    const key = JSON.stringify(row);
    if (!pathKeys.has(key)) { pathKeys.add(key); paths.push(row); }
  };
  const expandTarget = (target) => {
    if (byName.has(target)) return { names: [target], kind: 'concrete', ambiguous: false };
    const providers = providerMap.get(target) || [];
    if (!providers.length) return { names: [], kind: 'unknown', ambiguous: true };
    const active = hasSelection ? providers.filter((provider) => selectedPackages.has(provider)) : providers;
    if (active.length === 1) return { names: active, kind: 'virtual', ambiguous: false };
    return { names: active.length ? active : providers, kind: 'virtual', ambiguous: true };
  };
  const visit = (name, root, path, edges, ancestors) => {
    if (++visits > maxVisits) {
      addUnknown({ root, from: name, reason: 'closure-limit', path: [...path] });
      return;
    }
    const record = byName.get(name);
    if (!record) {
      addUnknown({ root, from: path.at(-2) || root, target: name, reason: 'package-metadata-unresolved', path: [...path] });
      return;
    }
    if (failedSet.has(name)) {
      addPath(root, name, path, edges);
      return;
    }
    if (ancestors.has(name)) return;
    const nextAncestors = new Set(ancestors).add(name);
    for (const raw of runtimeUnknown.get(name) || []) {
      addUnknown({ root, from: name, raw, reason: 'unsupported-installation-dependency' });
    }
    for (const rawDependency of record.depends) {
      const dependency = parsePackageDependency(rawDependency);
      if (!dependency) continue;
      if (dependency.kind === 'menu-condition') {
        addUnknown({ root, from: name, raw: dependency.raw, reason: 'conditional-package-dependency' });
        continue;
      }
      const expanded = dependency.packages.map((target) => ({ target, ...expandTarget(target) }));
      const activeExpanded = hasSelection && dependency.kind === 'alternative'
        ? expanded.filter((item) => item.names.some((target) => selectedPackages.has(target)))
        : expanded;
      const missing = activeExpanded.filter((item) => !item.names.length);
      if (missing.length) {
        addUnknown({ root, from: name, target: dependency.packages, raw: dependency.raw,
          reason: 'package-metadata-unresolved', alternatives: dependency.packages });
        continue;
      }
      if (dependency.condition) {
        addUnknown({ root, from: name, target: dependency.packages, raw: dependency.raw,
          reason: 'conditional-package-dependency', condition: dependency.condition });
        continue;
      }
      const ambiguous = activeExpanded.some((item) => item.ambiguous);
      if (ambiguous || (dependency.kind === 'alternative' &&
          (!hasSelection || activeExpanded.length !== 1))) {
        addUnknown({ root, from: name, target: dependency.packages, raw: dependency.raw,
          reason: dependency.kind === 'alternative' ? 'alternative-package-dependency' : 'virtual-provider-ambiguous',
          alternatives: dependency.packages, selected: hasSelection ? [...selectedPackages].sort() : undefined });
        continue;
      }
      const candidates = activeExpanded.flatMap((item) => item.names);
      for (const target of candidates) visit(target, root, [...path, target],
        [...edges, { from: name, to: target, raw: dependency.raw, relation: 'package-depends',
          alternatives: dependency.packages }], nextAncestors);
    }
  };
  for (const root of rootNames) {
    if (!byName.has(root)) {
      addUnknown({ root, target: root, reason: 'package-metadata-unresolved', path: [root] });
      continue;
    }
    visit(root, root, [root], [], new Set());
  }
  return {
    result: paths.length ? 'reachable' : unknown.length ? 'inconclusive' : 'clear',
    roots: rootNames, failedPackages: targetNames, paths, unknown, packageCount: byName.size,
  };
}

function objectFromMap(map) {
  return Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => [key,
      [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ''))]
        .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))]));
}

function emptyPackageInfo() {
  return {
    depends: [], rawDepends: [], provides: [], conflicts: [],
    providesRelations: [], conflictsRelations: [], dependencyRelations: [],
  };
}

function capabilityRelation(raw, owner, packageByName, providerMap, provided = false) {
  const name = provided ? providedCapabilityName(raw) : packageName(raw);
  if (!name) return null;
  const concrete = packageByName.has(name);
  const providers = concrete ? [name] : [...(providerMap.get(name) || [])];
  return {
    raw: String(raw ?? ''), name,
    kind: concrete ? 'concrete' : providers.length ? 'virtual' : 'unknown',
    providers,
    // A package can provide a capability which it also lists in Conflicts.
    // Consumers must not treat that owner-self relation as an external
    // conflict; keep both the complete provider set and the effective set.
    effectiveProviders: providers.filter((provider) => provider !== owner),
    ownerSelf: providers.includes(owner),
  };
}

function normalizeChoice(choice, records = [], menuOptions = []) {
  const id = String(choice?.id || '');
  const depends = [...(choice?.depends || [])];
  const selectRelations = [...(choice?.selectRelations || [])];
  const implyRelations = [...(choice?.implyRelations || [])];
  // Symbol rows are sorted for stable wire encoding. Choice fallback is not:
  // native Kconfig uses declaration order, including sourced definitions.
  const memberRecords = records.filter((record) => record.choice === id);
  const available = new Set(memberRecords.map((record) => record.configSymbol));
  const members = unique(menuOptions.filter((option) => option.choice === id)
    .map((option) => option.symbol));
  const orderComplete = [...available].every((symbol) => members.includes(symbol));
  for (const record of memberRecords) if (!members.includes(record.configSymbol)) members.push(record.configSymbol);
  return {
    id,
    memberOrder: orderComplete ? 'native-declaration-v1' : 'unresolved',
    symbol: choice?.symbol || '',
    // An omitted choice type is not proof of bool.  Preserve the source value
    // (including empty/unknown) so the shared evaluator can apply native
    // Kconfig choice semantics instead of silently narrowing it.
    type: choice?.type || '',
    prompt: choice?.prompt || '',
    optional: choice?.optional === true,
    modules: choice?.modules === true || (choice?.optionFlags || []).includes('modules'),
    options: [...(choice?.options || [])],
    optionFlags: [...(choice?.optionFlags || [])],
    depends,
    dependsAst: Array.isArray(choice?.dependsAst) && choice.dependsAst.length
      ? [...choice.dependsAst] : depends.map((value) => parseKconfigExpression(value)),
    directDepends: [...(choice?.directDepends || [])],
    inheritedDepends: [...(choice?.inheritedDepends || [])],
    promptIf: [...(choice?.promptIf || [])],
    promptConditions: [...(choice?.promptConditions || choice?.promptIf || [])],
    visibleIf: [...(choice?.visibleIf || [])],
    menuVisibleIf: [...(choice?.menuVisibleIf || [])],
    visibility: choice?.visibility || {
      promptIf: [...(choice?.promptIf || [])],
      menuVisibleIf: [...(choice?.menuVisibleIf || [])],
      effective: [...(choice?.visibleIf || [])],
    },
    selectRelations: selectRelations.length ? selectRelations : (choice?.selects || []).map(parseKconfigRelation),
    implyRelations: implyRelations.length ? implyRelations : (choice?.implies || []).map(parseKconfigRelation),
    resetIf: [...(choice?.resetIf || [])],
    resetIfAst: Array.isArray(choice?.resetIfAst) && choice.resetIfAst.length
      ? [...choice.resetIfAst] : [...(choice?.resetIf || [])].map((value) => parseKconfigExpression(value)),
    defaults: [...(choice?.defaults || [])],
    defaultsTyped: [...(choice?.defaultsTyped || [])],
    ranges: [...(choice?.ranges || [])],
    rangesTyped: [...(choice?.rangesTyped || [])],
    source: choice?.source || '', location: choice?.location || null,
    members,
  };
}

function normalizeTypedDefaults(option) {
  if (Array.isArray(option?.defaultsTyped) && option.defaultsTyped.length) return option.defaultsTyped;
  return (option?.defaults || []).map((raw) => ({
    type: option?.type || '', raw: String(raw ?? ''), value: String(raw ?? ''),
    valueKind: 'expression', condition: '',
  }));
}

function normalizeTypedRanges(option) {
  if (Array.isArray(option?.rangesTyped) && option.rangesTyped.length) return option.rangesTyped;
  return (option?.ranges || []).map((raw) => ({
    type: option?.type || '', raw: String(raw ?? ''), min: '', max: '',
    minRaw: '', maxRaw: '', minKind: 'expression', maxKind: 'expression', condition: '',
  }));
}

// Typed defaults/ranges carry expressions outside the ordinary depends/select
// fields.  Parse those expressions with the same Kconfig AST as every other
// relation instead of searching raw text (which would mistake string
// literals, numbers, or comments for symbol references).
function typedExpressionRows(defaultsTyped = [], rangesTyped = []) {
  const rows = [];
  const add = (field, raw, owner, kind) => {
    const text = String(raw ?? '').trim();
    if (!text) return;
    rows.push({ field, kind, owner, ...parseKconfigExpression(text) });
  };
  for (const [index, value] of (defaultsTyped || []).entries()) {
    if (value?.valueKind === 'expression') {
      const split = splitKconfigIfClause(value.raw ?? value.value ?? '');
      add(`defaults[${index}].value`, split.value, value, 'default-value');
    }
    if (value?.condition) add(`defaults[${index}].condition`, value.condition, value, 'default-condition');
  }
  for (const [index, value] of (rangesTyped || []).entries()) {
    if (value?.minKind === 'expression') add(`ranges[${index}].min`, value.minRaw, value, 'range-bound');
    if (value?.maxKind === 'expression') add(`ranges[${index}].max`, value.maxRaw, value, 'range-bound');
    if (value?.condition) add(`ranges[${index}].condition`, value.condition, value, 'range-condition');
  }
  return rows;
}

function relationSymbols(rows = []) {
  return unique(rows.flatMap((row) => [
    ...(row?.targetSymbols || []), ...(row?.conditionSymbols || []),
  ]));
}

function optionReferenceRows(kconfig, defaultsTyped, rangesTyped) {
  const rows = [];
  const addAsts = (field, astRows = []) => {
    for (const [index, row] of astRows.entries()) {
      if (row?.ast || row?.symbols) rows.push({ field: `${field}[${index}]`, ...row });
    }
  };
  for (const field of [
    'dependsAst', 'directDependsAst', 'inheritedDependsAst',
    'promptIfAst', 'visibleIfAst', 'menuVisibleIfAst',
    'directVisibleIfAst', 'inheritedVisibleIfAst', 'inheritedMenuVisibleIfAst',
  ]) {
    addAsts(field, kconfig?.[field] || []);
    addAsts(`${field}Variants`, (kconfig?.[`${field}Variants`] || []).flat());
  }
  for (const field of ['selectRelations', 'implyRelations']) {
    const relationRows = [
      ...(kconfig?.[field] || []),
      ...(kconfig?.[`${field}Variants`] || []).flat(),
    ];
    for (const [index, row] of relationRows.entries()) {
      rows.push({ field: `${field}[${index}].target`, ...parseKconfigExpression(row?.targetExpression || row?.target || '') });
      if (row?.condition) rows.push({ field: `${field}[${index}].condition`, ...parseKconfigExpression(row.condition) });
      // Prefer the symbols captured from relation ASTs when available.  The
      // parsed rows above are still retained for completeness diagnostics.
      rows.push({ field: `${field}[${index}]`, symbols: relationSymbols([row]), ast: row?.targetAst || null,
        complete: row?.complete !== false, raw: row?.raw || '' });
    }
  }
  rows.push(...typedExpressionRows(defaultsTyped, rangesTyped));
  return rows;
}

function choiceReferenceRows(choice) {
  const rows = [];
  const addAsts = (field, values = []) => {
    for (const [index, value] of values.entries()) {
      const parsed = value?.ast || value?.symbols ? value : parseKconfigExpression(value);
      rows.push({ field: `${field}[${index}]`, ...parsed });
    }
  };
  for (const field of ['dependsAst', 'resetIfAst']) addAsts(field, choice?.[field] || []);
  for (const field of ['promptIf', 'visibleIf', 'menuVisibleIf']) addAsts(field, choice?.[field] || []);
  for (const field of ['selectRelations', 'implyRelations']) {
    for (const [index, row] of (choice?.[field] || []).entries()) {
      rows.push({ field: `${field}[${index}].target`, symbols: relationSymbols([row]),
        ast: row?.targetAst || null, complete: row?.complete !== false, raw: row?.raw || '' });
      if (row?.condition) rows.push({ field: `${field}[${index}].condition`,
        ...parseKconfigExpression(row.condition) });
    }
  }
  rows.push(...typedExpressionRows(choice?.defaultsTyped || [], choice?.rangesTyped || []));
  return rows;
}

function parserSymbolProof(parserValidation) {
  const parser = parserValidation && typeof parserValidation === 'object' ? parserValidation : null;
  const rows = Array.isArray(parser?.options) ? parser.options : null;
  const reasons = [];
  if (!parser) reasons.push('parser-validation-missing');
  if (!rows) reasons.push('full-symbol-definitions-missing');
  if (parser?.relationsComplete !== true) reasons.push('parser-not-complete');
  if (parser?.capabilityMatrixComplete !== true) reasons.push('parser-capability-incomplete');
  if (parser?.parserFixtureValidated !== true) reasons.push('parser-fixture-incomplete');
  if ((parser?.structuralErrors || []).length) reasons.push('source-traversal-incomplete');
  if ((parser?.unsupportedDirectives || []).length) reasons.push('unsupported-kconfig-directive');
  if ((parser?.dynamicExpressions || []).length) reasons.push('dynamic-expression-unresolved');
  if (rows && rows.some((row) => !row?.symbol || !row?.source || !row?.location?.file ||
      !Number.isSafeInteger(row?.location?.line) || row.location.line < 1)) {
    reasons.push('definition-provenance-incomplete');
  }
  const symbols = new Set((rows || []).map((row) => String(row?.symbol || '').trim()).filter(Boolean));
  const definitions = new Map((rows || []).map((row) => [
    String(row?.symbol || '').trim(), String(row?.type || '').trim(),
  ]).filter(([symbol]) => symbol));
  return {
    complete: reasons.length === 0,
    available: Boolean(parser),
    symbols,
    definitions,
    metadata: {
      available: Boolean(parser),
      complete: reasons.length === 0,
      source: 'parseKconfigTree.active-source-closure',
      definitionCount: symbols.size,
      reasons,
    },
  };
}

function kconfigRecordFields(option) {
  const dependsVariants = expressionVariants(option, 'depends');
  const selectsVariants = expressionVariants(option, 'selects');
  const impliesVariants = expressionVariants(option, 'implies');
  const dependsAstVariants = expressionAstVariants(option, 'depends');
  const directDependsAstVariants = expressionAstVariants(option, 'directDepends');
  const inheritedDependsAstVariants = expressionAstVariants(option, 'inheritedDepends');
  const selectRelationsVariants = relationVariants(option, 'selectRelations', 'selects');
  const implyRelationsVariants = relationVariants(option, 'implyRelations', 'implies');
  const promptIfAstVariants = expressionAstVariants(option, 'promptIf');
  const visibleIfAstVariants = expressionAstVariants(option, 'visibleIf');
  const menuVisibleIfAstVariants = expressionAstVariants(option, 'menuVisibleIf');
  const directVisibleIfAstVariants = expressionAstVariants(option, 'directVisibleIf');
  const inheritedVisibleIfAstVariants = expressionAstVariants(option, 'inheritedVisibleIf');
  const inheritedMenuVisibleIfAstVariants = expressionAstVariants(option, 'inheritedMenuVisibleIf');
  return {
    depends: packageSymbols(dependsVariants.flat()),
    selects: packageSymbols(selectsVariants.flat()),
    implies: packageSymbols(impliesVariants.flat()),
    dependsVariants: dependsVariants.map((items) => packageSymbols(items)),
    selectsVariants: selectsVariants.map((items) => packageSymbols(items)),
    impliesVariants: impliesVariants.map((items) => packageSymbols(items)),
    dependsExpressions: dependsVariants,
    selectsExpressions: selectsVariants,
    impliesExpressions: impliesVariants,
    dependsAstVariants,
    dependsAst: dependsAstVariants[0] || [],
    directDependsAstVariants,
    directDependsAst: directDependsAstVariants[0] || [],
    inheritedDependsAstVariants,
    inheritedDependsAst: inheritedDependsAstVariants[0] || [],
    selectRelationsVariants,
    implyRelationsVariants,
    selectRelations: selectRelationsVariants.flat(),
    implyRelations: implyRelationsVariants.flat(),
    promptIfAstVariants,
    promptIfAst: promptIfAstVariants[0] || [],
    visibleIfAstVariants,
    visibleIfAst: visibleIfAstVariants[0] || [],
    menuVisibleIfAstVariants,
    menuVisibleIfAst: menuVisibleIfAstVariants[0] || [],
    directVisibleIfAstVariants,
    directVisibleIfAst: directVisibleIfAstVariants[0] || [],
    inheritedVisibleIfAstVariants,
    inheritedVisibleIfAst: inheritedVisibleIfAstVariants[0] || [],
    inheritedMenuVisibleIfAstVariants,
    inheritedMenuVisibleIfAst: inheritedMenuVisibleIfAstVariants[0] || [],
    relationIssues: [
      ...dependsAstVariants.flat().filter((row) => row.complete === false),
      ...selectRelationsVariants.flat().filter((row) => row.complete === false),
      ...implyRelationsVariants.flat().filter((row) => row.complete === false),
      ...promptIfAstVariants.flat().filter((row) => row.complete === false),
      ...visibleIfAstVariants.flat().filter((row) => row.complete === false),
      ...menuVisibleIfAstVariants.flat().filter((row) => row.complete === false),
      ...directVisibleIfAstVariants.flat().filter((row) => row.complete === false),
      ...inheritedVisibleIfAstVariants.flat().filter((row) => row.complete === false),
      ...inheritedMenuVisibleIfAstVariants.flat().filter((row) => row.complete === false),
    ],
    dependsAllSymbols: allExpressionSymbols(dependsVariants.flat()),
    selectsAllSymbols: allExpressionSymbols(selectsVariants.flat()),
    impliesAllSymbols: allExpressionSymbols(impliesVariants.flat()),
  };
}

function directRelationCapabilityMatrix(context = {}) {
  const records = Array.isArray(context.records) ? context.records : [];
  const choices = Array.isArray(context.choices) ? context.choices : [];
  const edges = Array.isArray(context.edges) ? context.edges : [];
  const indexes = context.indexes || {};
  const relationRows = records.flatMap((record) => [
    ...(record.kconfig?.dependsAst || []), ...(record.kconfig?.selectRelations || []),
    ...(record.kconfig?.implyRelations || []),
  ]);
  const packageRelations = records.flatMap((record) => [
    ...(record.dependencyRelations || []), ...(record.providesRelations || []),
    ...(record.conflictsRelations || []),
  ]);
  const matrix = {
    'kconfig-expression-ast-v1': relationRows.every((row) => row?.complete === true &&
      (row.ast || row.targetAst)),
    'typed-kconfig-v1': records.every((record) => Array.isArray(record.defaultsTyped) &&
      Array.isArray(record.rangesTyped)),
    'conditional-defaults-v1': records.flatMap((record) => record.defaultsTyped || [])
      .every((row) => typeof row.condition === 'string'),
    'conditional-ranges-v1': records.flatMap((record) => record.rangesTyped || [])
      .every((row) => typeof row.condition === 'string'),
    'visibility-conditions-v1': records.every((record) => record.visibility &&
      Array.isArray(record.visibleIf) && Array.isArray(record.menuVisibleIf)),
    'choice-relations-v1': choices.every((choice) => Array.isArray(choice.dependsAst) &&
      Array.isArray(choice.selectRelations) && Array.isArray(choice.implyRelations)),
    'choice-reset-conditions-v1': choices.every((choice) => Array.isArray(choice.resetIf) &&
      Array.isArray(choice.resetIfAst) &&
      choice.resetIfAst.every((condition) => condition?.complete === true)),
    'module-semantics-v1': records.every((record) => typeof record.modules === 'boolean'),
    'typed-package-capabilities-v1': packageRelations.every((row) => row &&
      (typeof row.kind === 'string' || typeof row.raw === 'string')),
    'alternatives-v1': records.flatMap((record) => record.dependencyRelations || [])
      .every((row) => Array.isArray(row.packages) && Array.isArray(row.targets)),
    'forward-reverse-edges-v1': relationIndexValidation(edges, indexes.forwardEdges, indexes.reverseEdges).valid,
  };
  return matrix;
}

function parserContract(options = {}, context = {}) {
  const parser = options.parserValidation;
  // Callers that construct relation rows directly do not have a tree-level
  // parser report. Their normalized rows and indexes still provide a local
  // structural proof; absence of the report must not bypass validation.
  if (!parser || typeof parser !== 'object') {
    const capabilityMatrix = directRelationCapabilityMatrix(context);
    const capabilityMatrixComplete = KCONFIG_RELATION_CAPABILITIES.every((capability) =>
      capabilityMatrix[capability] === true);
    return {
      capabilityMatrixComplete, parserFixtureValidated: capabilityMatrixComplete,
      unsupportedDirectives: [], structuralErrors: [], variableAssignments: [], dynamicExpressions: [],
      capabilityMatrix,
    };
  }
  const capabilityMatrix = parser.capabilityMatrix && typeof parser.capabilityMatrix === 'object'
    ? parser.capabilityMatrix : {};
  const required = Array.isArray(parser.requiredRelationCapabilities) && parser.requiredRelationCapabilities.length
    ? parser.requiredRelationCapabilities : KCONFIG_RELATION_CAPABILITIES;
  const missing = required.filter((capability) => capabilityMatrix[capability] !== true);
  const parserFixtureValidated = parser.parserFixtureValidated === true;
  return {
    capabilityMatrixComplete: parser.capabilityMatrixComplete === true && parserFixtureValidated && missing.length === 0,
    parserFixtureValidated,
    unsupportedDirectives: Array.isArray(parser.unsupportedDirectives) ? parser.unsupportedDirectives : [],
    structuralErrors: [
      ...(Array.isArray(parser.structuralErrors) ? parser.structuralErrors : []),
      ...(Array.isArray(parser.conflicts) ? parser.conflicts : []),
    ],
    variableAssignments: Array.isArray(parser.variableAssignments) ? parser.variableAssignments : [],
    dynamicExpressions: Array.isArray(parser.dynamicExpressions) ? parser.dynamicExpressions : [],
    capabilityMatrix,
  };
}

function relationIndexValidation(edges, forwardEdges, reverseEdges) {
  const reasons = [];
  const forward = forwardEdges || {};
  const reverse = reverseEdges || {};
  const expectedForward = new Map();
  const expectedReverse = new Map();
  edges.forEach((edge, id) => {
    const from = expectedForward.get(edge.from) || [];
    from.push(id); expectedForward.set(edge.from, from);
    const to = expectedReverse.get(edge.to) || [];
    to.push(id); expectedReverse.set(edge.to, to);
    if (!(forward[edge.from] || []).includes(id) || !(reverse[edge.to] || []).includes(id)) {
      reasons.push({ reason: 'edge-index-not-bidirectional', id, from: edge.from, to: edge.to });
    }
  });
  for (const [from, ids] of expectedForward) {
    if (JSON.stringify(forward[from] || []) !== JSON.stringify(ids)) {
      reasons.push({ reason: 'forward-edge-index-mismatch', from, expected: ids, actual: forward[from] || [] });
    }
  }
  for (const [to, ids] of expectedReverse) {
    if (JSON.stringify(reverse[to] || []) !== JSON.stringify(ids)) {
      reasons.push({ reason: 'reverse-edge-index-mismatch', to, expected: ids, actual: reverse[to] || [] });
    }
  }
  return { valid: reasons.length === 0, reasons };
}

/**
 * Build source-derived relationship data.  The readable schema deliberately
 * keeps typed Kconfig facts and provenance; compact-relations.mjs is the only
 * serializer and must retain every field needed by the shared evaluator.
 */
export function buildKconfigRelations(menuOptions = [], packages = [], choices = [], options = {}) {
  const optionBySymbol = new Map(menuOptions.map((option) => [option.symbol, option]));
  const packageByName = new Map(packages.map((item) => [item.name, item]));
  const choiceIds = new Set(choices.map((choice) => choice.id));
  const externalSymbolSources = options.externalSymbolSources && typeof options.externalSymbolSources === 'object'
    ? Object.fromEntries(Object.entries(options.externalSymbolSources).map(([symbol, sources]) => [
      symbol, unique(Array.isArray(sources) ? sources : [sources]),
    ])) : {};
  const parserProof = parserSymbolProof(options.parserValidation);
  const provenExternalSymbols = new Set(Object.entries(externalSymbolSources)
    .filter(([symbol, sources]) => parserProof.complete && parserProof.symbols.has(symbol) &&
      Array.isArray(sources) && sources.includes('parsed-target-filter'))
    .map(([symbol]) => symbol));
  const provenExternalDefinitions = [...provenExternalSymbols].sort().map((symbol) => ({
    symbol, type: parserProof.definitions.get(symbol) || '',
  }));
  const records = [];
  const seenPackages = new Set();
  const unresolvedKconfig = [];
  const kconfigUndefinedSymbols = [];
  const unresolvedPackageDependencies = [];
  const unresolvedConflicts = [];
  const invalidChoices = [];
  const unknownRelations = [];
  const unknownPackageRelations = [];
  const providerMap = new Map();

  // A bare name in Provides is a virtual capability only when it is not also
  // a concrete package.  This keeps PACKAGE_<real-package> and a capability
  // such as libudev separate identities.
  for (const item of packages) {
    for (const provided of item.provides || []) {
      const name = providedCapabilityName(provided);
      if (!name || packageByName.has(name)) continue;
      const rows = providerMap.get(name) || [];
      rows.push(item.name);
      providerMap.set(name, rows);
    }
  }
  for (const [name, rows] of providerMap) providerMap.set(name, unique(rows).sort());

  const makeRecord = (option, packageInfo = null, packageOnly = false) => {
    const isPackage = Boolean(packageInfo);
    const name = packageInfo?.name || (isPackage ? String(option?.symbol || '').slice('PACKAGE_'.length) : '');
    const kconfig = packageOnly ? {
      depends: [], selects: [], implies: [], dependsVariants: [], selectsVariants: [], impliesVariants: [],
      dependsExpressions: [], selectsExpressions: [], impliesExpressions: [],
      dependsAst: [], dependsAstVariants: [], selectRelations: [], selectRelationsVariants: [],
      implyRelations: [], implyRelationsVariants: [], relationIssues: [],
      dependsAllSymbols: [], selectsAllSymbols: [], impliesAllSymbols: [],
    } : kconfigRecordFields(option);
    const packageDepends = packageInfo?.depends || [];
    const parsedDepends = packageDepends.map(parsePackageDependency).filter(Boolean);
    const dependencyPackages = unique(parsedDepends.flatMap((item) => item.packages));
    const provides = packageInfo?.provides || [];
    const packageConflicts = [...(packageInfo?.conflicts || [])];
    const kconfigConflicts = packageOnly ? [] : (option?.kconfigConflicts || option?.conflicts || []);
    const providesRelations = provides.map((raw) => capabilityRelation(raw, name, packageByName, providerMap, true)).filter(Boolean);
    const conflictsRelations = (packageInfo?.conflicts || [])
      .map((raw) => capabilityRelation(raw, name, packageByName, providerMap)).filter(Boolean);
    const dependencyRelations = parsedDepends.map((dependency) => ({
      ...dependency,
      targets: dependency.packages.map((target) => capabilityRelation(target, name, packageByName, providerMap)).filter(Boolean),
    }));
    const missingDependencies = dependencyRelations.flatMap((dependency) => dependency.targets
      .filter((target) => target.kind === 'unknown').map((target) => target.name));
    const missingConflicts = conflictsRelations.filter((relation) => relation.kind === 'unknown').map((relation) => relation.name);
    const defaultsTyped = normalizeTypedDefaults(option);
    const rangesTyped = normalizeTypedRanges(option);
    const typedReferenceRows = typedExpressionRows(defaultsTyped, rangesTyped);
    const referenceRows = optionReferenceRows(kconfig, defaultsTyped, rangesTyped);
    const referencedSymbols = unique([
      ...(kconfig.dependsAst || []).flatMap((row) => row.symbols || []),
      ...(kconfig.selectRelations || []).flatMap((row) => [...(row.targetSymbols || []), ...(row.conditionSymbols || [])]),
      ...(kconfig.implyRelations || []).flatMap((row) => [...(row.targetSymbols || []), ...(row.conditionSymbols || [])]),
      ...(kconfig.promptIfAst || []).flatMap((row) => row.symbols || []),
      ...(kconfig.visibleIfAst || []).flatMap((row) => row.symbols || []),
      ...(kconfig.menuVisibleIfAst || []).flatMap((row) => row.symbols || []),
      ...referenceRows.flatMap((row) => row.symbols || []),
    ]);
    const missingSymbols = referencedSymbols.filter((symbol) =>
      !['y', 'm', 'n'].includes(symbol) && !optionBySymbol.has(symbol));
    for (const row of [...defaultsTyped, ...rangesTyped].filter((item) => item?.valid === false)) {
      unknownRelations.push({ symbol: option.symbol, relation: 'typed-kconfig-value', raw: row.raw || '', error: 'invalid-typed-value' });
    }
    for (const row of typedReferenceRows.filter((item) => item.complete === false)) {
      unknownRelations.push({ symbol: option.symbol, relation: 'typed-kconfig-expression',
        field: row.field, expression: row.raw, error: row.error });
    }
    if (kconfigConflicts.length) unknownRelations.push({
      symbol: option.symbol, relation: 'kconfig-type-conflict', conflicts: kconfigConflicts,
    });
    // PACKAGE_* references can legitimately point at a package-info row that
    // has no Kconfig definition (or at an omitted package metadata row). They
    // remain explicit graph references, while package-closure validation owns
    // their metadata completeness; only non-package Kconfig symbols are parser
    // relation errors.
    const missingKconfigSymbols = missingSymbols.filter((symbol) => !symbol.startsWith('PACKAGE_'));
    const missingPackageSymbols = missingSymbols.filter((symbol) => symbol.startsWith('PACKAGE_'));
    const unresolved = [];
    for (const missing of unique(missingKconfigSymbols)) {
      if (provenExternalSymbols.has(missing)) continue;
      if (parserProof.complete && !parserProof.symbols.has(missing)) {
        kconfigUndefinedSymbols.push({
          symbol: option.symbol, missing, reason: 'undefined-kconfig-symbol',
          nativeType: 'unknown', booleanValue: 'n', stringValue: missing,
        });
      } else unresolved.push(missing);
    }
    if (unresolved.length) unresolvedKconfig.push({ symbol: option.symbol, missing: unresolved });
    if (missingPackageSymbols.length) unresolvedPackageDependencies.push({
      package: name, missing: unique(missingPackageSymbols.map((symbol) => symbol.slice('PACKAGE_'.length))),
    });
    if (missingDependencies.length) unresolvedPackageDependencies.push({ package: name, missing: unique(missingDependencies) });
    if (missingConflicts.length) unresolvedConflicts.push({ package: name, missing: unique(missingConflicts) });
    if (option.choice && !choiceIds.has(option.choice)) invalidChoices.push(option.symbol);
    for (const relation of [...dependencyRelations.flatMap((item) => item.targets), ...conflictsRelations, ...providesRelations]) {
      if (relation.kind === 'unknown') unknownPackageRelations.push({
        package: name, relation: relation.raw, target: relation.name,
      });
    }
    for (const condition of [...(kconfig.promptIfAst || []), ...(kconfig.visibleIfAst || []), ...(kconfig.menuVisibleIfAst || [])]) {
      if (!condition.complete) unknownRelations.push({
        symbol: option?.symbol || '', relation: 'kconfig-visibility', expression: condition.raw, error: condition.error,
      });
    }
    const installation = packageInfo && projectNativePackageInstallation(packageInfo, options.packageInstallation);
    const packageFields = packageInfo ? {
      ...(installation ? { installation } : {}),
      depends: dependencyRelations,
      rawDepends: packageDepends,
      provides,
      conflicts: packageConflicts,
      packageConflicts,
      kconfigConflicts,
      providesRelations,
      conflictsRelations,
      dependencyRelations,
    } : emptyPackageInfo();
    const record = {
      kind: isPackage ? 'package' : 'config',
      package: name,
      configSymbol: option?.symbol || (packageInfo ? `PACKAGE_${packageInfo.name}` : ''),
      kconfigSymbol: packageOnly ? '' : option.symbol,
      symbol: packageOnly ? '' : option.symbol,
      // A package-info-only record has no Kconfig definition.  Keep that
      // provenance distinct even though its synthetic PACKAGE_* option is
      // used as the stable concrete-package identity.
      origin: packageOnly
        ? 'packageinfo-only'
        : (packageInfo
          ? (option.visible === false ? 'hidden-kconfig+packageinfo' : 'kconfig+packageinfo')
          : (option.visible === false ? 'hidden-kconfig-only' : 'kconfig-only')),
      states: packageOnly ? [] : statesFor(option),
      visible: packageOnly ? false : option.visible !== false,
      hidden: packageOnly ? true : option.visible === false,
      userSettable: packageOnly ? false : option.userSettable !== false && option.visible !== false,
      canDisable: true,
      choice: option?.choice || '',
      type: option?.type || '',
      defaults: option?.defaults || [],
      defaultsTyped,
      ranges: option?.ranges || [],
      rangesTyped,
      promptIf: option?.promptIf || [],
      promptConditions: option?.promptConditions || option?.promptIf || [],
      directDepends: option?.directDepends || [],
      inheritedDepends: option?.inheritedDepends || [],
      directVisibleIf: option?.directVisibleIf || [],
      inheritedVisibleIf: option?.inheritedVisibleIf || [],
      inheritedMenuVisibleIf: option?.inheritedMenuVisibleIf || [],
      visibleIf: option?.visibleIf || [],
      menuVisibleIf: option?.menuVisibleIf || [],
      visibility: {
        promptIf: option?.visibility?.promptIf || option?.promptIf || [],
        menuVisibleIf: option?.visibility?.menuVisibleIf || option?.menuVisibleIf || [],
        effective: option?.visibility?.effective || option?.visibleIf || [],
        direct: option?.visibility?.direct || option?.directVisibleIf || [],
        inherited: option?.visibility?.inherited || option?.inheritedVisibleIf || [],
        inheritedMenu: option?.visibility?.inheritedMenu || option?.inheritedMenuVisibleIf || [],
      },
      optionFlags: option?.optionFlags || [],
      options: option?.options || [],
      modules: option?.modules === true,
      optional: option?.optional === true,
      packageConflicts,
      kconfigConflicts,
      prompt: option?.prompt || packageInfo?.title || name || option?.symbol,
      title: packageInfo?.title || option?.prompt || name || option?.symbol,
      description: packageInfo?.description || option?.help || '',
      category: packageInfo?.category || '',
      submenu: packageInfo?.submenu || '',
      path: option?.path || [],
      parent: option?.parent || '',
      // Hand-built callers may provide an option without parser-produced
      // `nodes`; retain one normalized definition so compact round-trips do
      // not silently drop its AST/relation fields.
      nodes: packageOnly ? [] : (Array.isArray(option?.nodes) && option.nodes.length ? option.nodes : [option]),
      locations: option?.locations || (option?.location ? [option.location] : []),
      sources: option?.sources || (option?.source ? [option.source] : []),
      kconfig,
      dependsAst: kconfig.dependsAst || [],
      dependsAstVariants: kconfig.dependsAstVariants || [],
      selectRelations: kconfig.selectRelations || [],
      selectRelationsVariants: kconfig.selectRelationsVariants || [],
      implyRelations: kconfig.implyRelations || [],
      implyRelationsVariants: kconfig.implyRelationsVariants || [],
      relationIssues: kconfig.relationIssues || [],
      packageInfo: packageFields,
      packageDepends,
      dependencyPackages,
      provides,
      conflicts: packageConflicts,
      providesRelations,
      conflictsRelations,
      dependencyRelations,
      menuDepends: packageInfo?.menuDepends || '',
      architecture: packageInfo?.architecture || '',
    };
    if (isPackage) seenPackages.add(name);
    return record;
  };

  for (const option of menuOptions) {
    const name = String(option.symbol || '').startsWith('PACKAGE_')
      ? option.symbol.slice('PACKAGE_'.length) : '';
    records.push(makeRecord(option, name ? packageByName.get(name) || null : null));
  }
  for (const packageInfo of packages.filter((item) => !seenPackages.has(item.name))) {
    records.push(makeRecord({ symbol: `PACKAGE_${packageInfo.name}` }, packageInfo, true));
  }

  records.sort((a, b) => (a.configSymbol || a.package).localeCompare(b.configSymbol || b.package));
  const byPackage = new Map();
  const bySymbol = new Map();
  const reverseDependencies = new Map();
  const reverseKconfig = new Map();
  const reverseSelects = new Map();
  const reverseImplies = new Map();
  const forwardEdges = new Map();
  const reverseEdges = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const addIndex = (map, key, value) => {
    if (!key || value === undefined || value === null) return;
    const rows = map.get(key) || [];
    rows.push(value);
    map.set(key, rows);
  };
  const addEdge = (from, to, relation, extra = {}) => {
    if (!from || !to) return;
    const edge = { from, to, relation, ...extra };
    const key = JSON.stringify(edge);
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    const id = edges.length;
    edges.push(edge);
    addIndex(forwardEdges, from, id);
    addIndex(reverseEdges, to, id);
  };

  records.forEach((record, index) => {
    if (record.package) byPackage.set(record.package, index);
    if (record.configSymbol) bySymbol.set(record.configSymbol, index);
    for (const dependency of record.dependencyRelations) {
      for (const target of dependency.targets) {
        addIndex(reverseDependencies, target.name, record.package);
        addEdge(record.package || record.configSymbol, target.name, 'package-depends', {
          // Alternatives, conditional package deps, virtual capabilities and
          // unresolved targets are candidate references, not independently
          // required concrete edges.  Preserve the expression/target data
          // below so a consumer can prove the active branch first.
          required: dependency.kind === 'alternative' || dependency.condition ||
            target.kind === 'virtual' || target.kind === 'unknown' ? null : dependency.required,
          kind: target.kind, condition: dependency.condition,
          alternatives: dependency.packages.length > 1 ? [dependency.packages] : [],
        });
      }
    }
    for (const expression of record.kconfig.dependsAst || []) {
      if (!expression.complete) unknownRelations.push({
        symbol: record.configSymbol, relation: 'kconfig-depends', expression: expression.raw, error: expression.error,
      });
      for (const symbol of expression.symbols || []) {
        // This is a candidate/reference index only.  The AST and `required:
        // null` explicitly prevent an A || B expression from becoming two
        // mandatory graph edges.
        addIndex(reverseKconfig, symbol, record.configSymbol);
        addEdge(record.configSymbol, symbol, 'kconfig-depends-reference', {
          required: null, kind: 'expression-reference', expression: expression.raw,
          expressionAst: expression.ast, alternatives: expression.alternatives,
        });
      }
    }
    for (const relation of record.kconfig.selectRelations || []) {
      if (!relation.complete || !relation.target) unknownRelations.push({
        symbol: record.configSymbol, relation: 'kconfig-select', expression: relation.raw, error: relation.error,
      });
      if (relation.target) {
        addIndex(reverseSelects, relation.target, record.configSymbol);
        addEdge(record.configSymbol, relation.target, 'kconfig-select', {
          required: null, kind: 'relation-target', expression: relation.raw,
          condition: relation.condition, expressionAst: relation.targetAst, conditionAst: relation.conditionAst,
          alternatives: relation.alternatives,
        });
      }
      for (const symbol of relation.conditionSymbols || []) addIndex(reverseKconfig, symbol, record.configSymbol);
    }
    for (const relation of record.kconfig.implyRelations || []) {
      if (!relation.complete || !relation.target) unknownRelations.push({
        symbol: record.configSymbol, relation: 'kconfig-imply', expression: relation.raw, error: relation.error,
      });
      if (relation.target) {
        addIndex(reverseImplies, relation.target, record.configSymbol);
        addEdge(record.configSymbol, relation.target, 'kconfig-imply', {
          required: null, kind: 'relation-target', expression: relation.raw,
          condition: relation.condition, expressionAst: relation.targetAst, conditionAst: relation.conditionAst,
          alternatives: relation.alternatives,
        });
      }
      for (const symbol of relation.conditionSymbols || []) addIndex(reverseKconfig, symbol, record.configSymbol);
    }
    for (const issue of record.kconfig.relationIssues || []) {
      if (!unknownRelations.some((row) => row.symbol === record.configSymbol && row.expression === issue.raw)) {
        unknownRelations.push({ symbol: record.configSymbol, relation: 'kconfig', expression: issue.raw, error: issue.error });
      }
    }
    for (const capability of record.providesRelations) {
      addEdge(record.package || record.configSymbol, capability.name, 'provides', {
        kind: capability.kind, ownerSelf: capability.ownerSelf,
      });
    }
    for (const capability of record.conflictsRelations) {
      addEdge(record.package || record.configSymbol, capability.name, 'conflicts', {
        kind: capability.kind, providers: capability.effectiveProviders,
        ownerSelf: capability.ownerSelf,
      });
    }
  });

  const choiceDefinitions = choices.map((choice) => normalizeChoice(choice, records, options.choiceOptions || menuOptions));
  for (const choice of choiceDefinitions) {
    const choiceReferenceRowsValue = choiceReferenceRows(choice);
    const missingChoiceSymbols = unique(choiceReferenceRowsValue.flatMap((row) => row.symbols || []))
      .filter((symbol) => !['y', 'm', 'n'].includes(symbol) &&
        !optionBySymbol.has(symbol) && !symbol.startsWith('PACKAGE_'));
    const unresolvedChoiceSymbols = [];
    for (const missing of missingChoiceSymbols) {
      if (provenExternalSymbols.has(missing)) continue;
      if (parserProof.complete && !parserProof.symbols.has(missing)) {
        kconfigUndefinedSymbols.push({
          symbol: choice.symbol || choice.id, choice: choice.id, missing,
          reason: 'undefined-kconfig-symbol', nativeType: 'unknown',
          booleanValue: 'n', stringValue: missing,
        });
      } else unresolvedChoiceSymbols.push(missing);
    }
    if (unresolvedChoiceSymbols.length) unresolvedKconfig.push({
      symbol: choice.symbol || choice.id, choice: choice.id, missing: unresolvedChoiceSymbols,
    });
    const missingChoicePackages = unique(choiceReferenceRowsValue.flatMap((row) => row.symbols || []))
      .filter((symbol) => symbol.startsWith('PACKAGE_') && !optionBySymbol.has(symbol) &&
        !provenExternalSymbols.has(symbol));
    if (missingChoicePackages.length) unresolvedPackageDependencies.push({
      package: choice.symbol || choice.id,
      missing: missingChoicePackages.map((symbol) => symbol.slice('PACKAGE_'.length)),
    });
    for (const expression of choice.dependsAst || []) {
      if (!expression.complete) unknownRelations.push({
        choice: choice.id, relation: 'choice-depends', expression: expression.raw, error: expression.error,
      });
    }
    for (const relation of [...(choice.selectRelations || []), ...(choice.implyRelations || [])]) {
      if (!relation.complete || !relation.target) unknownRelations.push({
        choice: choice.id, relation: 'choice-relation', expression: relation.raw, error: relation.error,
      });
    }
    for (const condition of choice.resetIfAst || choice.resetIf || []) {
      const parsed = condition?.ast ? condition : parseKconfigExpression(condition);
      if (!parsed.complete) unknownRelations.push({
        choice: choice.id, relation: 'choice-reset', expression: parsed.raw, error: parsed.error,
      });
    }
    for (const condition of [...(choice.promptIf || []), ...(choice.visibleIf || []), ...(choice.menuVisibleIf || [])]) {
      const parsed = condition?.ast ? condition : parseKconfigExpression(condition);
      if (!parsed.complete) unknownRelations.push({
        choice: choice.id, relation: 'choice-visibility', expression: parsed.raw, error: parsed.error,
      });
    }
    for (const row of choiceReferenceRowsValue.filter((item) => item.complete === false &&
      /^(defaults|ranges)\[/.test(item.field))) {
      unknownRelations.push({ choice: choice.id, relation: 'choice-typed-kconfig-expression',
        field: row.field, expression: row.raw, error: row.error });
    }
  }
  const choicesIndex = Object.fromEntries(choiceDefinitions.map((choice) => [choice.id, choice.members]));
  const normalizedUnknown = [
    ...unknownRelations,
    ...kconfigUndefinedSymbols.flatMap((row) => [row.missing].flat().filter(Boolean)
      .map((target) => ({ ...row, target, relation: 'kconfig-undefined' }))),
    ...unresolvedKconfig.flatMap((row) => row.missing.map((target) => ({ ...row, target, relation: 'kconfig-unresolved' }))),
    ...unresolvedPackageDependencies.flatMap((row) => row.missing.map((target) => ({ ...row, target, relation: 'package-depends' }))),
    ...unresolvedConflicts.flatMap((row) => row.missing.map((target) => ({ ...row, target, relation: 'conflicts' }))),
  ];
  const normalizedKconfigUnknown = [
    ...unknownRelations,
    ...unresolvedKconfig.flatMap((row) => row.missing.map((target) => ({
      ...row, target, relation: 'kconfig-unresolved',
    }))),
  ];
  const relationIndexes = {
    forwardEdges: Object.fromEntries(forwardEdges),
    reverseEdges: Object.fromEntries(reverseEdges),
  };
  const parser = parserContract(options, {
    records, choices: choiceDefinitions, edges, indexes: relationIndexes,
  });
  const indexValidation = relationIndexValidation(edges, relationIndexes.forwardEdges, relationIndexes.reverseEdges);
  const structuralErrors = [
    ...parser.structuralErrors,
    ...invalidChoices.map((symbol) => ({ symbol, error: 'invalid-choice-reference' })),
    ...indexValidation.reasons,
  ];
  // This is a data contract, not an evaluator claim. A relation graph is
  // eligible for the complete capability only when every parser field is
  // supported, all source/graph diagnostics are empty, and the graph indexes
  // are internally bidirectional. The compact serializer performs the
  // independent readable/compact semantic round-trip before publishing true.
  const dataComplete = (!parserProof.available || parserProof.complete) &&
    parser.capabilityMatrixComplete && parser.parserFixtureValidated &&
    parser.unsupportedDirectives.length === 0 && structuralErrors.length === 0 &&
    normalizedKconfigUnknown.length === 0 && indexValidation.valid;
  const relationsComplete = dataComplete;
  const packageClosure = validatePackageClosureGraph(packages, records, {
    edges,
    indexes: {
      providers: objectFromMap(providerMap),
      reverseDependencies: objectFromMap(reverseDependencies),
      forwardEdges: objectFromMap(forwardEdges),
      reverseEdges: objectFromMap(reverseEdges),
    },
  });
  return {
    schema: 2,
    relationsComplete,
    packageClosureComplete: packageClosure.complete,
    ...(options.packageInstallation ? { packageInstallation: options.packageInstallation } : {}),
    packageClosureCapabilities: packageClosure.capabilities,
    packageClosureValidation: packageClosure.validation,
    capabilities: [
      ...KCONFIG_RELATION_CAPABILITIES,
      ...(relationsComplete ? ['complete-kconfig-relations-v1'] : []),
    ],
    records,
    choices: choiceDefinitions,
    edges,
    indexes: {
      byPackage: Object.fromEntries(byPackage),
      bySymbol: Object.fromEntries(bySymbol),
      providers: objectFromMap(providerMap),
      reverseDependencies: objectFromMap(reverseDependencies),
      reverseKconfig: objectFromMap(reverseKconfig),
      reverseSelects: objectFromMap(reverseSelects),
      reverseImplies: objectFromMap(reverseImplies),
      forwardEdges: objectFromMap(forwardEdges),
      reverseEdges: objectFromMap(reverseEdges),
      choices: choicesIndex,
    },
    summary: {
      symbols: records.filter((item) => item.kconfigSymbol).length,
      visibleSymbols: records.filter((item) => item.kconfigSymbol && item.visible).length,
      hiddenSymbols: records.filter((item) => item.kconfigSymbol && item.hidden).length,
      packages: records.filter((item) => item.package).length,
      kconfigPackages: records.filter((item) => item.package && item.kconfigSymbol).length,
      visibleKconfigPackages: records.filter((item) => item.package && item.kconfigSymbol && item.visible).length,
      hiddenKconfigPackages: records.filter((item) => item.package && item.kconfigSymbol && item.hidden).length,
      packageinfoOnly: records.filter((item) => item.origin === 'packageinfo-only').length,
      kconfigOnly: records.filter((item) => item.origin.endsWith('kconfig-only')).length,
      virtualCapabilities: [...providerMap.keys()].length,
      edges: edges.length,
    },
    validation: {
      structurallyValid: structuralErrors.length === 0 && parser.unsupportedDirectives.length === 0,
      relationsComplete,
      unresolvedKconfig,
      kconfigUndefinedSymbols,
      unresolvedPackageDependencies,
      unresolvedConflicts,
      invalidChoices,
      unknownRelations: normalizedUnknown,
      kconfigUnknownRelations: normalizedKconfigUnknown,
      packageUnknownRelations: [
        ...unknownPackageRelations,
        ...unresolvedPackageDependencies.flatMap((row) => row.missing.map((target) => ({ ...row, target, relation: 'package-depends' }))),
        ...unresolvedConflicts.flatMap((row) => row.missing.map((target) => ({ ...row, target, relation: 'conflicts' }))),
      ],
      unsupportedDirectives: parser.unsupportedDirectives,
      variableAssignments: parser.variableAssignments,
      dynamicExpressions: parser.dynamicExpressions,
      // Every accepted external symbol has an explicit provenance boundary:
      // it was parsed then removed by the Target Devices projection.  Symbols
      // supplied without a source row remain unresolved rather than silently
      // becoming an external context.
      externalSymbols: [...provenExternalSymbols].sort(),
      externalSymbolSources: Object.fromEntries([...provenExternalSymbols]
        .sort().map((symbol) => [symbol, externalSymbolSources[symbol]])),
      // Exact symbol/type pairs from the complete parser set.  This is the
      // only external-definition metadata AutoBuild may use for expression
      // typing; no source text or inferred prefix type is exposed here.
      externalSymbolDefinitions: provenExternalDefinitions,
      kconfigSymbolProof: parserProof.metadata,
      structuralErrors,
      dataComplete,
      sourceComplete: dataComplete,
      capabilityMatrixComplete: parser.capabilityMatrixComplete,
      capabilityMatrix: parser.capabilityMatrix,
      parserFixtureValidated: parser.parserFixtureValidated,
      roundTripValidated: false,
      relationCapabilities: KCONFIG_RELATION_CAPABILITIES,
    },
  };
}

export function packageCapabilityRelation(raw, owner, packages = []) {
  const packageByName = new Map(packages.map((item) => [item.name, item]));
  const providerMap = new Map();
  for (const item of packages) for (const provided of item.provides || []) {
    const name = providedCapabilityName(provided);
    if (!name || packageByName.has(name)) continue;
    const rows = providerMap.get(name) || [];
    rows.push(item.name); providerMap.set(name, rows);
  }
  return capabilityRelation(raw, owner, packageByName, providerMap);
}

export function isConcretePackageName(value, packages = []) {
  const name = packageName(value);
  return Boolean(name && packages.some((item) => item.name === name));
}
