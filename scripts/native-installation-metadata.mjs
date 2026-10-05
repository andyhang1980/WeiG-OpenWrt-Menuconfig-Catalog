#!/usr/bin/env node
// Metadata-only instrumentation. GNU Make, not this adapter, evaluates the
// package variables. No package recipe, Kconfig or firmware config is changed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIELD = 'Weig-Extra-Depends: $(strip $(EXTRA_DEPENDS))';
export function instrumentInstallationMetadata(tree) {
  const file = join(tree, 'include/package-dumpinfo.mk');
  if (!existsSync(file)) return { status: 'unsupported', reason: 'native-package-dump-absent' };
  const text = readFileSync(file, 'utf8');
  if (text.includes(FIELD)) return { status: 'present' };
  const definitions = [...text.matchAll(/^define Dumpinfo\/Package\s*\r?\n([\s\S]*?)^endef\s*$/gm)];
  if (definitions.length !== 1) return { status: 'unsupported', reason: 'native-package-dump-dialect' };
  const body = definitions[0][1];
  const anchor = 'Depends: $(call PKG_FIXUP_DEPENDS,$(1),$(DEPENDS))';
  if (!body.includes('$(info ') || body.split(anchor).length !== 2) {
    return { status: 'unsupported', reason: 'native-package-dump-dialect' };
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(file, text.replace(anchor,
    anchor + newline + 'Weig-Installation-Metadata: extra-depends-v1' + newline + FIELD));
  return { status: 'installed' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = instrumentInstallationMetadata(resolve(process.argv[2] || '.'));
  console.log(`Native installation metadata: ${result.status}${result.reason ? ' (' + result.reason + ')' : ''}`);
}
