import { Worker } from 'node:worker_threads';

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_PARSE_MS = 15000;
const MAX_ACTIVE = 2;
let active = 0;

// The deadline terminates the entire parser, including synchronous zlib/XML work.
// Keep this module free of store imports: timed-out work must not write sources.
export async function parseDocumentIsolated(buffer, { displayName = '', signal, timeoutMs = MAX_PARSE_MS } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error('文档内容必须是 Buffer');
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('文档超过 20MiB 输入上限');
  signal?.throwIfAborted();
  if (active >= MAX_ACTIVE) throw new Error('正在读取其他文档，请稍后重试');
  const deadlineMs = Math.max(1, Math.min(MAX_PARSE_MS, Number(timeoutMs) || MAX_PARSE_MS));
  active++;
  let worker;
  try {
    worker = new Worker(new URL('./project-document-worker.js', import.meta.url), {
      workerData: { bytes: Uint8Array.from(buffer), displayName: String(displayName) },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
    });
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = async (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        try { await worker.terminate(); } catch { /* Already exited. */ }
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('文档读取已取消'));
      const timer = setTimeout(() => finish(new Error('文档解析超时，已停止读取；请缩小文件或导出为文本后重试')), deadlineMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      worker.once('message', message => message?.ok === true
        ? finish(null, message.result) : finish(new Error(message?.error || '文档解析失败')));
      worker.once('error', error => finish(new Error('文档解析失败：' + error.message)));
      worker.once('exit', code => finish(new Error('文档解析进程提前结束（' + code + '）')));
    });
  } finally { active--; }
}
