import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { importLegacyCompetitionKnowledge, migrateKnowledgeProject, searchKnowledgeIndex } from './knowledge-index.js';
import { mergeKnowledgeSearch, searchLegacyKnowledge } from './legacy-knowledge.js';

try {
  const { projectKey, sourceSessionId = projectKey, request = {}, storePath = '',
    migrateProject = false, migrateLegacy = false } = workerData || {};
  let projectMigrated = false, legacyMigrated = false;
  if (migrateLegacy && storePath && storePath !== ':memory:') {
    const db = new DatabaseSync(storePath);
    try {
      const imported = importLegacyCompetitionKnowledge({ db }, sourceSessionId, { destinationProjectKey: projectKey });
      legacyMigrated = imported.failed === 0;
    } finally { db.close(); }
  }
  if (migrateProject) projectMigrated = !!migrateKnowledgeProject(sourceSessionId, projectKey);
  const current = searchKnowledgeIndex(projectKey, request);
  const legacy = searchLegacyKnowledge(request.query, request);
  parentPort.postMessage({ ok: true, result: mergeKnowledgeSearch(current, legacy), projectMigrated, legacyMigrated });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.message || error) });
}
