import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { builtinTemplates, promptFields, validateTemplate, searchTemplates, renderTemplate, missingRequired, importTemplates } from '../plugins/dsh-redteam-results/lib/prompt-templates.js';
import { listUserTemplates, upsertUserTemplate, deleteUserTemplate, saveAsTemplate, readDraft, listDrafts, saveDraft } from '../plugins/dsh-redteam-results/lib/prompt-store.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-prompt-library-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results/results.db'));
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };
try {
  test('the built-in catalog has 36 self-consistent templates with the required fields', () => {
    const list = builtinTemplates();
    assert.equal(list.length, 36, 'the plan ships exactly 36 built-in templates');
    assert.equal(list.filter(t => t.id === 'U01').length, 1);
    for (const t of list) validateTemplate(t, { builtin: true });
    // required must stay 0–2 so the editor only asks for the key fields.
    for (const t of list) assert((t.required || []).length <= 2, t.id + ' must keep at most 2 required fields');
    assert.equal(promptFields().version.default, '未知，先根据实际材料核对');
    assert.equal(promptFields().materials.label, '要分析的请求或文件');
    assert.equal(list.some(t => t.id === 'F06'), false, 'retired knowledge update template must be absent');
    const p01 = list.find(t => t.id === 'P01');
    assert(p01, 'document test template must exist');
    assert.deepEqual(p01.required, ['materials']);
    assert.match(p01.text, /先读全测试要求/);
    const n01 = list.find(t => t.id === 'N01');
    assert.equal(n01.title, '检查指定漏洞或 EXP');
    assert.match(n01.text, /读取实际公告和必要代码/);
    assert(promptFields().cve.label.includes('链接'));
    const a06 = list.find(t => t.id === 'A06');
    assert.doesNotMatch(a06.text, /知识片段|知识来源|知识更新额度/);
  });
  test('synonym and keyword search covers the plan examples and returns stable ids', () => {
    assert.deepEqual(searchTemplates('SQL').map(t => t.id), ['S04', 'Z06']);
    assert(searchTemplates('越权').some(t => t.id === 'Z03'), '越权 must reach an access-control template');
    assert(searchTemplates('IDOR').some(t => t.id === 'Z03'), 'IDOR must reach an access-control template');
    assert(searchTemplates('OpenAPI').some(t => t.id === 'A05'), 'OpenAPI must reach the API template');
    assert(searchTemplates('Nday').some(t => t.id === 'N01'), 'Nday must reach the Nday template');
    assert(searchTemplates('继续').some(t => t.id === 'F03'), '继续 must reach the resume template');
    assert(searchTemplates('EXP').some(t => t.id === 'N01'), 'EXP must reach the direct vulnerability template');
    assert(searchTemplates('文档').some(t => t.id === 'P01'), '文档 must reach the document test template');
    assert.equal(searchTemplates('知识').some(t => ['F06', 'A06'].includes(t.id)), false, 'retired knowledge search must not resurface old guidance');
    assert.equal(searchTemplates('').length, 36);
  });
  test('render substitutes provided values, falls back to defaults, and reports missing required fields', () => {
    const s01 = builtinTemplates().find(t => t.id === 'S01');
    assert.deepEqual(missingRequired(s01, {}), ['目标地址']);
    assert.deepEqual(missingRequired(s01, { target: 'https://x.test' }), []);
    const rendered = renderTemplate(s01, { target: 'https://x.test' });
    assert(rendered.text.includes('https://x.test'));
    assert(rendered.text.includes('我在本次任务中说明的范围'), 'unfilled optional field uses its default phrase');
    assert(!rendered.text.includes('{{'), 'no placeholder may survive rendering');
    assert.equal(rendered.fields.target, 'input');
    assert.equal(rendered.fields.scope, 'default');
  });
  test('import validates schema, rejects bad rows with a reason, and re-imports duplicate ids as new copies', () => {
    const list = builtinTemplates();
    const result = importTemplates({ templates: [list[0], list[1], { id: 'BAD ID', title: '', text: '' }, { id: 'X1', title: 'x', text: '引用未定义 {{nope}}' }] }, new Set(['S01']));
    assert.equal(result.accepted.length, 2);
    assert.equal(result.rejected.length, 2);
    assert(result.accepted[0].id !== 'S01', 'a duplicate id is imported as a new copy');
    assert(result.rejected.every(r => typeof r.reason === 'string' && r.reason.length));
  });
  test('user templates are independent of task mode, paginate at 30, and CAS on revision', () => {
    const created = upsertUserTemplate(store, { id: 'mine-1', title: '我的模板', text: '请检查 {{target}}。', required: ['target'], optional: [] });
    assert.equal(created.revision, 1); assert.equal(created.builtin, false);
    const page = listUserTemplates(store, {});
    assert.equal(page.total, 1); assert.equal(page.templates[0].id, 'mine-1'); assert.equal(page.limit, 30);
    const updated = upsertUserTemplate(store, { id: 'mine-1', title: '我的模板', text: '请检查 {{target}} 与 {{focus}}。', required: ['target'], optional: ['focus'], expectedRevision: 1 });
    assert.equal(updated.revision, 2);
    assert.throws(() => upsertUserTemplate(store, { id: 'mine-1', title: 'x', text: '请检查 {{target}}。', required: ['target'], optional: [], expectedRevision: 1 }), /其他窗口/);
    const copy = saveAsTemplate(store, { title: '副本', text: '请检查 {{target}}。', required: ['target'], optional: [] });
    assert(copy.id && copy.id !== 'mine-1');
    assert.equal(deleteUserTemplate(store, 'mine-1', 2).deleted, true);
    assert.equal(listUserTemplates(store, {}).total, 1);
  });
  test('session drafts keep one slot per template and preserve both versions on a revision conflict', () => {
    const first = saveDraft(store, 'sess', { templateId: 'S01', mode: 'regular', editMode: 'fields', fields: { target: 'https://a.test' }, text: 'A' });
    assert.equal(first.revision, 1);
    assert.equal(readDraft(store, 'sess', 'S01').text, 'A');
    const other = saveDraft(store, 'sess', { templateId: 'F03', mode: 'regular', text: 'B' });
    assert.equal(other.revision, 1);
    assert.equal(listDrafts(store, 'sess').length, 2, 'each template keeps its own draft slot');
    const conflict = saveDraft(store, 'sess', { templateId: 'S01', expectedRevision: 0, text: 'local-A2' });
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.server.text, 'A'); assert.equal(conflict.local.text, 'local-A2');
    const resolved = saveDraft(store, 'sess', { templateId: 'S01', expectedRevision: 1, text: 'A2' });
    assert.equal(resolved.revision, 2);
    assert.equal(readDraft(store, 'sess', 'S01').text, 'A2');
  });
} finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
