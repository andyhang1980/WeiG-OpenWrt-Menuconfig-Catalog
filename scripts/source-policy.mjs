const BRANCH_RE = /^[A-Za-z0-9._/-]{1,160}$/;
const GLOB_RE = /^[A-Za-z0-9._/-]*\*[A-Za-z0-9._/-]*$/;

export function matchPattern(value, pattern) {
  const text = String(value || '');
  const rule = String(pattern || '');
  if (!BRANCH_RE.test(text) || (!BRANCH_RE.test(rule) && !GLOB_RE.test(rule))) return false;
  if (!rule.includes('*')) return text === rule;
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(text);
}

export function sourceBranchPatterns(source) {
  if (Array.isArray(source?.branches)) return source.branches;
  if (source?.branches === 'all') return ['*'];
  if (source?.branches && typeof source.branches === 'object' && Array.isArray(source.branches.include)) {
    return source.branches.include;
  }
  return [];
}

export function validateSourcePolicy(source) {
  const patterns = sourceBranchPatterns(source);
  if (!patterns.length || patterns.some((pattern) => !BRANCH_RE.test(pattern) && !GLOB_RE.test(pattern))) {
    throw new Error(`${source?.id || 'source'}.branches contains an invalid include pattern`);
  }
  const exclude = Array.isArray(source?.exclude) ? source.exclude : [];
  if (exclude.some((pattern) => !BRANCH_RE.test(pattern) && !GLOB_RE.test(pattern))) {
    throw new Error(`${source?.id || 'source'}.exclude contains an invalid pattern`);
  }
  const family = source?.branches?.versionFamily;
  if (family !== undefined && (!family || typeof family !== 'object' || Array.isArray(family) ||
      Object.keys(family).some((key) => !['prefix', 'components', 'width'].includes(key)) ||
      typeof family.prefix !== 'string' || (family.prefix && !BRANCH_RE.test(family.prefix)) ||
      !Number.isInteger(family.components) || family.components < 1 || family.components > 4 ||
      !Number.isInteger(family.width) || family.width < 1 || family.width > 4)) {
    throw new Error(`${source?.id || 'source'}.branches.versionFamily is invalid`);
  }
  if (source?.branches?.preferDefault !== undefined && typeof source.branches.preferDefault !== 'boolean') {
    throw new Error(`${source?.id || 'source'}.branches.preferDefault must be boolean`);
  }
  return { patterns, exclude, family };
}

export function sourceAllowsBranch(source, branch) {
  const { patterns, exclude, family } = validateSourcePolicy(source);
  if (family) {
    const value = String(branch || '');
    if (!value.startsWith(family.prefix)) return false;
    const parts = value.slice(family.prefix.length).split('.');
    if (parts.length !== family.components || parts.some((part) =>
      part.length !== family.width || !/^\d+$/.test(part))) return false;
  }
  return patterns.some((pattern) => matchPattern(branch, pattern)) &&
    !exclude.some((pattern) => matchPattern(branch, pattern));
}

export function sourceBranchVersion(source, branch) {
  const text = String(branch || '');
  const prefix = source?.branches?.versionFamily?.prefix;
  if (prefix !== undefined && sourceAllowsBranch(source, text)) return text.slice(prefix.length);
  return text.replace(/^openwrt-/, '');
}

export function sourceNeedsDiscovery(source) {
  return sourceBranchPatterns(source).some((pattern) => pattern.includes('*'));
}

export function compareBranches(left, right, source = null) {
  const version = (value) => sourceBranchVersion(source, value).match(/^\d+(?:\.\d+)*$/)?.[0];
  const rank = (value) => version(value) ? 0 : value === 'main' || value === 'master' ? 1 : 2;
  const rankDelta = rank(left) - rank(right);
  if (rankDelta) return rankDelta;
  if (rank(left) !== 0) return left.localeCompare(right, undefined, { numeric: true });
  const a = version(left).split('.').map(Number);
  const b = version(right).split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const av = a[index] ?? -1;
    const bv = b[index] ?? -1;
    if (av === bv) continue;
    return bv - av;
  }
  return left.localeCompare(right);
}
