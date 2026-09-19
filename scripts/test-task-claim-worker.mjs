import { taskClaim } from "../plugins/dsh-stage-gate/lib/index.js";

const [workspace, owner = "sibling"] = process.argv.slice(2);
try {
	const result = taskClaim(workspace, { owner });
	process.stdout.write(JSON.stringify({ ok: true, id: result.id }));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, error: error?.message ?? String(error) }));
	process.exitCode = 1;
}
