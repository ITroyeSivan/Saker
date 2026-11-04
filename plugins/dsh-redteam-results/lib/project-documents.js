// W03：项目文档读取。首版支持本地 .docx、.xlsx 与文本；解析只做本地读取，
// 不调用模型。解析器负责文字、表格和位置，语义理解交给模型。
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const DOCUMENT_LIMITS = Object.freeze({
  maxInputBytes: 20 * 1024 * 1024,
  maxEntries: 5000,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxReadBytes: 8192,
  parseDeadlineMs: 15000,
});
const decodeXml = value => String(value).replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (match, entity) => {
  if (entity[0] === '#') {
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  }
  return XML_ENTITIES[entity] ?? match;
});
const stripTags = value => decodeXml(String(value).replace(/<[^>]*>/g, ''));

/** 读取 ZIP/OOXML 中央目录；首版不支持 ZIP64。 */
function readZipEntries(buffer) {
  if (buffer.length > DOCUMENT_LIMITS.maxInputBytes) throw new Error('文档超过 20MiB 输入上限');
  const deadline = Date.now() + DOCUMENT_LIMITS.parseDeadlineMs;
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 65558);
  for (let i = buffer.length - 22; i >= floor; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP/OOXML 文件：找不到中央目录');
  const count = buffer.readUInt16LE(eocd + 10);
  if (count > DOCUMENT_LIMITS.maxEntries) throw new Error('ZIP 条目数超过 5000 上限');
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset >= buffer.length) throw new Error('ZIP 中央目录位置越界');
  const entries = new Map();
  let totalBytes = 0;
  let offset = centralOffset;
  for (let i = 0; i < count; i++) {
    if (Date.now() > deadline) throw new Error('文档解析超过 15 秒上限');
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    if (raw.length !== compressedSize) throw new Error('ZIP 条目数据不完整：' + name);
    const maxOutput = Math.min(DOCUMENT_LIMITS.maxEntryBytes, DOCUMENT_LIMITS.maxTotalBytes - totalBytes);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(1, maxOutput + 1) });
    else throw new Error('ZIP 使用了不支持的压缩方式：' + method);
    if (data.length > DOCUMENT_LIMITS.maxEntryBytes) throw new Error('ZIP 条目解压后超过 16MiB 上限：' + name);
    totalBytes += data.length;
    if (totalBytes > DOCUMENT_LIMITS.maxTotalBytes) throw new Error('ZIP 解压总量超过 64MiB 上限');
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const cellText = xml => [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(match => stripTags(match[1])).join('');
const attrsOf = source => Object.fromEntries([...String(source || '').matchAll(/([A-Za-z_][\w:.-]*)="([^"]*)"/g)]
  .map(match => [match[1], decodeXml(match[2])]));

function parseDocx(entries) {
  const xml = entries.get('word/document.xml')?.toString('utf8');
  if (!xml) throw new Error('DOCX 缺少 word/document.xml，无法读取正文');
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const sections = [], unread = [];
  const tokenRe = /<w:(p|tbl)\b[^>]*>[\s\S]*?<\/w:\1>/g;
  let match, paragraph = 0, table = 0;
  while ((match = tokenRe.exec(body)) !== null) {
    if (match[1] === 'p') {
      paragraph++;
      const text = cellText(match[0]);
      if (text.trim()) sections.push({ sectionId: 'p' + paragraph, location: { kind: 'paragraph', index: paragraph }, kind: 'paragraph', text: text.trim() });
      continue;
    }
    table++;
    const rows = [...match[0].matchAll(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g)];
    rows.forEach((row, rowIndex) => {
      const cells = [...row[0].matchAll(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g)];
      cells.forEach((cell, colIndex) => {
        const text = cellText(cell[0]);
        const gridSpan = Number(/<w:gridSpan\b[^>]*w:val="(\d+)"/.exec(cell[0])?.[1] || 1);
        const merge = /<w:vMerge\b([^>]*)\/?>/.exec(cell[0]);
        const vMerge = merge ? (/w:val="restart"/.test(merge[1]) ? 'restart' : 'continue') : '';
        if (!text.trim() && gridSpan === 1 && !vMerge) return;
        sections.push({
          sectionId: 't' + table + 'r' + (rowIndex + 1) + 'c' + (colIndex + 1),
          location: { kind: 'table-cell', table, row: rowIndex + 1, column: colIndex + 1, gridSpan, vMerge },
          kind: 'table-cell', text: text.trim(), gridSpan, vMerge,
        });
      });
    });
  }
  const inlineObjects = (body.match(/<w:drawing\b|<w:pict\b|<w:object\b/g) || []).length;
  if (inlineObjects) unread.push({ location: { kind: 'inline-object' }, reason: '内嵌图片或对象未解析，请在该位置查看原文件' });
  return { kind: 'docx', sections, unread, warnings: [] };
}

function sharedStrings(entries) {
  const xml = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map(match => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(item => stripTags(item[1])).join(''));
}

function parseXlsx(entries) {
  const workbook = entries.get('xl/workbook.xml')?.toString('utf8');
  if (!workbook) throw new Error('XLSX 缺少 xl/workbook.xml，无法读取工作表');
  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const rels = new Map([...relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)]
    .map(match => attrsOf(match[1])).filter(attrs => attrs.Id && attrs.Target)
    .map(attrs => [attrs.Id, attrs.Target]));
  const shared = sharedStrings(entries);
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map(match => {
    const attrs = attrsOf(match[1]);
    return {
      name: attrs.name ?? '',
      state: attrs.state === 'veryHidden' ? 'veryHidden' : attrs.state === 'hidden' ? 'hidden' : 'visible',
      target: rels.get(attrs['r:id'] || attrs.id || '') ?? '',
    };
  });
  const sections = [], unread = [];
  for (const name of entries.keys()) {
    if (/^xl\/(?:charts|drawings|diagrams)\//.test(name))
      unread.push({ location: { kind: 'xlsx-object', part: name }, reason: '图表或图形对象未解析，请在 Office 中查看该对象' });
  }
  sheets.forEach((sheet, sheetIndex) => {
    const key = 'xl/' + String(sheet.target).replace(/^\/+/, '').replace(/^xl\//, '');
    const xml = entries.get(key)?.toString('utf8');
    if (!xml) {
      unread.push({ location: { kind: 'worksheet', sheet: sheet.name }, reason: '工作表内容未找到：' + key });
      return;
    }
    if (sheet.state !== 'visible')
      sections.push({ sectionId: 'sheet-' + (sheetIndex + 1) + '-hidden', location: { kind: 'worksheet', sheet: sheet.name, sheetIndex, state: sheet.state }, kind: 'worksheet-note', text: '工作表「' + sheet.name + '」为' + (sheet.state === 'veryHidden' ? '深度隐藏' : '隐藏') + '状态' });
    const hiddenCols = [...xml.matchAll(/<col\b[^>]*hidden="1"[^>]*\/>/g)].flatMap(match => {
      const min = Number(/min="(\d+)"/.exec(match[0])?.[1]);
      const max = Number(/max="(\d+)"/.exec(match[0])?.[1] || min);
      if (!Number.isSafeInteger(min) || min < 1 || !Number.isSafeInteger(max) || max < min) return [];
      return Array.from({ length: Math.min(1000, max - min + 1) }, (_, index) => min + index);
    });
    if (hiddenCols.length)
      sections.push({ sectionId: 'sheet-' + (sheetIndex + 1) + '-hidden-cols', location: { kind: 'worksheet', sheet: sheet.name }, kind: 'worksheet-note', text: '隐藏列：' + hiddenCols.join(', ') });
    const merges = [...xml.matchAll(/<mergeCell\b[^>]*ref="([^"]+)"/g)].map(match => match[1]);
    if (merges.length)
      sections.push({ sectionId: 'sheet-' + (sheetIndex + 1) + '-merges', location: { kind: 'worksheet', sheet: sheet.name }, kind: 'worksheet-note', text: '合并区域：' + merges.join(', ') });
    if (/<autoFilter\b/.test(xml))
      sections.push({ sectionId: 'sheet-' + (sheetIndex + 1) + '-filter', location: { kind: 'worksheet', sheet: sheet.name }, kind: 'worksheet-note', text: '工作表含自动筛选；未执行筛选计算，仅展示已存单元格和筛选区域' });
    const rows = [...xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)];
    rows.forEach((row, rowIndex) => {
      const rowNumber = Number(/r="(\d+)"/.exec(row[1])?.[1] || rowIndex + 1);
      const hidden = /hidden="1"/.test(row[1]);
      const cells = [...row[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(cell => {
        const ref = /r="([A-Z]+\d+)"/.exec(cell[1])?.[1] ?? '';
        const type = /t="([^"]+)"/.exec(cell[1])?.[1] ?? '';
        const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(cell[2])?.[1];
        const rawValue = /<v>([\s\S]*?)<\/v>/.exec(cell[2])?.[1];
        let value = '';
        if (type === 's') value = shared[Number(rawValue)] ?? '';
        else if (type === 'inlineStr') value = [...cell[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(item => stripTags(item[1])).join('');
        else value = rawValue !== undefined ? stripTags(rawValue) : '';
        return { ref, value, formula: formula !== undefined ? stripTags(formula) : '',
          formulaNoResult: formula !== undefined && rawValue === undefined };
      });
      const text = cells.filter(cell => cell.value || cell.formula)
        .map(cell => cell.ref + ': ' + cell.value + (cell.formulaNoResult ? '（公式无缓存结果，未猜值）' : cell.formula ? '（公式）' : '')).join(' | ');
      if (text || hidden)
        sections.push({
          sectionId: 'sheet-' + (sheetIndex + 1) + '-row-' + rowNumber,
          location: { kind: 'row', sheet: sheet.name, sheetIndex, sheetState: sheet.state, row: rowNumber, hidden, hiddenColumns: hiddenCols },
          kind: 'row', text: (hidden ? '[隐藏行] ' : '') + text, cells,
          hiddenColumns: hiddenCols,
          mergedRanges: merges.filter(ref => mergedRangeTouchesRow(ref, rowNumber)),
          formulasWithoutCache: cells.filter(cell => cell.formulaNoResult).map(cell => cell.ref),
        });
    });
  });
  return { kind: 'xlsx', sections, unread, warnings: [] };
}

export function columnNumber(reference) {
  const letters = /^([A-Z]+)/i.exec(String(reference || ''))?.[1]?.toUpperCase() || '';
  let value = 0;
  for (const character of letters) value = value * 26 + character.charCodeAt(0) - 64;
  return value;
}

function mergedRangeTouchesRow(reference, row) {
  const match = /^[A-Z]+(\d+):[A-Z]+(\d+)$/i.exec(String(reference || ''));
  if (!match) return false;
  const from = Math.min(Number(match[1]), Number(match[2]));
  const to = Math.max(Number(match[1]), Number(match[2]));
  return row >= from && row <= to;
}

function parseText(text) {
  const lines = String(text).split(/\r?\n/);
  const chunk = 200, sections = [];
  for (let start = 0; start < lines.length; start += chunk) {
    const end = Math.min(lines.length, start + chunk);
    sections.push({
      sectionId: 'lines-' + (start + 1) + '-' + end,
      location: { kind: 'line-range', from: start + 1, to: end },
      kind: 'text', text: lines.slice(start, end).join('\n'),
    });
  }
  return { kind: 'text', sections, unread: [], warnings: [] };
}

export function parseDocumentBuffer(buffer, { displayName = '' } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error('文档内容必须是 Buffer');
  if (buffer.length > DOCUMENT_LIMITS.maxInputBytes) throw new Error('文档超过 20MiB 输入上限');
  const name = String(displayName || '').toLowerCase();
  const unreadableBinary = (kind, reason, mimeType = '') => ({
    displayName, parseState: 'unreadable', kind, sections: [],
    unread: [{ location: { kind: 'binary', format: kind, mimeType }, reason }], warnings: [],
  });
  const starts = (...bytes) => buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    let entries;
    try { entries = readZipEntries(buffer); }
    catch (error) {
      if (/\.docx?$/.test(name) || /\.xlsx?$/.test(name)) throw error;
      return unreadableBinary('zip', '这是 ZIP 压缩包，当前未配置解包预览；原件已保留，可在本地工具中打开。', 'application/zip');
    }
    if (entries.has('word/document.xml')) return { displayName, parseState: 'ready', ...parseDocx(entries) };
    if (entries.has('xl/workbook.xml')) return { displayName, parseState: 'ready', ...parseXlsx(entries) };
    return unreadableBinary('zip', '这是未适配的 ZIP 容器；原件已保留，请使用对应本地工具打开。', 'application/zip');
  }
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-' || /\.pdf$/.test(name))
    return unreadableBinary('pdf', 'PDF 尚未配置文本提取或 OCR；原件已保留，请使用本地 PDF 工具打开。', 'application/pdf');
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) || /\.png$/.test(name))
    return unreadableBinary('image', '图片尚未配置 OCR；原件已保留，请使用本地图片查看或 OCR 工具打开。', 'image/png');
  if (starts(0xff, 0xd8, 0xff) || /\.(?:jpe?g)$/.test(name))
    return unreadableBinary('image', '图片尚未配置 OCR；原件已保留，请使用本地图片查看或 OCR 工具打开。', 'image/jpeg');
  if (starts(0x47, 0x49, 0x46, 0x38) || /\.gif$/.test(name))
    return unreadableBinary('image', '动图或图片尚未配置 OCR；原件已保留，请使用本地图片工具打开。', 'image/gif');
  if (starts(0x42, 0x4d) || /\.bmp$/.test(name))
    return unreadableBinary('image', '位图尚未配置 OCR；原件已保留，请使用本地图片工具打开。', 'image/bmp');
  if (starts(0x52, 0x49, 0x46, 0x46) && buffer.subarray(8, 12).toString('ascii') === 'WEBP')
    return unreadableBinary('image', '图片尚未配置 OCR；原件已保留，请使用本地图片工具打开。', 'image/webp');
  if (/\.docx?$/.test(name)) throw new Error('文件扩展名是 Word，但内容不是有效的 .docx（旧版 .doc 不支持，请另存为 .docx 或粘贴正文）');
  if (/\.xlsx?$/.test(name)) throw new Error('文件扩展名是 Excel，但内容不是有效的 .xlsx（旧版 .xls 不支持，请另存为 .xlsx 或粘贴正文）');
  let decoded;
  try {
    if (starts(0xff, 0xfe)) decoded = buffer.subarray(2).toString('utf16le');
    else if (starts(0xfe, 0xff)) {
      const swapped = Buffer.allocUnsafe(buffer.length - 2);
      for (let index = 2; index + 1 < buffer.length; index += 2) {
        swapped[index - 2] = buffer[index + 1];
        swapped[index - 1] = buffer[index];
      }
      decoded = new TextDecoder('utf-16le', { fatal: true }).decode(swapped);
    } else decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return unreadableBinary('binary', '内容不是有效 UTF-8/UTF-16 文本，当前格式尚未适配；原件已保留。', 'application/octet-stream');
  }
  if (decoded.includes('\0')) return unreadableBinary('binary', '内容含二进制 NUL 字节，当前格式尚未适配；原件已保留。', 'application/octet-stream');
  const controlCount = [...decoded].filter(character => {
    const code = character.codePointAt(0);
    return (code < 9 || (code > 13 && code < 32)) && code !== 0x1b;
  }).length;
  if (decoded.length && controlCount / decoded.length > 0.01)
    return unreadableBinary('binary', '内容含大量不可打印字节，当前格式尚未适配；原件已保留。', 'application/octet-stream');
  return { displayName, parseState: 'ready', ...parseText(decoded) };
}

export function readDocumentFile(filePath, options = {}) {
  const resolved = path.resolve(String(filePath));
  const buffer = fs.readFileSync(resolved);
  return parseDocumentBuffer(buffer, { displayName: options.displayName || path.basename(resolved) });
}

/** 云链接：没有对应已授权连接能力时明确不可读，不声称支持所有平台。 */
export function readDocumentUrl(url) {
  const value = String(url || '');
  return {
    displayName: value, parseState: 'unreadable', kind: 'url', sections: [],
    unread: [{ location: { kind: 'url', url: value }, reason: '当前无法读取此链接，请导出或粘贴内容' }], warnings: [],
  };
}

export function readDocumentSection(parsed, sectionId, { cursor = 0, limit = 8192 } = {}) {
  const section = (parsed?.sections || []).find(item => item.sectionId === sectionId);
  if (!section) throw new Error('未找到该文档段落：' + sectionId);
  const buffer = Buffer.from(String(section.text || ''), 'utf8');
  const start = Math.max(0, Number(cursor) || 0);
  if (start > buffer.length) throw new Error('文档读取位置超出段落范围：' + start + ' > ' + buffer.length);
  const requested = Number(limit);
  const size = Math.max(1, Math.min(DOCUMENT_LIMITS.maxReadBytes,
    Number.isFinite(requested) && requested > 0 ? requested : DOCUMENT_LIMITS.maxReadBytes));
  let end = Math.min(buffer.length, start + size);
  while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
  if (end === start && start < buffer.length) {
    end = start + 1;
    while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end += 1;
  }
  const text = buffer.toString('utf8', start, end);
  const bytes = Buffer.byteLength(text, 'utf8');
  return { sectionId, location: section.location ?? null, text, bytes, range: { start, end },
    nextCursor: end < buffer.length ? end : null, more: end < buffer.length };
}

/** A bounded batch returns only actual text ranges; unreturned sections stay unread. */
export function readDocumentSections(parsed, sectionIds, { limit = 8192 } = {}) {
  if (!Array.isArray(sectionIds) || !sectionIds.length || sectionIds.length > 20
    || sectionIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(sectionIds).size !== sectionIds.length)
    throw new Error('sectionIds 需要 1–20 个不重复的段落 ID');
  for (const id of sectionIds) if (!(parsed?.sections || []).some(section => section.sectionId === id))
    throw new Error('未找到该文档段落：' + id);
  const requested = Number(limit);
  let remaining = Math.max(1, Math.min(DOCUMENT_LIMITS.maxReadBytes,
    Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DOCUMENT_LIMITS.maxReadBytes));
  const entries = [], unreadSectionIds = [];
  for (const id of sectionIds) {
    if (!remaining) { unreadSectionIds.push(id); continue; }
    const entry = readDocumentSection(parsed, id, { limit: remaining });
    entries.push(entry);
    remaining -= entry.bytes;
  }
  return { entries, unreadSectionIds };
}
