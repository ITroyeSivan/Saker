// Repeatable local scale measurements. This is not an external vulnerability benchmark.
import './test-home-isolation.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SourceIndex } from '../plugins/dsh-nday-hunter/lib/source-index.js';
import { collectorPaths, normalizeCollectorConfig } from '../plugins/dsh-nday-hunter/lib/source-pipeline.js';
import { subscriptionId } from '../plugins/dsh-nday-hunter/lib/source-subscriptions.js';
import { runSourceReviews } from '../plugins/dsh-nday-hunter/lib/source-reviews.js';
const home = process.env.DSH_HOME, source = subscriptionId('example/scale'), paths = collectorPaths(home), n = 10000;
const contentDir = path.join(paths.dir, 'source-content', 'git'); fs.mkdirSync(contentDir, { recursive: true });
const index = new SourceIndex(paths), started = performance.now();
const state = { checkpoints: {}, sources: [], running: false };
for (let i = 0; i < n; i += 100) {
  index.commitPage(Array.from({ length: 100 }, (_, j) => { const id = i + j; return { source, id: 'file:' + id, title: 'Example CMS ' + id, summary: '权限检查 local scale data CVE-2026-' + (10000 + id),
    status: 'pending-source-review', repositoryFile: { commit: 'a'.repeat(40), sha256: id.toString(16).padStart(64, '0'), contentAvailable: true, event: 'baseline' }, url: 'https://github.com/example/scale/blob/' + 'a'.repeat(40) + '/' + id + '.md' }; }), state);
}
const buildMs = performance.now() - started;
function stats(values) { const sorted = values.toSorted((a, b) => a - b); return { p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)], maxMs: sorted.at(-1) }; }
const search = [];
for (let i = 0; i < 80; i++) { const start = performance.now(); const result = index.query({ query: i % 2 ? '权限' : 'CVE-2026-19999', limit: 20 });
  if (!result.total) throw new Error('Scale search fixture produced no result'); search.push(performance.now() - start); }
index.close();
const config = normalizeCollectorConfig({ sources: [source], repositories: [{ repository: 'example/scale', mode: 'ai' }] });
const first = performance.now();
// Exhaust the request allowance without consulting any model or malformed fixture originals.
const { DatabaseSync } = await import('node:sqlite');
await runSourceReviews({ ...config, sources: [] }, { home });
const reviewsDb = new DatabaseSync(path.join(paths.dir, 'source-reviews.sqlite'));
for (let i = 0; i < 10; i++) reviewsDb.prepare('INSERT INTO calls(started_at,source,id,sha) VALUES(?,?,?,?)').run(Date.now(), source, String(i), 'a'.repeat(64));
reviewsDb.close();
await runSourceReviews(config, { home, review: async () => { throw new Error('No model call permitted by the scale benchmark'); } });
const enqueueMs = performance.now() - first, unchanged = [];
for (let i = 0; i < 12; i++) { const start = performance.now(); await runSourceReviews(config, { home, review: async () => { throw new Error('Quota must prevent a model call'); } }); unchanged.push(performance.now() - start); }
const result = { scope: 'local controlled SQLite corpus; no target scanning or live model', records: n, buildMs, search: stats(search), queueInitialMs: enqueueMs,
  unchangedMaintenance: stats(unchanged), processRssBytes: process.memoryUsage().rss, sourceIndexBytes: fs.statSync(paths.index).size };
console.log(JSON.stringify(result, null, 2));
const output = process.argv[2]; if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
