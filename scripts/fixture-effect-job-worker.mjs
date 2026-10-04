// Owned child used only to verify durable dispatch handling after process death.
import fs from 'node:fs';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { runEffectJob } from '../plugins/dsh-redteam-results/lib/effect-jobs.js';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const store = openStore(config.database);
try { await runEffectJob(store, config.sessionId, config.input); }
finally { store.close(); }
