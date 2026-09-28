#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

const file = process.argv[2] || 'dist/translation-summary.json';
const summary = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
if (!summary || summary.status === 'running') {
  console.log('## Translation incomplete');
  console.log('No completed summary. Inspect the first failing translation step; no successful publication is claimed.');
  process.exit(0);
}
console.log('## Translation progress');
console.log(`- Engine: \`${summary.provider}\` / model: \`${summary.model || '-'}\``);
console.log(`- Language: \`${summary.activeLanguage}\``);
console.log(`- Batch: \`${summary.batchNumber || 1}/${summary.batchCount || 1}\``);
console.log(`- This batch: \`${summary.translatedThisRun} / ${summary.queuedThisRun}\``);
console.log(`- Retry queue: \`${summary.retryQueuedAfter || 0}\``);
console.log(`- Remaining descriptions: \`${summary.targetPendingAfter}\``);
if (summary.warning || summary.apiError) console.log(`- Warning: \`${(summary.warning || summary.apiError).replace(/[`|\r\n]+/g, ' ')}\``);
