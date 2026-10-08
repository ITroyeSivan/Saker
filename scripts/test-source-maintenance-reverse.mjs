import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as pipeline from '../plugins/dsh-nday-hunter/lib/source-pipeline.js';
import { subscriptionId } from '../plugins/dsh-nday-hunter/lib/source-subscriptions.js';
const home = process.env.DSH_HOME, paths = ['../plugins/dsh-nday-hunter/lib/source-reviews.js', '../plugins/dsh-hunter/lib/source-maintenance.js'].map(file => new URL(file, import.meta.url));
const original = paths.map(file => fs.readFileSync(file, 'utf8')), digest = value => createHash('sha256').update(value).digest('hex');
let number = 0;
async function variant(index, anchor, replacement) {
  assert.equal(original[index].split(anchor).length, 2, 'mutation anchor must be unique');
  const code = original[index].replace(anchor, replacement).replace(/from '(\.\.?\/[^']+)'/g, (_all, spec) => 'from ' + JSON.stringify(new URL(spec, paths[index]).href));
  const file = path.join(home, 'mutation-' + ++number + '.mjs'); fs.writeFileSync(file, code); return import(pathToFileURL(file).href);
}
let passed = 0;
async function check(name, run) { await run(); passed++; console.log('ok   ' + name); }
const sourceText = 'Example CMS affected 1.0.0';
const document = { kind: 'nday', title: 'Example CMS', summary: '来源描述版本问题，尚未复现。', product: 'Example CMS', vendor: '', versions: [], conditions: [], detection: [], remediation: [], evidence: [{ field: 'product', quote: 'Example CMS' }] };
await check('removing original-quote validation is caught by the exact fabricated-reference assertion', async () => {
  const real = await import(paths[0].href), mutated = await variant(0, '!sourceText.includes(item.quote)', 'false');
  const bad = { ...document, evidence: [{ field: 'product', quote: 'Example CMS fabricated statement' }] };
  const assertion = mod => assert.throws(() => mod.validateReview(JSON.stringify(bad), sourceText), /原文/);
  assertion(real); assert.throws(() => assertion(mutated), assert.AssertionError);
});
await check('removing the 24-hour budget is caught by a real extra model call', async () => {
  const real = await import(paths[0].href), mutated = await variant(0, ".n >= config.reviewPer24Hours) break;", ".n >= Infinity) break;");
  const source = subscriptionId('example/reverse'), config = pipeline.normalizeCollectorConfig({ sources: [source], repositories: [{ repository: 'example/reverse', mode: 'ai' }], reviewPer24Hours: 1 });
  const file = path.join(home, 'nday-hunter', 'source-content', 'git', 'blob-' + digest(sourceText)); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, sourceText);
  const row = id => ({ source, id, title: 'Example', status: 'pending-source-review', url: 'https://github.com/example/reverse/blob/' + 'a'.repeat(40) + '/x.md', repositoryFile: { contentAvailable: true, contentFile: file, sha256: digest(sourceText), commit: 'a'.repeat(40) } });
  const review = async () => ({ text: JSON.stringify(document) });
  await pipeline.runCollector(config, { home, fetchPage: async () => ({ rows: [row('first')], complete: true, coverage: 'fixture' }) });
  assert.equal((await real.runSourceReviews(config, { home, review })).processed, 1);
  await pipeline.runCollector(config, { home, fetchPage: async () => ({ rows: [row('second')], complete: true, coverage: 'fixture' }) });
  const assertion = async mod => assert.equal((await mod.runSourceReviews(config, { home, review })).processed, 0, 'quota must prevent every additional model call');
  await assertion(real); await assert.rejects(assertion(mutated), assert.AssertionError);
});
await check('adding a tool to the host model request is caught by production adapter inspection', async () => {
  const real = await import(paths[1].href), mutated = await variant(1, 'tools: [], maxTokens:', 'tools: [{ name: "exec" }], maxTokens:');
  const assertion = async mod => {
    let request;
    const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) }, llm: { async *stream(options) { request = options; yield { type: 'text-delta', text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } }; } } };
    const maintenance = mod.createSourceMaintenance(ctx, home, async () => ({ reviews: { runSourceReviews: async (_config, deps) => { await deps.review({ system: 'fixture', input: 'fixture' }); return {}; } } }));
    await maintenance.review({}); maintenance.stop(); assert.deepEqual(request.tools, [], 'source interpretation must have zero execution tools');
  };
  await assertion(real); await assert.rejects(assertion(mutated), assert.AssertionError);
});
await check('source bytes are unchanged after isolated reverse tests', () => paths.forEach((file, index) => assert.equal(digest(fs.readFileSync(file)), digest(original[index]))));
console.log(`${passed} passed, 0 failed`);
