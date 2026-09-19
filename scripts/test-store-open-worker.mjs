import { join } from "node:path";
import { openStore as openAttackAtlas } from "../plugins/dsh-attack-atlas/lib/store.js";
import { openStore as openCampaignMemory } from "../plugins/dsh-campaign-memory/lib/store.js";
import { openHunterStore } from "../plugins/dsh-hunter/lib/store.js";
import { openStore as openRedteamResults } from "../plugins/dsh-redteam-results/lib/store.js";
import { openStore as openTraceVault } from "../plugins/dsh-trace-vault/lib/store.js";
import { openStore as openWebshellManager } from "../plugins/dsh-webshell-mgr/lib/store.js";

const [baseDir] = process.argv.slice(2);
if (!baseDir) throw new Error("baseDir required");

const stores = [
	["attack-atlas", openAttackAtlas],
	["campaign-memory", openCampaignMemory],
	["hunter", openHunterStore],
	["redteam-results", openRedteamResults],
	["trace-vault", openTraceVault],
	["webshell-mgr", openWebshellManager],
];

for (const [name, open] of stores) {
	const store = open(join(baseDir, `${name}.db`));
	try {
		store.db.exec("BEGIN IMMEDIATE");
		store.db.exec("COMMIT");
	} finally {
		store.close();
	}
}
