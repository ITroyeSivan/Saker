// Full context stays local; delivery contains only asset / check / status.
import { verificationBasis } from 'dsh-saker/verification-basis';
export const CHECK_STATUSES = ['not-hit', 'not-applicable', 'blocked', 'not-tested'];
export const CHECK_LABELS = { 'not-hit': '已测未命中', 'not-applicable': '不适用', blocked: '受阻', 'not-tested': '未测' };
const FIELDS = ['assetId', 'entryId', 'endpoint', 'methodVersion', 'authContext', 'requestRevision'];
function text(value, field, limit = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f]/.test(value)) throw new Error(field + ' must be a nonempty bounded single-line string');
  return value.trim();
}
export function normalizeCheck(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('check must be an object');
  const row = Object.fromEntries(FIELDS.map(field => [field, text(input[field], field)]));
  const endpoint = new URL(row.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('endpoint must be a credential-free HTTP(S) URL');
  endpoint.hash = ''; row.endpoint = endpoint.href;
  row.asset = text(input.asset ?? row.assetId, 'asset');
  row.check = text(input.check ?? row.entryId, 'check');
  if (!CHECK_STATUSES.includes(input.status)) throw new Error('invalid check status');
  row.status = input.status;
  row.executed = input.executed === true;
  row.requestValid = input.requestValid === true;
  row.observationValid = input.observationValid === true;
  row.supplementAttempts = input.supplementAttempts ?? 0;
  if (!Number.isInteger(row.supplementAttempts) || row.supplementAttempts < 0) throw new Error('invalid supplementAttempts');
  if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length > 100) throw new Error('evidenceIds must be an array of at most 100 references');
  row.evidenceIds = [...new Set(input.evidenceIds.map(value => text(value, 'evidenceId', 500)))];
  row.reason = input.reason === undefined || input.reason === '' ? '' : text(input.reason, 'reason', 4000);
  if (input.verificationBasis !== undefined) {
    if (!/^saker-verification-basis\/1:[a-f0-9]{64}$/.test(input.verificationBasis)) throw new Error('invalid verification basis');
    row.verificationBasis = input.verificationBasis;
  }
  if (row.status === 'not-hit' && (!row.executed || !row.requestValid || !row.observationValid || !row.evidenceIds.length)) throw new Error('not-hit requires execution, valid request, valid observation and evidence');
  if (row.status === 'not-applicable' && !row.evidenceIds.length) throw new Error('not-applicable requires contradicting-condition evidence');
  if (row.status === 'blocked' && !row.reason) throw new Error('blocked requires a local reason');
  if (row.status === 'not-tested' && row.executed) throw new Error('executed check cannot be labelled not-tested');
  return row;
}
export function checkedKey(row) { return JSON.stringify(FIELDS.map(field => row[field])); }
function negativeResearchConflict(store, sessionId, row) {
  if (row.status !== 'not-hit' || !store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_hypotheses'").get()) return '';
  const studies = store.db.prepare('SELECT id,record FROM research_hypotheses WHERE session_id=?').all(sessionId);
  for (const study of studies) {
    const binding = JSON.parse(study.record).binding;
    if (binding.endpoint !== row.endpoint || binding.authContext !== row.authContext || binding.requestRevision !== row.requestRevision) continue;
    const saved = store.db.prepare('SELECT record FROM research_observations WHERE session_id=? AND hypothesis_id=? ORDER BY rowid DESC LIMIT 1').get(sessionId, study.id);
    if (!saved) continue;
    const last = JSON.parse(saved.record);
    if (row.entryId !== study.id && !row.evidenceIds.includes(last.id)) continue;
    if (last.evidenceOrigin === 'host-http-execution' && last.outcome === 'difference' && last.assessment?.outcome !== 'counterevidence') {
      return '比较尚未解释或仍支持疑点，不能登记为已测未命中。保留待复核线索；如需反证，用assess说明业务含义。observationId=' + last.id;
    }
  }
  return '';
}
export function saveChecks(store, sessionId, input) {
  text(sessionId, 'sessionId', 500);
  if (!Array.isArray(input) || !input.length || input.length > 200) throw new Error('checks batch must contain 1..200 records');
  const rows = input.map(normalizeCheck);
  const keys = rows.map(checkedKey);
  if (new Set(keys).size !== keys.length) throw new Error('duplicate context in batch');
  const statement = store.db.prepare('INSERT INTO checked_items (session_id,context_key,record,updated_at) VALUES (?,?,?,?) ON CONFLICT(session_id,context_key) DO UPDATE SET record=excluded.record,updated_at=excluded.updated_at');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const snapshot = store.db.prepare('SELECT record FROM task_context WHERE session_id=?').get(sessionId);
    const context = snapshot ? JSON.parse(snapshot.record) : null;
    for (let i = 0; i < rows.length; i++) {
      const conflict = negativeResearchConflict(store, sessionId, rows[i]);
      if (conflict) throw new Error(conflict);
      // Ignore caller-supplied cache stamps. Bind to the current saved task evidence.
      delete rows[i].verificationBasis;
      const matching = (context?.checks || []).filter(check => checkedKey(check) === keys[i]);
      if (matching.length === 1) {
        const basis = verificationBasis(matching[0], context);
        if (basis) rows[i].verificationBasis = basis;
      }
      const old = store.db.prepare('SELECT record FROM checked_items WHERE session_id=? AND context_key=?').get(sessionId, keys[i]);
      if (old && rows[i].supplementAttempts < (JSON.parse(old.record).supplementAttempts || 0)) throw new Error('supplement attempts cannot decrease for the same request identity and method revision');
      statement.run(sessionId, keys[i], JSON.stringify(rows[i]), new Date().toISOString());
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return rows;
}
export function readChecks(store, sessionId) {
  text(sessionId, 'sessionId', 500);
  return store.db.prepare('SELECT record FROM checked_items WHERE session_id=? ORDER BY context_key').all(sessionId).map(saved => {
    const row = JSON.parse(saved.record), conflict = negativeResearchConflict(store, sessionId, row);
    // Preserve historical originals, but never export a contradicted negative as current.
    return conflict ? { ...row, status: 'blocked', reason: conflict, classificationCurrent: false } : row;
  });
}
export function compactChecks(rows) {
  return rows.map(row => ({ asset: row.asset, check: row.check, status: CHECK_LABELS[row.status] }));
}
export function renderCheckedTsv(rows) {
  // Protect spreadsheet imports from formula evaluation; internal originals remain intact.
  const cell = value => /^[=+@-]/.test(value) ? "'" + value : value;
  return '资产\t检查项\t状态\n' + compactChecks(rows).map(row => [row.asset, row.check, row.status].map(cell).join('\t')).join('\n') + (rows.length ? '\n' : '');
}
