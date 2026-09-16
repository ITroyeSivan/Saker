import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "wsm-settings-"));
process.env.DSH_HOME = home;
try {
	const { apply } = await import("../lib/index.js");
	let schema = null;
	const warnings = [];
	const settings = {
		register(_namespace, value) {
			schema = value;
			return { get: () => ({ genDir: "" }), watch: () => {} };
		},
		get: () => ({}),
		on: () => {},
	};
	const ctx = {
		tools: { register: () => () => {} },
		webServer: { register: () => ({ dispose() {} }) },
		webRuntime: { trustedHosts: [] },
		effect: () => {},
		logger: { info: () => {}, warn: (...args) => warnings.push(args.map(String).join(" ")) },
		inject: (_deps, callback) => callback({
				settings,
				connection: { register: () => {}, rpc: { handle: () => {} } },
				systemPrompt: { context: () => {} },
			}),
	};
	apply(ctx);
	if (!schema) throw new Error("schema 未传给 settings.register");
	if (warnings.some((line) => line.includes("settings register failed"))) throw new Error(warnings.join("\n"));
	console.log("ok settings schema");
} finally {
	fs.rmSync(home, { recursive: true, force: true });
}
