// Case truth stays in the runner. Only lab.brief() is given to the agent.
export const CASESET_VERSION = 'task-effects/v1';
const cases = [
  ...['query', 'path', 'post', 'header', 'export', 'nested', 'alternate', 'cache'].map((transport, index) =>
    ({ id: `p${index + 1}`, split: 'calibration', category: 'single-positive', transport, vulnerable: true })),
  ...['bearer', 'cookie', 'csrf', 'refresh', 'ticket', 'realm'].map((flow, index) =>
    ({ id: `m${index + 1}`, split: 'calibration', category: 'multi-positive', transport: 'query', flow, vulnerable: true })),
  ...['secured', 'similar-page', 'reflection', 'expired', 'version-unknown', 'shared'].map((behavior, index) =>
    ({ id: `n${index + 1}`, split: 'calibration', category: 'negative', transport: 'query', behavior, vulnerable: false })),
  ...['unavailable', 'unhealthy', 'disconnect', 'timeout'].map((fault, index) =>
    ({ id: `f${index + 1}`, split: 'calibration', category: 'fault', transport: 'query', fault, vulnerable: false })),
  ...Array.from({ length: 12 }, (_, index) => ({ id: `h${index + 1}`, split: 'holdout',
    category: index < 4 ? 'single-positive' : index < 7 ? 'multi-positive' : index < 10 ? 'negative' : 'fault',
    transport: ['path', 'header', 'nested', 'post'][index % 4],
    ...(index < 7 ? { vulnerable: true, ...(index >= 4 ? { flow: ['cookie', 'ticket', 'realm'][index - 4] } : {}) }
      : index < 10 ? { vulnerable: false, behavior: ['reflection', 'secured', 'similar-page'][index - 7] }
      : { vulnerable: false, fault: ['disconnect', 'unhealthy'][index - 10] }) })),
];
export const CASES = Object.freeze(cases.map(item => Object.freeze(item)));
export function caseById(id) {
  const item = CASES.find(item => item.id === id);
  if (!item) throw new Error(`Unknown benchmark case: ${id}`);
  return item;
}
