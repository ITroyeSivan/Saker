// Internal control records for the security workbench. These tables only hold
// Saker control/query metadata; Host sessions, receipts, findings, materials and
// role definitions remain in their existing tables.
export const WORKBENCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS saker_business_roots (
  root_id TEXT PRIMARY KEY,
  host_root_session TEXT NOT NULL,
  project_key TEXT NOT NULL DEFAULT '',
  task_kind TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saker_business_roots_host
  ON saker_business_roots(host_root_session,updated_at);
CREATE TABLE IF NOT EXISTS saker_run_generations (
  root_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  control_state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  admitted_at INTEGER,
  deadline_at INTEGER,
  cleanup_state TEXT NOT NULL DEFAULT 'clear',
  record TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(root_id,generation)
);
CREATE TABLE IF NOT EXISTS saker_command_records (
  command_id TEXT PRIMARY KEY,
  context_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  owner_pid INTEGER NOT NULL DEFAULT 0,
  owner_runtime TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saker_command_status
  ON saker_command_records(status,updated_at);
CREATE TABLE IF NOT EXISTS saker_scope_controls (
  root_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  state TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  record TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(root_id,generation,scope_kind,scope_id)
);
CREATE TABLE IF NOT EXISTS saker_work_guidance (
  guidance_id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  work_id TEXT NOT NULL,
  work_revision INTEGER NOT NULL,
  instruction TEXT NOT NULL,
  material_refs TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saker_work_guidance_work
  ON saker_work_guidance(root_id,generation,work_id,created_at);
CREATE TABLE IF NOT EXISTS saker_test_module_versions (
  owner_key TEXT NOT NULL,
  module_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  family TEXT NOT NULL DEFAULT 'custom',
  digest TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_key,module_id,version)
);
CREATE INDEX IF NOT EXISTS idx_saker_test_module_versions_owner
  ON saker_test_module_versions(owner_key,created_at);
CREATE TABLE IF NOT EXISTS saker_module_invocations (
  root_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  work_id TEXT NOT NULL,
  executor_ref TEXT NOT NULL,
  role_instance_ref TEXT NOT NULL DEFAULT '',
  owner_key TEXT NOT NULL,
  module_id TEXT NOT NULL,
  module_version INTEGER NOT NULL,
  module_digest TEXT NOT NULL,
  family TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL DEFAULT 'auto',
  input_refs TEXT NOT NULL DEFAULT '[]',
  capability_bindings TEXT NOT NULL DEFAULT '{}',
  policy_revision INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  scope_epoch INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT '',
  output_refs TEXT NOT NULL DEFAULT '[]',
  attempt_refs TEXT NOT NULL DEFAULT '[]',
  usage_refs TEXT NOT NULL DEFAULT '[]',
  task_pack TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER,
  ended_at INTEGER,
  cleanup_state TEXT NOT NULL DEFAULT 'clear',
  PRIMARY KEY(root_id,invocation_id)
);
CREATE INDEX IF NOT EXISTS idx_saker_module_invocations_work
  ON saker_module_invocations(root_id,generation,work_id,state);
CREATE TABLE IF NOT EXISTS saker_module_preferences (
  host_session TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  project_key TEXT NOT NULL,
  module_snapshot_ref TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'auto',
  apply_to TEXT NOT NULL DEFAULT 'next-work',
  revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'pending',
  bound_work_ref TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(host_session,workspace_key,project_key)
);
CREATE TABLE IF NOT EXISTS saker_definition_state (
  owner_key TEXT NOT NULL,
  definition_kind TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  archived_at INTEGER NOT NULL DEFAULT 0,
  display_alias TEXT NOT NULL DEFAULT '',
  metadata_revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_key,definition_kind,definition_id)
);
`;
