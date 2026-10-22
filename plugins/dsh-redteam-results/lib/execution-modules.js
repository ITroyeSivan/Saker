import path from 'node:path';
import os from 'node:os';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

/** Store lives at `<home>/redteam-results/results.db`. */
export function storeHome(store) {
  return store.dbPath === ':memory:' ? DSH_HOME : path.dirname(path.dirname(store.dbPath));
}

/** Test-content modules are historical only; they no longer gate execution. */
export function rootModuleSelection(store) {
  return {
    selection: { active: [], rev: 0, policyRev: 0 },
    config: { defaults: [] },
    home: storeHome(store),
  };
}

export function requiredContentFor() {
  return [];
}

export function moduleGateFor() {
  return () => undefined;
}
