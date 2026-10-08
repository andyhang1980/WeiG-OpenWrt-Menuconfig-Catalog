import { matchPattern, sourceBranchPatterns } from './source-policy.mjs';

const DOCUMENT_KEYS = new Set(['schema', 'rules']);
const RULE_KEYS_V2 = new Set(['id', 'issue', 'match', 'scope', 'if', 'packages', 'paths', 'refs']);
const RULE_KEYS_V3 = new Set([...RULE_KEYS_V2, 'sourceCommits', 'targetScope', 'failure']);
const RULE_KEYS_V4 = new Set([...RULE_KEYS_V3, 'buildDependency']);
const RULE_KEYS_V5 = new Set([...RULE_KEYS_V4, 'policy', 'environments', 'evidence']);
const RULE_KEYS_V6 = new Set([...RULE_KEYS_V5, 'preferredDisable']);
const RULE_KEYS_V7 = new Set([...RULE_KEYS_V6, 'preservePackages', 'inputHashes']);
const TARGET_SCOPE_KEYS = new Set(['system', 'subtarget', 'profile']);
const FAILURE_KEYS = new Set(['phase', 'cause', 'code', 'observed']);
const BUILD_DEPENDENCY_KEYS = new Set(['package', 'triggerPackages']);
const ENVIRONMENT_KEYS = new Set(['source', 'branch', 'packageAvailability', 'targetScope']);
const EVIDENCE_KEYS = new Set(['source', 'branch', 'sourceCommit', 'targetScope', 'refs']);
const RULE_ID_RE = /^[A-Z][A-Z0-9-]{2,31}$/;
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9+_.@-]{0,95}$/;
const SOURCE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,160}$/;
const BRANCH_PATTERN_RE = /^(?:\*|[A-Za-z0-9._/-]*\*[A-Za-z0-9._/-]*|[A-Za-z0-9._/-]{1,160})$/;
const PATH_RE = /^\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]{1,255}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9+_.:/@#-]{0,255}$/;
const CONDITION_RE = /^[A-Za-z0-9_().!&|=<>+\-\s\"']{1,512}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const INPUT_HASH_RE = /^[a-f0-9]{64}$/;
const TARGET_RE = /^[A-Za-z0-9_+@./-]{1,160}$/;
const FAILURE_CODE_RE = /^[a-z][a-z0-9-]{2,95}$/;
const OBSERVED_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const FAILURE_PHASES = new Set(['config-resolve', 'package-compile', 'rootfs-install', 'file-install', 'link', 'image-build']);
const FAILURE_CAUSES = new Set(['package-caused', 'dependency-caused', 'base-profile', 'infrastructure']);
const MAX_DOCUMENT_BYTES = 512 * 1024;

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
  }
}

function uniqueStrings(value, { label, min = 1, max, pattern }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} must contain ${min}-${max} entries`);
  }
  const rows = value.map((item) => String(item || '').trim());
  if (rows.some((item) => !pattern.test(item))) throw new Error(`${label} contains an invalid value`);
  if (new Set(rows).size !== rows.length) throw new Error(`${label} contains duplicate values`);
  return rows;
}

function normalizeScope(value, sourcePolicy, label) {
  if (!plainObject(value) || !Object.keys(value).length) throw new Error(`${label} must be a non-empty object`);
  const result = {};
  for (const [sourceId, rawBranches] of Object.entries(value)) {
    if ((sourceId !== '*' && !SOURCE_RE.test(sourceId)) || (sourceId !== '*' && !sourcePolicy.has(sourceId))) {
      throw new Error(`${label} references an unknown source: ${sourceId}`);
    }
    const branches = uniqueStrings(rawBranches, {
      label: `${label}.${sourceId}`, min: 1, max: 32, pattern: BRANCH_PATTERN_RE,
    });
    if (sourceId === '*' && Object.keys(value).length > 1) {
      throw new Error(`${label} cannot mix the wildcard source with named sources`);
    }
    const policies = sourceId === '*' ? [...sourcePolicy.values()] : [sourcePolicy.get(sourceId)];
    for (const branch of branches) {
      if (branch === '*') continue;
      const known = policies.some((policy) => sourceBranchPatterns(policy).some((pattern) =>
        matchPattern(branch, pattern) || matchPattern(pattern, branch)) &&
        !policy.exclude?.some((pattern) => matchPattern(branch, pattern)));
      if (!known) {
        throw new Error(`${label}.${sourceId} references a branch outside catalog.config.json: ${branch}`);
      }
    }
    result[sourceId] = branches;
  }
  return result;
}

function normalizeTargetScope(value, label) {
  if (!plainObject(value) || !Object.keys(value).length) throw new Error(`${label} must be a non-empty object`);
  rejectUnknownKeys(value, TARGET_SCOPE_KEYS, label);
  const result = {};
  for (const key of TARGET_SCOPE_KEYS) {
    if (value[key] === undefined) continue;
    result[key] = uniqueStrings(value[key], { label: `${label}.${key}`, min: 1, max: 32, pattern: TARGET_RE });
  }
  if (!Object.keys(result).length) throw new Error(`${label} must contain at least one target selector`);
  return result;
}

function normalizeEnvironmentTargetScope(value, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  if (!Object.keys(value).length) return {};
  return normalizeTargetScope(value, label);
}

function sourcePolicyBranchKnown(sourcePolicy, source, branch) {
  const sourceRow = sourcePolicy.get(source);
  if (!sourceRow) return false;
  return sourceBranchPatterns(sourceRow).some((pattern) =>
    matchPattern(branch, pattern) || matchPattern(pattern, branch)) &&
    !sourceRow.exclude?.some((pattern) => matchPattern(branch, pattern));
}

function normalizeEnvironments(value, sourcePolicy, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new Error(`${label} must contain 1-64 entries`);
  }
  const result = value.map((row, index) => {
    const rowLabel = `${label}[${index}]`;
    if (!plainObject(row)) throw new Error(`${rowLabel} must be an object`);
    rejectUnknownKeys(row, ENVIRONMENT_KEYS, rowLabel);
    const source = String(row.source || '').trim();
    const branch = String(row.branch || '').trim();
    const packageAvailability = String(row.packageAvailability || 'required').trim();
    if (source !== '*' && (!SOURCE_RE.test(source) || !sourcePolicy.has(source))) {
      throw new Error(`${rowLabel}.source references an unknown source: ${source}`);
    }
    if (!BRANCH_PATTERN_RE.test(branch)) throw new Error(`${rowLabel}.branch is invalid`);
    if (!['required', 'if-present'].includes(packageAvailability)) {
      throw new Error(`${rowLabel}.packageAvailability is invalid`);
    }
    if (source !== '*' && branch !== '*' && !sourcePolicyBranchKnown(sourcePolicy, source, branch)) {
      throw new Error(`${rowLabel}.branch is outside catalog.config.json`);
    }
    return {
      source,
      branch,
      packageAvailability,
      ...(row.targetScope === undefined ? {} : {
        targetScope: normalizeEnvironmentTargetScope(row.targetScope, `${rowLabel}.targetScope`),
      }),
    };
  });
  const keys = result.map((row) => JSON.stringify(row));
  if (new Set(keys).size !== keys.length) throw new Error(`${label} contains duplicate entries`);
  return result;
}

function normalizeEvidence(value, sourcePolicy, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new Error(`${label} must contain 1-64 entries`);
  }
  const result = value.map((row, index) => {
    const rowLabel = `${label}[${index}]`;
    if (!plainObject(row)) throw new Error(`${rowLabel} must be an object`);
    rejectUnknownKeys(row, EVIDENCE_KEYS, rowLabel);
    const source = String(row.source || '').trim();
    const branch = String(row.branch || '').trim();
    const sourceCommit = String(row.sourceCommit || '').trim().toLowerCase();
    if (!SOURCE_RE.test(source) || !sourcePolicy.has(source)) {
      throw new Error(`${rowLabel}.source references an unknown source: ${source}`);
    }
    if (!BRANCH_RE.test(branch) || branch.includes('*') || !sourcePolicyBranchKnown(sourcePolicy, source, branch)) {
      throw new Error(`${rowLabel}.branch is not an exact Catalog branch`);
    }
    if (!COMMIT_RE.test(sourceCommit)) throw new Error(`${rowLabel}.sourceCommit is invalid`);
    return {
      source,
      branch,
      sourceCommit,
      ...(row.targetScope === undefined ? {} : {
        targetScope: normalizeEnvironmentTargetScope(row.targetScope, `${rowLabel}.targetScope`),
      }),
      refs: uniqueStrings(row.refs, { label: `${rowLabel}.refs`, min: 1, max: 8, pattern: REF_RE }),
    };
  });
  const keys = result.map((row) => `${row.source}\0${row.branch}\0${row.sourceCommit}\0${JSON.stringify(row.targetScope || {})}`);
  if (new Set(keys).size !== keys.length) throw new Error(`${label} contains duplicate exact identities`);
  return result;
}

function normalizeObserved(value, label) {
  if (!plainObject(value) || !Object.keys(value).length || Object.keys(value).length > 16) {
    throw new Error(`${label} must contain 1-16 evidence fields`);
  }
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!OBSERVED_KEY_RE.test(key)) throw new Error(`${label} contains an invalid evidence field`);
    if (typeof raw === 'string' && raw.trim() && raw.length <= 512) result[key] = raw.trim();
    else if (Array.isArray(raw)) {
      result[key] = uniqueStrings(raw, { label: `${label}.${key}`, min: 1, max: 32, pattern: /^[^\0\r\n]{1,256}$/ });
    } else throw new Error(`${label}.${key} must be a non-empty string or string array`);
  }
  return result;
}

function normalizeFailure(value, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  rejectUnknownKeys(value, FAILURE_KEYS, label);
  const phase = String(value.phase || '');
  const cause = String(value.cause || '');
  const code = String(value.code || '');
  if (!FAILURE_PHASES.has(phase)) throw new Error(`${label}.phase is invalid`);
  if (!FAILURE_CAUSES.has(cause)) throw new Error(`${label}.cause is invalid`);
  if (!FAILURE_CODE_RE.test(code)) throw new Error(`${label}.code is invalid`);
  return { phase, cause, code, ...(value.observed === undefined ? {} : { observed: normalizeObserved(value.observed, `${label}.observed`) }) };
}

function normalizePackageId(value, label) {
  if (typeof value !== 'string' || !PACKAGE_RE.test(value.trim())) {
    throw new Error(`${label} must be a valid package ID`);
  }
  return value.trim();
}

function normalizePackageIds(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new Error(`${label} must contain 1-16 package IDs`);
  }
  const result = value.map((item, index) => normalizePackageId(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate package IDs`);
  return result;
}

function normalizeBuildDependency(value, label, packages, sourceCommits, evidence = []) {
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  rejectUnknownKeys(value, BUILD_DEPENDENCY_KEYS, label);
  const exactEvidence = Array.isArray(evidence) && evidence.length > 0 &&
    evidence.every((row) => COMMIT_RE.test(row.sourceCommit));
  if ((!Array.isArray(sourceCommits) || sourceCommits.length === 0 ||
      sourceCommits.some((commit) => !COMMIT_RE.test(commit))) && !exactEvidence) {
    throw new Error(`${label} requires exact sourceCommits`);
  }
  const packageId = normalizePackageId(value.package, `${label}.package`);
  if (!packages.includes(packageId)) {
    throw new Error(`${label}.package must be listed in the rule packages`);
  }
  // `triggerPackages` belonged to the pre-ADR-0023 compatibility format.  It
  // remains readable for old snapshots, but the failed concrete package is
  // the only required fact for new rules; roots are derived from the exact
  // Catalog relation graph instead of being copied into this document.
  if (value.triggerPackages === undefined) return { package: packageId };
  const triggerPackages = normalizePackageIds(value.triggerPackages, `${label}.triggerPackages`);
  if (triggerPackages.includes(packageId)) {
    throw new Error(`${label}.triggerPackages must not include the failed package`);
  }
  return { package: packageId, triggerPackages };
}

export function compatibilityScopeMatches(scope, source, branch) {
  const patterns = scope?.[source] || scope?.['*'] || [];
  return patterns.some((pattern) => matchPattern(branch, pattern));
}

function targetScopeMatches(scope, context = {}) {
  if (!scope || !Object.keys(scope).length) return true;
  return Object.entries(scope).every(([key, values]) => {
    const actual = String(context[key] || '');
    return actual && values.some((pattern) => matchPattern(actual, pattern));
  });
}

function environmentMatches(environment, context = {}) {
  if (!environment) return false;
  const source = String(context.source || '');
  const branch = String(context.branch || '');
  const sourceMatch = environment.source === '*' || environment.source === source;
  const branchMatch = environment.branch === '*' || matchPattern(branch, environment.branch);
  return sourceMatch && branchMatch && targetScopeMatches(environment.targetScope, context);
}

/**
 * Resolve failed concrete build packages from the normalized compatibility
 * document for one exact probe environment.  This is deliberately derived
 * from the reviewed document and current package metadata; callers must not
 * supply a parallel hand-maintained trigger list.
 *
 * A legacy sourceCommit boundary without an exact current commit is reported
 * as unresolved instead of being silently applied to a different snapshot.
 * Preventive schema-5 environments intentionally use their reviewed
 * environment policy and do not inherit historical evidence commits.
 */
export function applicableBuildDependencies(document, context = {}) {
  const source = String(context.source || '');
  const branch = String(context.branch || '');
  const upstreamCommit = String(context.upstreamCommit || '').toLowerCase();
  const available = new Set((context.availablePackages || []).map((value) => String(value || '').trim()));
  const packages = new Set();
  const rules = [];
  const unresolved = [];
  for (const rule of document?.rules || []) {
    const dependency = rule?.buildDependency;
    if (!dependency?.package || rule.issue !== 'build-failure') continue;
    const scopeMatches = rule.policy === 'preventive'
      ? (rule.environments || []).some((environment) => environmentMatches(environment, context))
      : compatibilityScopeMatches(rule.scope, source, branch) && targetScopeMatches(rule.targetScope, context);
    if (!scopeMatches) continue;
    if (Array.isArray(rule.sourceCommits) && rule.sourceCommits.length &&
        (!upstreamCommit || !rule.sourceCommits.includes(upstreamCommit))) {
      unresolved.push({ rule: rule.id, package: dependency.package, reason: 'exact-source-commit-unresolved' });
      continue;
    }
    if (rule.inputHashes && !INPUT_HASH_RE.test(String(context.inputsHash || ''))) {
      unresolved.push({ rule: rule.id, package: dependency.package, reason: 'exact-inputs-hash-unresolved' });
      continue;
    }
    // A changed feed receipt is a different environment, not an ongoing ban.
    if (rule.inputHashes && !rule.inputHashes.includes(context.inputsHash)) continue;
    if (rule.if && context.conditions !== true && !new Set(context.conditions || []).has(rule.if)) {
      unresolved.push({ rule: rule.id, package: dependency.package, reason: 'rule-condition-unresolved', condition: rule.if });
      continue;
    }
    const availability = rule.policy === 'preventive'
      ? (rule.environments || []).find((environment) => environmentMatches(environment, context))?.packageAvailability || 'required'
      : 'required';
    if (!available.has(dependency.package)) {
      if (availability === 'if-present') continue;
      unresolved.push({ rule: rule.id, package: dependency.package, reason: 'failed-package-metadata-unresolved' });
      continue;
    }
    packages.add(dependency.package);
    rules.push({ id: rule.id, package: dependency.package });
  }
  return { packages: [...packages].sort(), rules, unresolved };
}

export function normalizeCompatibilityDocument(raw, policy = { sources: [] }) {
  if (!plainObject(raw)) throw new Error('compatibility document must be an object');
  rejectUnknownKeys(raw, DOCUMENT_KEYS, 'compatibility document');
  const schema = Number(raw.schema);
  if (![2, 3, 4, 5, 6, 7].includes(schema) || !Array.isArray(raw.rules)) {
    throw new Error('compatibility document requires schema 2, 3, 4, 5, 6, or 7 and a rules array');
  }
  const sourcePolicy = new Map((policy.sources || []).map((source) => [source.id, source]));
  const seen = new Set();
  const rules = raw.rules.map((rule, index) => {
    const label = `compatibility.rules[${index}]`;
    if (!plainObject(rule)) throw new Error(`${label} must be an object`);
    rejectUnknownKeys(rule, schema === 2 ? RULE_KEYS_V2 : schema === 3 ? RULE_KEYS_V3 :
      schema === 4 ? RULE_KEYS_V4 : schema === 5 ? RULE_KEYS_V5 : schema === 6 ? RULE_KEYS_V6 : RULE_KEYS_V7, label);
    const id = String(rule.id || '').trim();
    if (!RULE_ID_RE.test(id)) throw new Error(`${label}.id is invalid`);
    if (seen.has(id)) throw new Error(`duplicate compatibility rule id: ${id}`);
    seen.add(id);
    const issue = rule.issue;
    const match = rule.match;
    if (!['file-ownership', 'build-failure'].includes(issue)) {
      throw new Error(`${id}.issue is invalid`);
    }
    if (!['all-installed', 'all-selected'].includes(match)) {
      throw new Error(`${id}.match is invalid`);
    }
    const condition = String(rule.if || '').trim();
    if (condition && !CONDITION_RE.test(condition)) {
      throw new Error(`${id}.if is invalid`);
    }
    const preventive = schema >= 5 && rule.policy === 'preventive';
    if (schema >= 5 && rule.policy !== undefined && !preventive) {
      throw new Error(`${id}.policy is invalid`);
    }
    if (schema >= 5 && !preventive && (rule.environments !== undefined || rule.evidence !== undefined)) {
      throw new Error(`${id}.environments and evidence require policy preventive`);
    }
    if (preventive && (rule.scope !== undefined || rule.sourceCommits !== undefined ||
        rule.targetScope !== undefined || rule.refs !== undefined)) {
      throw new Error(`${id}.preventive policy uses environments and evidence instead of legacy scope identity`);
    }
    const normalized = {
      id,
      issue,
      match,
      ...(preventive ? {
        policy: 'preventive',
        environments: normalizeEnvironments(rule.environments, sourcePolicy, `${id}.environments`),
        evidence: normalizeEvidence(rule.evidence, sourcePolicy, `${id}.evidence`),
      } : {
        scope: normalizeScope(rule.scope, sourcePolicy, `${id}.scope`),
      }),
      ...(condition ? { if: condition } : {}),
      packages: uniqueStrings(rule.packages, { label: `${id}.packages`, min: 1, max: 16, pattern: PACKAGE_RE }),
      ...(!preventive ? {
        refs: uniqueStrings(rule.refs, { label: `${id}.refs`, min: 1, max: 8, pattern: REF_RE }),
      } : {}),
    };
    if (schema >= 3 && rule.sourceCommits !== undefined) {
      normalized.sourceCommits = uniqueStrings(rule.sourceCommits, {
        label: `${id}.sourceCommits`, min: 1, max: 32, pattern: COMMIT_RE,
      });
    }
    if (rule.inputHashes !== undefined) {
      if (preventive || !normalized.sourceCommits?.length) {
        throw new Error(`${id}.inputHashes requires an exact sourceCommits rule`);
      }
      normalized.inputHashes = uniqueStrings(rule.inputHashes, {
        label: `${id}.inputHashes`, min: 1, max: 32, pattern: INPUT_HASH_RE,
      });
    }
    if (schema >= 3 && rule.targetScope !== undefined) {
      normalized.targetScope = normalizeTargetScope(rule.targetScope, `${id}.targetScope`);
    }
    if (issue === 'file-ownership') {
      normalized.paths = uniqueStrings(rule.paths, { label: `${id}.paths`, min: 1, max: 16, pattern: PATH_RE });
      if (schema >= 3 && rule.failure !== undefined) throw new Error(`${id}.failure is only valid for build-failure`);
      if (schema >= 4 && rule.buildDependency !== undefined) {
        throw new Error(`${id}.buildDependency is only valid for build-failure`);
      }
    } else if (rule.paths !== undefined) {
      throw new Error(`${id}.paths is only valid for file-ownership`);
    } else if (schema >= 3) {
      normalized.failure = normalizeFailure(rule.failure, `${id}.failure`);
      if (schema >= 4 && rule.buildDependency !== undefined) {
        normalized.buildDependency = normalizeBuildDependency(
          rule.buildDependency,
          `${id}.buildDependency`,
          normalized.packages,
          normalized.sourceCommits,
          normalized.evidence,
        );
      }
    }
    if (rule.preferredDisable !== undefined) {
      normalized.preferredDisable = uniqueStrings(rule.preferredDisable, {
        label: `${id}.preferredDisable`, min: 1, max: 16, pattern: PACKAGE_RE,
      });
      if (rule.buildDependency || normalized.preferredDisable.some((name) => !normalized.packages.includes(name))) {
        throw new Error(`${id}.preferredDisable requires ordinary rule participants`);
      }
    }
    if (rule.preservePackages !== undefined) {
      normalized.preservePackages = uniqueStrings(rule.preservePackages, {
        label: `${id}.preservePackages`, min: 1, max: 16, pattern: PACKAGE_RE,
      });
      if (rule.buildDependency || normalized.match !== 'all-installed' ||
          normalized.preservePackages.some((name) => !normalized.packages.includes(name) ||
            normalized.preferredDisable?.includes(name))) {
        throw new Error(`${id}.preservePackages requires non-disabled all-installed participants`);
      }
    }
    return normalized;
  });
  const result = { schema, rules };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_DOCUMENT_BYTES) {
    throw new Error(`compatibility document exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  }
  return result;
}
