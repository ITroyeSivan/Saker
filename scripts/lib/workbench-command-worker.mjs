// One-shot workbench command runner for the cross-process command claim test.
// Usage: node workbench-command-worker.mjs <dbPath> <commandId> <holdMs>
import { openStore } from '../../plugins/dsh-redteam-results/lib/store.js';
import { workbenchCommand } from '../../plugins/dsh-redteam-results/lib/workbench.js';

const [dbPath, commandId, holdText] = process.argv.slice(2);
const holdMs = Number(holdText) || 0;
const store = openStore(dbPath);
const ctx = { agents: { get: () => null }, sessions: { get: () => null } };
try {
  const result = await workbenchCommand(ctx, store, {
    commandId,
    kind: 'role.resume',
    context: { rootId: 'root-cross-process' },
    payload: { reason: 'cross-process claim test' },
  }, {
    agentFor: () => ({ session: { id: 'root-cross-process' } }),
    roleRuntime: {
      resumeQueued: async () => {
        if (holdMs > 0) await new Promise(resolve => setTimeout(resolve, holdMs));
        return { ok: true, resumed: true, childId: 'child-cross-process' };
      },
    },
  });
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error?.code || null, error: String(error?.message || error) }));
} finally {
  store.close();
}
