import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  indexKnowledgeEntry,
  searchKnowledgeIndex,
  readKnowledgeIndexRef,
} from '../plugins/dsh-redteam-results/lib/knowledge-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(ROOT, 'benchmarks/knowledge-retrieval/human-holdout-20261110.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-human-holdout-'));
process.env.DSH_HOME = home;
const projectKey = 'human-holdout-20261110';

let checks = 0;
function ok(label) {
  checks += 1;
  console.log('ok ' + label);
}
function norm(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}
function expectedHit(row, item) {
  const label = norm(row.sourceLabel || row.path);
  const file = norm(String(item.expectedPath || '').split('/').pop());
  return (label.endsWith(norm(item.expectedPath)) || label.includes(file) || norm(row.title).includes(file))
    && String(row.section || '').includes(String(item.expectedHeading || ''));
}
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

try {
  for (const relative of fixture.documents) {
    const absolute = path.join(ROOT, relative);
    const text = fs.readFileSync(absolute, 'utf8');
    indexKnowledgeEntry({
      projectKey,
      sourceId: relative,
      title: relative.split(/[\\/]/).pop(),
      text,
      sourceLabel: relative,
      location: relative,
      sourceKind: 'documentation',
      applicability: 'partial',
      sourceDate: '2026-11-10',
    });
  }

  const results = [];
  const baselineResults = [];
  for (const item of fixture.cases) {
    const result = searchKnowledgeIndex(projectKey, { query: item.query, limit: 5 });
    const rank = (result.rows || []).findIndex(row => expectedHit(row, item));
    results.push({ ...item, rank: rank < 0 ? null : rank + 1, rows: result.rows || [] });
    const baseline = searchKnowledgeIndex(projectKey, { query: item.query, limit: 5 }, { requireAll: true });
    const baselineRank = (baseline.rows || []).findIndex(row => expectedHit(row, item));
    baselineResults.push({ id: item.id, rank: baselineRank < 0 ? null : baselineRank + 1 });
  }
  const recallAt5 = results.filter(item => item.rank !== null && item.rank <= 5).length / results.length;
  const baselineRecallAt5 = baselineResults.filter(item => item.rank !== null && item.rank <= 5).length
    / baselineResults.length;
  const top1 = results.filter(item => item.rank === 1).length / results.length;
  const mrr = results.reduce((sum, item) => sum + (item.rank ? 1 / item.rank : 0), 0) / results.length;
  const retained = results.filter(item => item.retained === true);
  const retainedRecallAt5 = retained.filter(item => item.rank !== null && item.rank <= 5).length / retained.length;
  assert(results.length >= 30, 'holdout must contain at least 30 labelled queries');
  assert(new Set(results.map(item => item.queryClass)).size >= 5, 'holdout must cover five query classes');
  assert(retained.length >= 10, 'holdout must retain at least 10 frozen final cases');
  assert(recallAt5 >= baselineRecallAt5, 'current Recall@5 regressed against the strict baseline');
  const recallOk = recallAt5 >= 0.85;
  const retainedRecallOk = retainedRecallAt5 >= 0.85;

  let falseHits = 0;
  const negativeResults = [];
  for (const item of fixture.negativeCases) {
    const result = searchKnowledgeIndex(projectKey, { query: item.query, limit: 5 });
    const hit = (result.rows || []).length > 0;
    if (hit) falseHits += 1;
    negativeResults.push({ ...item, status: result.status, rows: result.rows || [] });
  }
  assert(fixture.negativeCases.length >= 6, 'holdout must contain at least six no-answer queries');
  const noAnswerOk = falseHits === 0;

  const sample = results.find(item => item.rank !== null);
  assert(sample, 'at least one labelled query must return a hit');
  const searchBytes = Buffer.byteLength(JSON.stringify(searchKnowledgeIndex(projectKey, {
    query: sample.query,
    limit: 5,
  })), 'utf8');
  assert(searchBytes <= 3072, 'search message exceeds 3072 bytes');
  assert(sample.rows.length <= 5, 'search returns more than five rows');
  const ref = sample.rows[0].ref;
  let cursor;
  let bytes = 0;
  let pages = 0;
  do {
    const page = readKnowledgeIndexRef(ref, { cursor, maxBytes: 8192 });
    bytes += Buffer.byteLength(page.text, 'utf8');
    pages += 1;
    assert(Buffer.byteLength(page.text, 'utf8') <= 8192, 'read page exceeds 8192 bytes');
    assert(!page.text.includes('\uFFFD'), 'read page contains a replacement character');
    cursor = page.nextCursor;
  } while (cursor);
  assert(pages >= 1 && bytes > 0, 'read pagination produced no content');

  const timings = [];
  for (let round = 0; round < 40; round += 1) {
    const query = results[round % results.length].query;
    const started = process.hrtime.bigint();
    searchKnowledgeIndex(projectKey, { query, limit: 5 });
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const p95 = percentile(timings, 0.95);
  const latencyOk = p95 <= 250;

  const report = {
    schema: 'saker-human-holdout-result/1',
    fixture: fixturePath,
    fixtureSha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex'),
    generatedAt: new Date().toISOString(),
    provenance: fixture.provenance,
    cases: results.length,
    queryClasses: [...new Set(results.map(item => item.queryClass))],
    retainedCases: retained.length,
    recallAt5,
    baselineRecallAt5,
    top1,
    mrr,
    retainedRecallAt5,
    noAnswerCases: fixture.negativeCases.length,
    noAnswerFalseHits: falseHits,
    searchBytes,
    readP95Ms: p95,
    rows: results.map(item => ({
      id: item.id,
      queryClass: item.queryClass,
      query: item.query,
      expectedPath: item.expectedPath,
      expectedHeading: item.expectedHeading,
      retained: item.retained === true,
      rank: item.rank,
      top: item.rows.map(row => ({ path: row.sourceLabel || row.path, section: row.section, score: row.score })),
    })),
    negativeResults,
  };
  const out = path.join(ROOT, '..', '_ref', 'private', 'saker-development',
    '2026-11-06-user-experience-review', 'evidence-0.7.6-round3-20261110',
    'A23-HUMAN-HOLDOUT.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  assert(recallOk, 'Recall@5 ' + recallAt5 + ' is below 0.85');
  assert(retainedRecallOk, 'retained Recall@5 ' + retainedRecallAt5 + ' is below 0.85');
  assert(noAnswerOk, 'no-answer queries must not return hits');
  assert(latencyOk, 'warm p95 ' + p95.toFixed(2) + 'ms exceeds 250ms');
  console.log('     Recall@5=' + (recallAt5 * 100).toFixed(1)
    + '% retained=' + (retainedRecallAt5 * 100).toFixed(1)
    + '% top1=' + (top1 * 100).toFixed(1)
    + '% MRR=' + mrr.toFixed(3)
    + ' no-answer-false-hits=' + falseHits
    + ' p95=' + p95.toFixed(2) + 'ms');
  console.log('     report: ' + out);
  ok('A23 human-labelled frozen holdout meets recall, no-answer, byte and latency thresholds');
  console.log('\n' + checks + ' human holdout checks passed');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
