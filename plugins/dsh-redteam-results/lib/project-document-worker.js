import { parentPort, workerData } from 'node:worker_threads';
import { parseDocumentBuffer } from './project-documents.js';

try {
  const result = parseDocumentBuffer(Buffer.from(workerData.bytes), { displayName: workerData.displayName });
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error.message || error) });
}
