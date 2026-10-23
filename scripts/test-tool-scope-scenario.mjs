import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import { apply } from '../plugins/dsh-tool-scope/lib/index.js';

const known = [
  'read', 'write', 'web_fetch', 'saker_browser', 'redteam_task', 'redteam_context',
  'redteam_execution', 'redteam_research', 'redteam_method', 'redteam_checks',
  'project_document', 'project_check', 'project_request', 'tool_pack',
];
let scenario = 'pentest';
const events = new Map();
const restrictions = new Map();
const ctx = {
  tools: {
    schemas: () => known.map(name => ({ name })),
    register: () => {},
  },
  agentPresets: { composedPreset: () => 'pentest' },
  sakerTaskScenario: { get: () => scenario },
  logger: { info: () => {}, warn: () => {} },
  on(name, handler) { events.set(name, [...(events.get(name) || []), handler]); },
};
apply(ctx, {
  log: false,
  packs: { 'task-workflow': false, 'asset-discovery': false, 'active-scan': false, webshell: false },
});

function agent(id) {
  const active = new Set();
  restrictions.set(id, active);
  return {
    id,
    session: { id, header: { agentPreset: 'pentest' } },
    ctx: {
      tools: {
        schemas: () => known.filter(name => ![...active].some(deny => deny.has(name))).map(name => ({ name })),
        restrict({ deny }) {
          const set = new Set(deny);
          active.add(set);
          return () => active.delete(set);
        },
      },
    },
  };
}
function visible(id) {
  return known.filter(name => ![...(restrictions.get(id) || [])].some(deny => deny.has(name)));
}
function fire(name, payload) {
  for (const handler of events.get(name) || []) handler(payload);
}

const first = agent('scenario-free');
fire('agent/created', { agent: first });
assert(!visible(first.id).includes('project_document'));
assert(!visible(first.id).includes('project_check'));
assert(!visible(first.id).includes('project_request'));
assert(visible(first.id).includes('redteam_execution'));

scenario = 'project';
fire('agent/inbox/inserted', { agent: first });
assert(visible(first.id).includes('project_document'));
assert(visible(first.id).includes('project_check'));
assert(visible(first.id).includes('project_request'));
assert(!visible(first.id).includes('redteam_execution'));
assert(!visible(first.id).includes('redteam_research'));

scenario = 'pentest';
fire('agent/inbox/inserted', { agent: first });
assert(!visible(first.id).includes('project_document'));
assert(visible(first.id).includes('redteam_execution'));

scenario = 'project';
const second = agent('scenario-project-new');
fire('agent/created', { agent: second });
assert(visible(second.id).includes('project_check'));
assert(!visible(second.id).includes('redteam_execution'));

fire('agent/disposed', { agent: first });
fire('agent/disposed', { agent: second });
console.log('all passed');
