// W03：本地 docx/xlsx/文本读取、真实位置、分段与未解析警告。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import { parseDocumentBuffer, readDocumentUrl, readDocumentSection } from '../plugins/dsh-redteam-results/lib/project-documents.js';

let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8');
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

const docx = makeZip([['word/document.xml', `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>项目测试说明</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>员工只能查看自己的资料</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>检查权限</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并单元格说明</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>纵向合并</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>第二列</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>续接列</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:drawing/></w:r></w:p>
</w:body></w:document>`]]);

const xlsx = makeZip([
  ['xl/workbook.xml', `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="测试要求" sheetId="1" r:id="rId1"/><sheet name="隐藏表" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`],
  ['xl/_rels/workbook.xml.rels', `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`],
  ['xl/sharedStrings.xml', `<sst><si><t>员工资料</t></si><si><t>审批</t></si></sst>`],
  ['xl/worksheets/sheet1.xml', `<worksheet><cols><col min="2" max="2" hidden="1"/></cols><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2" hidden="1"><c r="A2" t="inlineStr"><is><t>隐藏行内容</t></is></c></row>
<row r="3"><c r="A3"><f>SUM(A1:A2)</f></c></row>
</sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells></worksheet>`],
  ['xl/worksheets/sheet2.xml', `<worksheet><sheetData/></worksheet>`],
]);

test('DOCX 段落、表格、合并单元格与内嵌对象位置可对应原文', () => {
  const parsed = parseDocumentBuffer(docx, { displayName: '项目说明.docx' });
  assert.equal(parsed.kind, 'docx');
  assert.equal(parsed.parseState, 'ready');
  const paragraph = parsed.sections.find(item => item.sectionId === 'p1');
  assert.equal(paragraph.text, '项目测试说明');
  assert.deepEqual(paragraph.location, { kind: 'paragraph', index: 1 });
  const firstCell = parsed.sections.find(item => item.sectionId === 't1r1c1');
  assert.equal(firstCell.text, '员工只能查看自己的资料');
  assert.equal(firstCell.location.table, 1);
  assert.equal(firstCell.location.row, 1);
  assert.equal(firstCell.location.column, 1);
  const merged = parsed.sections.find(item => item.sectionId === 't1r2c1');
  assert.equal(merged.gridSpan, 2);
  assert.equal(merged.text, '合并单元格说明');
  assert.equal(parsed.sections.find(item => item.sectionId === 't1r3c1').vMerge, 'restart');
  assert.equal(parsed.sections.find(item => item.sectionId === 't1r4c1').vMerge, 'continue');
  assert(parsed.unread.some(item => item.location.kind === 'inline-object'), '内嵌对象必须出现在未解析警告');
});

test('XLSX 工作表、隐藏表、隐藏行、隐藏列、合并区域与公式无结果都显式列出', () => {
  const parsed = parseDocumentBuffer(xlsx, { displayName: '测试要求.xlsx' });
  assert.equal(parsed.kind, 'xlsx');
  assert(parsed.sections.some(item => item.kind === 'worksheet-note' && /隐藏/.test(item.text) && /隐藏表/.test(item.text)));
  assert(parsed.sections.some(item => item.kind === 'worksheet-note' && /隐藏列：2/.test(item.text)));
  assert(parsed.sections.some(item => item.kind === 'worksheet-note' && /合并区域：A1:B1/.test(item.text)));
  const row1 = parsed.sections.find(item => item.sectionId === 'sheet-1-row-1');
  assert(row1.text.includes('员工资料') && row1.text.includes('审批'));
  const hiddenRow = parsed.sections.find(item => item.sectionId === 'sheet-1-row-2');
  assert.equal(hiddenRow.location.hidden, true);
  assert(hiddenRow.text.startsWith('[隐藏行]'));
  const formulaRow = parsed.sections.find(item => item.sectionId === 'sheet-1-row-3');
  assert.equal(formulaRow.cells[0].formulaNoResult, true);
  assert(formulaRow.text.includes('公式无缓存结果，未猜值'));
});

test('文本按行范围分段，长内容可继续读取且不一次返回全文', () => {
  const lines = Array.from({ length: 450 }, (_, index) => '第' + (index + 1) + '行测试要求');
  const parsed = parseDocumentBuffer(Buffer.from(lines.join('\n'), 'utf8'), { displayName: '要求.txt' });
  assert.equal(parsed.kind, 'text');
  assert.equal(parsed.sections.length, 3);
  assert.deepEqual(parsed.sections[0].location, { kind: 'line-range', from: 1, to: 200 });
  const first = readDocumentSection(parsed, parsed.sections[0].sectionId, { cursor: 0, limit: 30 });
  assert.equal(first.text.length, 30);
  assert.equal(first.more, true);
  const second = readDocumentSection(parsed, parsed.sections[0].sectionId, { cursor: first.nextCursor, limit: 30 });
  assert.notEqual(second.text, first.text);
  assert.throws(() => readDocumentSection(parsed, 'missing-section'), /未找到该文档段落/);
});

test('坏文件与旧格式给出具体错误，不返回空内容成功', () => {
  assert.throws(() => parseDocumentBuffer(Buffer.from('not a zip'), { displayName: '坏文件.docx' }), /另存为 \.docx|不是有效/);
  assert.throws(() => parseDocumentBuffer(Buffer.from('plain'), { displayName: '旧格式.doc' }), /另存为 \.docx/);
  assert.throws(() => parseDocumentBuffer(Buffer.from('plain'), { displayName: '旧格式.xls' }), /另存为 \.xlsx/);
});

test('云链接没有对应能力时明确不可读，不伪装已读', () => {
  const parsed = readDocumentUrl('https://docs.example.com/private/test');
  assert.equal(parsed.parseState, 'unreadable');
  assert.equal(parsed.sections.length, 0);
  assert.match(parsed.unread[0].reason, /当前无法读取此链接/);
});

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
