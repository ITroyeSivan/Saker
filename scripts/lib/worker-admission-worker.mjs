// One-shot worker for the cross-process reservation test.
// Usage: node worker-admission-worker.mjs <dbPath> <parentId> <token> <limit> <holdMs>
import { openStore } from '../../plugins/dsh-redteam-results/lib/store.js';
import { reserveWorkerSlot } from '../../plugins/dsh-redteam-results/lib/worker-admission.js';

const [dbPath, parentId, token, limitText, holdText] = process.argv.slice(2);
const limit = Number(limitText);
const holdMs = Number(holdText) || 0;
const store = openStore(dbPath);
try {
  const ok = reserveWorkerSlot(store, parentId, limit, 0, token, { ownerRuntime: 'worker-admission-test' });
  console.log(JSON.stringify({ ok }));
  if (holdMs > 0) await new Promise(resolve => setTimeout(resolve, holdMs));
} finally {
  store.close();
}
