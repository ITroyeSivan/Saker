import { taskTransition } from "../plugins/dsh-stage-gate/lib/index.js";

const [workspace, id, action, owner = ""] = process.argv.slice(2);
try {
	const result = taskTransition(workspace, { id, action, owner });
	process.stdout.write(JSON.stringify({ ok: true, id: result.id, state: result.task.state }));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, error: error?.message ?? String(error) }));
	process.exitCode = 1;
}
