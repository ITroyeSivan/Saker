// 知识索引/检索的性能与延迟测量：可复现、只写工作区临时区。
//
// 为什么需要：G10 要求"索引/检索性能与延迟"的可复查数据，此前只有散落在注释里的经验值
// （例如"status() 每次 COUNT(*) 整表 ~140ms"）。这里把"建索引耗时 / 索引体积 / 检索延迟分位"
// 变成一条能重跑的命令，并把语料指纹、Node 版本、INDEX_VERSION 一起记进报告，
// 避免出现"数字没有上下文"。
//
// 引擎本身零依赖（只用 node: 内置），所以**不需要官方 Desktop**也能测。
//
// 用法:
//   node scripts/measure-knowledge-performance.mjs --synthetic 2000 --out <report.json>
//   node scripts/measure-knowledge-performance.mjs --corpus preset/shared/refs/PayloadsAllTheThings --out <report.json>
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INDEX_VERSION, KnowledgeIndex, TEXT_EXTS } from '../plugins/dsh-knowledge-hub/lib/index-engine.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = resolve(root, '..')
const boundary = resolve(workspace, '_ref', 'tmp')

/** 固定查询集：中英混合、含高精度拉丁术语与中文词，覆盖检索里的两条计划。 */
export const QUERIES = Object.freeze([
  'sql injection payload',
  '命令注入 绕过',
  'laravel debug',
  'path traversal payload',
  'jwt none algorithm',
  'xss filter bypass',
  'ssrf internal network',
  'linux 提权',
])

function walk(directory) {
  const out = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** 语料指纹：路径 + 大小的 sha1。内容会变、规模不会，用它锚定"这份数字对应哪份语料"。 */
function corpusDigest(directory) {
  const hash = createHash('sha1')
  let files = 0
  let bytes = 0
  for (const file of walk(directory).sort()) {
    const size = statSync(file).size
    files++
    bytes += size
    hash.update(`${relative(directory, file).replace(/\\/g, '/')}:${size}\n`)
  }
  return { files, bytes, digest: hash.digest('hex') }
}

const TOPICS = ['sql-injection', 'command-injection', 'path-traversal', 'xss-filter-bypass',
  'ssrf-internal-network', 'jwt-none-algorithm', 'laravel-debug', 'linux-privilege-escalation']

/**
 * 确定性合成语料：同样参数每次都产出同样的字节，便于跨版本比较。
 * @param directory - 写入目录（会被清空重建）。
 * @param fileCount - 文件数。
 * @param targetBytesPerFile - 每个文件的近似字节数；默认 1200，用于把语料放大到真实量级。
 * @returns 语料指纹 `{ files, bytes, digest }`。
 */
export function writeSyntheticCorpus(directory, fileCount, targetBytesPerFile = 1200) {
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  for (let index = 0; index < fileCount; index++) {
    const topic = TOPICS[index % TOPICS.length]
    const topicDir = join(directory, topic)
    mkdirSync(topicDir, { recursive: true })
    const header = [
      `# ${topic} note ${index}`,
      '',
      `本文件覆盖 ${topic} 的检测与利用要点，编号 ${index}。`,
      `命令注入 绕过 的变体编号 ${index % 17}；sql injection payload 变体编号 ${index % 23}。`,
      `path traversal payload、xss filter bypass、ssrf internal network、jwt none algorithm 都会在本文出现。`,
      `laravel debug 与 linux 提权 的相关命令在本节重复 ${(index % 5) + 1} 次，用于制造真实的长文档分块。`,
      '',
      '## 复现步骤',
    ]
    const steps = []
    let size = header.join('\n').length
    for (let line = 0; size < targetBytesPerFile; line++) {
      const text = `- step ${line + 1}: 针对 ${topic} 的第 ${(index + line) % 97} 号检查项，记录请求与响应原文与判定依据。`
      steps.push(text)
      size += text.length + 1
    }
    writeFileSync(join(topicDir, `note-${String(index).padStart(5, '0')}.md`), [...header, ...steps, ''].join('\n'), 'utf8')
  }
  return corpusDigest(directory)
}

const percentile = (values, ratio) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(ratio * (sorted.length - 1)))]
}

const dbBytes = dbPath => ['', '-wal', '-shm']
  .reduce((total, suffix) => total + (existsSync(dbPath + suffix) ? statSync(dbPath + suffix).size : 0), 0)

/**
 * 测一份语料：建索引耗时、索引体积、检索延迟分位。
 * @param options - `{ corpus, dbPath, queries, repeats }`；dbPath 必须在工作区临时区内。
 * @returns 报告片段（含语料指纹、索引规模、耗时与延迟）。
 */
export function runMeasurement({ corpus, dbPath, queries = QUERIES, repeats = 20 }) {
  if (!resolve(dbPath).startsWith(boundary)) throw new Error(`dbPath must stay under ${boundary}: ${dbPath}`)
  const corpusStats = corpusDigest(corpus)
  const index = new KnowledgeIndex({
    dbPath,
    roots: [{ root: corpus, kind: 'preset', mode: 'general', packId: 'performance-fixture' }],
    logger: { info() {}, warn() {}, error() {} },
  })
  try {
    const buildStarted = Date.now()
    index.rebuild({ force: true })
    const buildMs = Date.now() - buildStarted
    // 增量重建：语料没变时宿主启动走的就是这条路径（逐文件比 mtime/size/sha1，未变则跳过）。
    // 它比全量构建更贴近用户体感，所以单独记一笔。
    const incrementalStarted = Date.now()
    index.rebuild({ force: false })
    const incrementalMs = Date.now() - incrementalStarted
    const status = index.status({ counts: true })
    const indexBytes = dbBytes(dbPath)
    const latency = []
    const hits = []
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const query of queries) {
        const started = Date.now()
        const found = index.search(query, { limit: 8 })
        latency.push(Date.now() - started)
        if (repeat === 0) hits.push({ query, results: found.length, topPath: found[0]?.path ?? null })
      }
    }
    return {
      corpus: { path: relative(workspace, corpus).replace(/\\/g, '/'), ...corpusStats },
      index: { version: INDEX_VERSION, docs: status.docs, chunks: status.chunks, bytes: indexBytes, dbPath: relative(workspace, dbPath).replace(/\\/g, '/') },
      build: { ms: buildMs, filesPerSecond: corpusStats.files === 0 ? null : Number((corpusStats.files / (buildMs / 1000)).toFixed(1)),
        incrementalMs },
      search: { repeats, samples: latency.length, p50Ms: percentile(latency, 0.5), p95Ms: percentile(latency, 0.95), maxMs: Math.max(...latency) },
      firstPass: hits,
    }
  } finally {
    index.close()
  }
}

function main() {
  const argv = process.argv.slice(2)
  const flag = name => { const index = argv.indexOf(name); return index < 0 ? null : argv[index + 1] ?? null }
  const synthetic = Number(flag('--synthetic') ?? 0)
  const corpusArg = flag('--corpus')
  if (!synthetic && !corpusArg) {
    console.error('usage: node scripts/measure-knowledge-performance.mjs --synthetic <files> | --corpus <dir> [--out <report.json>] [--keep]')
    process.exit(2)
  }
  const keep = argv.includes('--keep')
  const id = `knowledge-perf-${process.pid}`
  const scratch = join(boundary, id)
  mkdirSync(scratch, { recursive: true })
  try {
    const corpus = corpusArg ? resolve(root, corpusArg) : join(scratch, 'corpus')
    const syntheticStats = synthetic ? writeSyntheticCorpus(corpus, synthetic) : null
    const measured = runMeasurement({ corpus, dbPath: join(scratch, 'knowledge.sqlite') })
    const report = {
      at: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      kind: synthetic ? `synthetic:${synthetic}` : 'real',
      ...(syntheticStats === null ? {} : { synthetic: syntheticStats }),
      ...measured,
    }
    const out = resolve(root, flag('--out') ?? join(workspace, '_ref', 'private', 'saker-development', '2026-10-11', 'knowledge-performance', 'report.json'))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({ kind: report.kind, files: report.corpus.files, corpusMB: Number((report.corpus.bytes / 1048576).toFixed(1)),
      docs: report.index.docs, chunks: report.index.chunks, indexMB: Number((report.index.bytes / 1048576).toFixed(1)),
      buildMs: report.build.ms, incrementalMs: report.build.incrementalMs,
      p50Ms: report.search.p50Ms, p95Ms: report.search.p95Ms, out }, null, 2))
  } finally {
    if (!keep) rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    else console.log(`kept ${scratch}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
