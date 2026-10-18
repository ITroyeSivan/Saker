// work-lease-worker.mjs — 一个**独立进程**的工作者，用来验证跨进程领取/续租/接手。
// 同一个 SQLite 结果库（WAL + busy_timeout）被多个进程同时打开；领取唯一性靠
// 事务 + 主键，而不是同进程内的内存状态。这个脚本只做一次动作，把结果打成 JSON。
//
// 用法: node work-lease-worker.mjs <dbPath> <action> <jsonArgs>
//   action ∈ claim | heartbeat | complete | release | expire | list
import { openStore } from '../../plugins/dsh-redteam-results/lib/store.js';
import { claimWork, heartbeatWork, completeWork, releaseWork, expireWorkLeases, listWorkLeases } from '../../plugins/dsh-redteam-results/lib/work-lease.js';

const [dbPath, action, argsJson] = process.argv.slice(2);
if (!dbPath || !action) { console.error('usage: node work-lease-worker.mjs <dbPath> <action> <jsonArgs>'); process.exit(2) }
const args = argsJson ? JSON.parse(argsJson) : {};

const store = openStore(dbPath);
let payload;
try {
  if (action === 'claim') payload = claimWork(store, args.parentSession, args);
  else if (action === 'heartbeat') payload = heartbeatWork(store, args.key, args);
  else if (action === 'complete') payload = completeWork(store, args.key, args);
  else if (action === 'release') payload = releaseWork(store, args.key, args);
  else if (action === 'expire') payload = expireWorkLeases(store, args.parentSession, args.now);
  else if (action === 'list') payload = listWorkLeases(store, args.parentSession);
  else throw new Error('unknown action ' + action);
  console.log(JSON.stringify({ ok: true, out: payload }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code || null, error: error.message }));
} finally {
  store.close();
}
