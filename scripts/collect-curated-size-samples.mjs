#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { parseApkDump, parseOpkgPackages } from './curated-sizes.mjs';
import { matchPattern } from './source-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const cli = new Map();
const positional = [];
for (let index = 2; index < process.argv.length; index++) {
  const token = process.argv[index];
  if (token.startsWith('--')) {
    const next = process.argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${token} requires a value`);
    cli.set(token.slice(2), next);
    index++;
  } else positional.push(token);
}
const output = resolve(positional[0] || join(ROOT, 'size-samples'));
const outputFile = cli.get('output-file') ? resolve(cli.get('output-file')) : '';
const selectedSource = String(cli.get('source') || '');
const selectedBranch = String(cli.get('branch') || '');
const targetInfoPath = cli.get('tree') ? join(resolve(cli.get('tree')), 'tmp', '.targetinfo') : '';
const targetArchitectures = targetInfoPath && existsSync(targetInfoPath)
  ? [...new Set([...readFileSync(targetInfoPath, 'utf8').matchAll(/^Target-Arch-Packages:\s*([A-Za-z0-9_.+-]+)\s*$/gm)].map((row) => row[1]))].sort()
  : [];
const config = JSON.parse(readFileSync(join(ROOT, 'catalog.config.json'), 'utf8'));
mkdirSync(output, { recursive: true });
if (outputFile) mkdirSync(dirname(outputFile), { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'weig-curated-size-'));
// Size observations are optional. Bound their cost so unavailable official
// indexes cannot consume the source lane's native Kconfig generation budget.
const deadline = Date.now() + 6 * 60 * 1000;

async function fetchBytes(url) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('official-index-observation-budget-exhausted');
  const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(15000, remaining)), headers: { 'User-Agent': 'WeiG-OpenWrt-Menuconfig-Catalog' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function collectArchitecture(source, branch, version, architecture) {
  const baseUrl = source.baseUrl.replaceAll('{architecture}', architecture).replaceAll('{version}', version);
  const packages = new Map();
  const failures = [];
  for (const feed of source.feeds || []) {
    const formats = source.format === 'auto' ? ['apk', 'opkg'] : [source.format];
    for (const format of formats) {
      const extension = format === 'apk' ? 'packages.adb' : 'Packages.gz';
      const url = `${baseUrl.replace(/\/$/, '')}/${feed}/${extension}`;
      try {
        const data = await fetchBytes(url);
        let rows;
        if (format === 'apk') {
          const file = join(temp, `${source.id}-${branch}-${architecture}-${feed}.adb`.replace(/[^A-Za-z0-9_.-]/g, '-'));
          writeFileSync(file, data);
          const { stdout: json } = await execute('docker', [
            'run', '--rm', '-v', `${temp.replace(/\\/g, '/')}:/work`, 'alpine:edge',
            'apk', 'adbdump', '--format', 'json', `/work/${file.split(/[\\/]/).pop()}`,
          ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: Math.min(60000, Math.max(1, deadline - Date.now())) });
          rows = parseApkDump(json);
        } else {
          rows = parseOpkgPackages(gunzipSync(data).toString('utf8'));
        }
        for (const row of rows) packages.set(row.name, row);
        break;
      } catch (error) {
        failures.push({ feed, url, error: String(error.message || error) });
      }
    }
  }
  const sample = {
    schema: 2, generatedAt: new Date().toISOString(), source: source.id, branch,
    architecture, format: source.format, baseUrl, available: packages.size > 0,
    packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)), failures,
  };
  if (!packages.size) {
    console.warn(`${source.id}/${branch}/${architecture}: no official observation`);
    return { ...sample, reason: 'official-package-index-unavailable' };
  }
  const destination = join(output, `${source.id}--${branch}--${architecture}.json`.replace(/[^A-Za-z0-9_.-]/g, '-'));
  writeFileSync(destination, JSON.stringify(sample) + '\n');
  console.log(`${source.id}/${branch}/${architecture}: packages=${packages.size} failed-feeds=${failures.length}`);
  return { architecture, available: true, file: relative(dirname(outputFile || destination), destination).replaceAll('\\', '/') };
}

try {
  const configured = (config.curatedSizeSources || []).filter((source) =>
    (!selectedSource || source.id === selectedSource) && (!selectedBranch || matchPattern(selectedBranch, source.branch)));
  const observations = [];
  if (selectedSource && selectedBranch && configured.length === 0 && outputFile) {
    writeFileSync(outputFile, JSON.stringify({
      schema: 2,
      generatedAt: new Date().toISOString(),
      source: selectedSource,
      branch: selectedBranch,
      available: false,
      reason: 'no-exact-official-index-source',
      packages: [],
      failures: [],
    }) + '\n');
    console.log(`${selectedSource}/${selectedBranch}: no exact official package-index source`);
  }
  for (const source of configured) {
    const branch = selectedBranch || source.branch;
    const version = source.branchPrefix && branch.startsWith(source.branchPrefix)
      ? branch.slice(source.branchPrefix.length) : branch;
    const architectures = targetArchitectures.length ? targetArchitectures : [source.architecture].filter(Boolean);
    if (!architectures.length) continue;
    let availableArchitectures = architectures;
    if (source.baseUrl.includes('{architecture}')) {
      const rootUrl = source.baseUrl.replace(/\{architecture\}.*$/, '').replaceAll('{version}', version);
      try {
        const listing = (await fetchBytes(rootUrl)).toString('utf8');
        const published = new Set([...listing.matchAll(/href="(?:\.\/)?([A-Za-z0-9_.+-]+)\/"/g)].map((row) => row[1]));
        availableArchitectures = architectures.filter((architecture) => published.has(architecture));
      } catch (error) {
        observations.push({ available: false, source: source.id, branch, reason: 'official-index-root-unavailable',
          failures: [{ url: rootUrl, error: String(error.message || error) }] });
        continue;
      }
    }
    const collected = new Array(availableArchitectures.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, availableArchitectures.length) }, async () => {
      while (next < availableArchitectures.length) {
        const index = next++;
        collected[index] = await collectArchitecture(source, branch, version, availableArchitectures[index]);
      }
    }));
    observations.push(...collected);
  }
  if (outputFile && configured.length) writeFileSync(outputFile, JSON.stringify({
    schema: 3, generatedAt: new Date().toISOString(), source: selectedSource, branch: selectedBranch,
    available: observations.some((row) => row.available), observations,
    reason: observations.length ? 'official-observations' : 'native-target-architectures-unavailable',
  }) + '\n');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
