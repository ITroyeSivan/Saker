import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import { apply, PACKS, RULES } from '../plugins/dsh-tool-scope/lib/index.js';

assert(!PACKS.some(pack => pack.id === 'webshell'), 'retired WebShell pack must not be advertised');
assert(RULES.find(rule => rule.id === 'webshell')?.modes.length === 1, 'defensive hidden rule remains for residual installs');

let known = [
  'read', 'write', 'web_fetch', 'saker_browser', 'redteam_task', 'redteam_context',
  'redteam_execution', 'redteam_research', 'redteam_method', 'redteam_checks',
  'project_document', 'tool_pack',
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
assert(visible(first.id).includes('redteam_execution'));

known.push('project_check', 'project_request');
fire('agent/inbox/inserted', { agent: first });
assert(!visible(first.id).includes('project_check'));
assert(!visible(first.id).includes('project_request'));

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

scenario = 'pentest';
const retryEvents = new Map();
let retryAttempts = 0;
let retryFailure = true;
const retryRestrictions = new Set();
const retryCtx = {
  tools: { schemas: () => known.map(name => ({ name })), register: () => {} },
  agentPresets: { composedPreset: () => 'pentest' },
  sakerTaskScenario: { get: () => scenario },
  logger: { info: () => {}, warn: () => {} },
  on(name, handler) { retryEvents.set(name, [...(retryEvents.get(name) || []), handler]); },
};
apply(retryCtx, { log: false, packs: { 'task-workflow': false, 'asset-discovery': false, 'active-scan': false } });
const retryVisible = () => known.filter(name => ![...retryRestrictions].some(deny => deny.has(name)));
const retryAgent = {
  id: 'scenario-retry',
  session: { id: 'scenario-retry', header: { agentPreset: 'pentest' } },
  ctx: { tools: {
    schemas: () => retryVisible().map(name => ({ name })),
    restrict({ deny }) {
      retryAttempts += 1;
      if (retryFailure) {
        retryFailure = false;
        throw Error('transient host restriction failure');
      }
      const set = new Set(deny);
      retryRestrictions.add(set);
      return () => retryRestrictions.delete(set);
    },
  } },
};
for (const handler of retryEvents.get('agent/created') || []) handler({ agent: retryAgent });
assert.equal(retryAttempts, 1, 'first restriction attempt must run');
assert(retryVisible().includes('project_document'), 'failed restriction leaves the tool visible');
for (const handler of retryEvents.get('agent/inbox/inserted') || []) handler({ agent: retryAgent });
assert.equal(retryAttempts, 2, 'same scenario must retry after host restriction failure');
assert(!retryVisible().includes('project_document'), 'successful retry hides the other-scenario tool');
for (const handler of retryEvents.get('agent/inbox/inserted') || []) handler({ agent: retryAgent });
assert.equal(retryAttempts, 2, 'successful signature is cached after the restriction commits');
for (const handler of retryEvents.get('agent/disposed') || []) handler({ agent: retryAgent });
assert.equal(retryRestrictions.size, 0, 'retry restriction is released on disposal');

let packKnown = ['read', 'redteam_execution'];
let packScenario = 'pentest';
const packRestrictions = new Map();
const packEvents = new Map();
let packTool = null;
const packCtx = {
  tools: {
    schemas: () => packKnown.map(name => ({ name })),
    register: tool => { packTool = tool; },
  },
  agentPresets: { composedPreset: () => 'pentest' },
  sakerTaskScenario: { get: () => packScenario },
  logger: { info: () => {}, warn: () => {} },
  on(name, handler) { packEvents.set(name, [...(packEvents.get(name) || []), handler]); },
};
apply(packCtx, { log: false, packs: { 'task-workflow': false, 'asset-discovery': false, webshell: false } });
const packAgent = {
  id: 'pack-agent',
  session: { id: 'pack-session', header: { agentPreset: 'pentest' } },
  ctx: { tools: {
    schemas: () => packKnown.filter(name => ![...(packRestrictions.get('pack-agent') || [])].some(deny => deny.has(name))).map(name => ({ name })),
    restrict({ deny }) {
      const set = new Set(deny);
      if (!packRestrictions.has('pack-agent')) packRestrictions.set('pack-agent', new Set());
      packRestrictions.get('pack-agent').add(set);
      return () => packRestrictions.get('pack-agent')?.delete(set);
    },
  } },
};
const packVisible = () => packKnown.filter(name => ![...(packRestrictions.get('pack-agent') || [])].some(deny => deny.has(name)));
for (const handler of packEvents.get('agent/created') || []) handler({ agent: packAgent });
packKnown.push('nuclei_scan');
for (const handler of packEvents.get('agent/inbox/inserted') || []) handler({ agent: packAgent });
assert(!packVisible().includes('nuclei_scan'), 'late scanner registration must stay deferred');
assert.equal((await packTool.execute({ action: 'load', pack: 'active-scan' }, { agent: packAgent })).loaded, true);
assert(packVisible().includes('nuclei_scan'), 'loaded pack becomes visible');
assert.equal((await packTool.execute({ action: 'unload', pack: 'active-scan' }, { agent: packAgent })).loaded, false);
assert(!packVisible().includes('nuclei_scan'), 'unloaded pack is hidden again');
for (const handler of packEvents.get('agent/disposed') || []) handler({ agent: packAgent });
console.log('all passed');
