import { openStore, insertTrace } from "../plugins/dsh-trace-vault/lib/store.js";

const [dbPath, worker, count] = process.argv.slice(2);
const st = openStore(dbPath);
try {
	for (let i = 0; i < Number(count); i += 1) {
		insertTrace(st, {
			id: `${worker}:${i}`,
			sessionId: `session-${worker}`,
			mode: "pentest",
			tool: "stress",
			args: JSON.stringify({ worker, i }),
			result: `ok-${i}`,
		});
	}
	process.stdout.write(JSON.stringify({ ok: true, worker, count: Number(count) }));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, worker, error: error?.message ?? String(error) }));
	process.exitCode = 1;
} finally {
	st.close();
}
