// Deterministic effect recipes operate on host executions, never model verdicts.
import { createHash, randomUUID } from 'node:crypto';
import { readExecutionReceipt, executionMethodBasis, requireFreshExecutions } from './execution-receipts.js';
import { readTaskContext } from './task-context.js';
import { readInteractionRecord } from './server-side-access.js';
import { readBrowserReceipt } from './browser-execution.js';
export const EFFECT_VERIFICATION_SCHEMA = `CREATE TABLE IF NOT EXISTS effect_verifications (
 session_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(session_id,id)
);`;
const fail = message => { throw new Error(message); };
function pointer(value, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 200) fail('bounded JSON pointer required in reviewed effect specification');
  for (const segment of path.slice(1).split('/').map(item => item.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, segment) || ['__proto__', 'constructor', 'prototype'].includes(segment)) fail('required effect field missing');
    value = value[segment];
  }
  return value;
}
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
function transportIdentity(receipt) {
  const values = [...receipt.request.matchAll(/^(authorization|cookie):\s*([^\r\n]+)$/gim)].map(match => [match[1].toLowerCase(), match[2].trim()]).sort();
  return values.length ? createHash('sha256').update(JSON.stringify(values)).digest('hex') : '';
}
function resourceRequest(receipt) {
  const [head, ...body] = receipt.request.split('\r\n\r\n');
  const [line, ...headers] = head.split('\r\n');
  if (!line.startsWith('GET ')) fail('protected read recipe requires GET executions');
  return JSON.stringify([line, headers.filter(header => !/^(authorization|cookie|connection|content-length):/i.test(header)).sort(), body.join('\r\n\r\n')]);
}
function fields(receipt, spec) {
  if (receipt.status < 200 || receipt.status >= 300) fail('normal owner or subject execution failed');
  if (!/^content-type:\s*application\/(?:[\w.+-]*\+)?json\b/im.test(receipt.responseHead)) fail('effect recipe requires JSON responses, not an HTML status page');
  let value;
  try { value = JSON.parse(Buffer.from(receipt.responseBodyBase64, 'base64').toString()); } catch { fail('invalid JSON effect response'); }
  const result = Object.fromEntries(['resourceId', 'ownerId', 'viewerId', 'visibility', 'readers', 'marker'].map(key => [key, pointer(value, spec[key + 'Path'])]));
  if (!identifier(result.resourceId) || !identifier(result.ownerId) || !identifier(result.viewerId) || result.visibility !== 'private'
    || !Array.isArray(result.readers) || result.readers.length > 100 || !result.readers.every(identifier)
    || !result.readers.includes(result.ownerId)) fail('observed object does not satisfy the reviewed private-owner ACL contract');
  if (typeof result.marker !== 'string' || !/^[A-Za-z0-9_-]{24,256}$/.test(result.marker)) fail('opaque owner response marker required');
  if ([result.resourceId, result.ownerId].includes(result.marker)) fail('public identifiers cannot be the private marker');
  return result;
}
function reviewedMethod(store, sessionId, input) {
  return readTaskContext(store, sessionId)?.methods.find(row => row.id === input.methodId && row.version === input.methodVersion && row.reviewed === true);
}
function evaluatePrivateRead(store, sessionId, input, referenceTime = Date.now(), singleRound = false) {
  if (!Number.isFinite(referenceTime)) fail('invalid verification timestamp');
  const method = reviewedMethod(store, sessionId, input);
  if (!method || method.effectSpec?.kind !== 'private-json-read/v1') fail('current reviewed private JSON read specification required');
  if (!Array.isArray(input.rounds) || input.rounds.length !== (singleRound ? 1 : 2)) fail('independently executed effect rounds required');
  const keys = ['owner', 'normal', 'probe', 'denied'];
  const ids = input.rounds.flatMap(round => keys.map(key => round[key]));
  if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== (singleRound ? 4 : 8)) fail('distinct host execution receipts required');
  const rounds = input.rounds.map(round => Object.fromEntries(keys.map(key => [key, readExecutionReceipt(store, sessionId, round[key])])));
  const methodBasis = executionMethodBasis(method);
  const comparisons = [], valueDigest = value => createHash('sha256').update(String(value)).digest('hex');
  let identity, ownerIdentity, protectedObject, subjectObject, credential, ownerCredential;
  for (const round of rounds) {
    requireFreshExecutions(Object.values(round), referenceTime);
    for (const receipt of Object.values(round)) {
      if (!receipt.current || receipt.source !== 'host-http-execution' || receipt.outcome !== 'response'
        || receipt.endpoint !== method.endpoint || receipt.methodId !== method.id || receipt.methodVersion !== method.version
        || receipt.methodBasis !== methodBasis) fail('当前执行证据与请求、身份、目标实例或方法不匹配，或缺少完整响应；请重新采集当前条件下的完整对照。');
    }
    const owner = fields(round.owner, method.effectSpec), normal = fields(round.normal, method.effectSpec), probe = fields(round.probe, method.effectSpec);
    const subjectAuth = transportIdentity(round.normal), probeAuth = transportIdentity(round.probe), ownerAuth = transportIdentity(round.owner);
    if (!subjectAuth || !ownerAuth || subjectAuth !== probeAuth || subjectAuth === ownerAuth || transportIdentity(round.denied)) fail('distinct owner/subject credentials and an anonymous denial control required');
    if (round.normal.authContext !== round.probe.authContext || round.owner.authContext === round.normal.authContext
      || round.normal.hypothesisId !== round.probe.hypothesisId) fail('effect identities and direction bindings differ');
    if (owner.viewerId !== owner.ownerId || normal.viewerId !== normal.ownerId || probe.viewerId !== normal.viewerId
      || owner.ownerId === normal.ownerId || owner.resourceId === normal.resourceId || owner.readers.includes(normal.ownerId)
      || probe.ownerId !== owner.ownerId || probe.resourceId !== owner.resourceId || probe.marker !== owner.marker
      || JSON.stringify([...probe.readers].sort()) !== JSON.stringify([...owner.readers].sort()) || normal.marker === owner.marker) fail('protected owner object was not independently disclosed to an excluded subject');
    if (![401, 403, 404].includes(round.denied.status) || Buffer.from(round.denied.responseBodyBase64, 'base64').toString().includes(owner.marker)) fail('anonymous control did not deny the protected object');
    if (resourceRequest(round.owner) !== resourceRequest(round.probe) || resourceRequest(round.owner) !== resourceRequest(round.denied)) fail('owner probe and denial must address the same protected resource');
    if (Object.values(round).some(receipt => receipt.request.includes(owner.marker) || receipt.request.includes(encodeURIComponent(owner.marker)))) fail('request reflection cannot prove a private object disclosure');
    if (identity !== undefined && (identity !== round.normal.authContext || ownerIdentity !== round.owner.authContext
      || protectedObject !== owner.resourceId || subjectObject !== normal.resourceId || credential !== subjectAuth || ownerCredential !== ownerAuth)) fail('repeat changed identities credentials or protected resource');
    identity = round.normal.authContext; ownerIdentity = round.owner.authContext;
    protectedObject = owner.resourceId; subjectObject = normal.resourceId; credential = subjectAuth; ownerCredential = ownerAuth;
    comparisons.push({ ownerStatus: round.owner.status, normalStatus: round.normal.status, probeStatus: round.probe.status, deniedStatus: round.denied.status,
      ownerMarkerSha256: valueDigest(owner.marker), probeMarkerSha256: valueDigest(probe.marker), normalMarkerSha256: valueDigest(normal.marker),
      ownerViewerSha256: valueDigest(owner.viewerId), normalViewerSha256: valueDigest(normal.viewerId), probeViewerSha256: valueDigest(probe.viewerId),
      protectedResourceSha256: valueDigest(owner.resourceId), normalResourceSha256: valueDigest(normal.resourceId),
      privateAclExcludesSubject: true, requestReflectionExcluded: true });
  }
  return { verified: true, kind: 'private-json-read/v1', proofKind: 'access', endpoint: method.endpoint, identity,
    methodId: method.id, methodVersion: method.version, methodBasis, receiptIds: ids,
    controlReceiptId: input.rounds.at(-1).normal, probeReceiptId: input.rounds.at(-1).probe, comparisons,
    evidenceLimit: 'Validates the reviewed private-owner/readers JSON contract at the recorded execution time; does not infer unknown ACL semantics, live credential health or RCE.' };
}
// 文件读取/路径（v6 第 9.1 节）：实际文件内容 + 正常路径对照 + 越界边界。
// 阴性（一律不接受）：不存在路径、通用错误页、只在响应里回显请求路径而没有实际内容。
// 稳定事实一次有效观察即纳入——文件内容不涉及缓存/竞态，不像访问类那样需要两轮。
function requestTarget(receipt) {
  const match = /^[A-Z]+\s+(\S+)\s+HTTP\//.exec(String(receipt.request || ''));
  return match ? match[1] : '';
}
function evaluatePathRead(store, sessionId, input, referenceTime = Date.now()) {
  if (!Number.isFinite(referenceTime)) fail('invalid verification timestamp');
  const method = reviewedMethod(store, sessionId, input);
  if (!method || method.effectSpec?.kind !== 'path-read-disclosure/v1') fail('current reviewed path-read specification required');
  const spec = method.effectSpec;
  if (!/^[A-Za-z0-9_-]{24,256}$/.test(String(spec.marker || ''))) fail('opaque file marker required in the reviewed specification');
  // 宿主要求记录请求落在方法端点的同一 path，所以"越界"用**已复核的正常请求目标**对比表达
  // （同一个读文件入口，正常参数 vs 越界参数），而不是拿两个不同 path 冒充。
  if (!identifier(spec.normalTarget) || !String(spec.normalTarget).startsWith('/')) fail('reviewed normal request target required');
  if (!Array.isArray(input.rounds) || input.rounds.length !== 1) fail('exactly one executed read round required');
  const round = input.rounds[0] || {};
  const ids = [round.normal, round.probe];
  if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== 2) fail('distinct normal and probe receipts required');
  const normal = readExecutionReceipt(store, sessionId, round.normal), probe = readExecutionReceipt(store, sessionId, round.probe);
  const methodBasis = executionMethodBasis(method);
  requireFreshExecutions([normal, probe], referenceTime);
  for (const receipt of [normal, probe]) {
    if (!receipt.current || receipt.source !== 'host-http-execution' || receipt.outcome !== 'response'
      || receipt.endpoint !== method.endpoint || receipt.methodId !== method.id || receipt.methodVersion !== method.version
      || receipt.methodBasis !== methodBasis) fail('当前执行证据与请求、身份、目标实例或方法不匹配，或缺少完整响应；请重新采集当前条件下的完整对照。');
    if (!['GET', 'HEAD'].includes(String(receipt.request || '').split(' ')[0])) fail('file read recipe requires GET or HEAD executions');
  }
  if (normal.status < 200 || normal.status >= 300) fail('normal path did not return its expected content');
  if (probe.status < 200 || probe.status >= 300) fail('out-of-bounds path did not return file content');
  if (requestTarget(normal) !== spec.normalTarget) fail('normal receipt must use the reviewed normal request target');
  if (requestTarget(probe) === spec.normalTarget) fail('probe must use a different out-of-bounds request target');
  const body = receipt => Buffer.from(receipt.responseBodyBase64 || '', 'base64').toString('utf8');
  const normalBody = body(normal), probeBody = body(probe);
  if (!probeBody.includes(spec.marker)) fail('probe response does not contain the reviewed file marker');
  if (normalBody.includes(spec.marker)) fail('normal path already exposes the marker; no out-of-bounds read shown');
  if (String(probe.request).includes(spec.marker) || String(normal.request).includes(spec.marker)) fail('request reflection cannot prove a file read');
  if (probeBody.trim() === normalBody.trim()) fail('probe returned the same page as the normal path; a generic error page cannot prove a file read');
  if (probeBody.length < spec.marker.length * 2) fail('generic error page cannot prove file content');
  return { verified: true, kind: 'path-read-disclosure/v1', proofKind: 'other-impact', endpoint: method.endpoint,
    methodId: method.id, methodVersion: method.version, methodBasis, receiptIds: ids,
    controlReceiptId: round.normal, probeReceiptId: round.probe,
    comparisons: [{ normalStatus: normal.status, probeStatus: probe.status, normalTarget: requestTarget(normal), probeTarget: requestTarget(probe),
      markerSha256: createHash('sha256').update(String(spec.marker)).digest('hex'), requestReflectionExcluded: true, genericErrorExcluded: true }],
    evidenceLimit: 'Shows the reviewed out-of-bounds path returned file content containing the reviewed marker at the recorded execution time; does not infer wider filesystem reach or other paths.' };
}

// 状态变更/业务（v6 第 9.1 节）：操作前后状态、前提、可控输入、实际影响。
// 关键点：影响必须由**另一次独立读回**证明，动作自己的响应不算数（那是自报）。
// 阴性（一律不接受）：响应成功但状态未变、动作响应里的回显、GET 冒充写操作、
// 读回请求自带 marker（回显）、状态字段不是字符串（无法逐字对照）。
function evaluateStateChange(store, sessionId, input, referenceTime = Date.now()) {
  if (!Number.isFinite(referenceTime)) fail('invalid verification timestamp');
  const method = reviewedMethod(store, sessionId, input);
  if (!method || method.effectSpec?.kind !== 'state-change-impact/v1') fail('current reviewed state-change specification required');
  const spec = method.effectSpec;
  if (!/^[A-Za-z0-9_-]{24,256}$/.test(String(spec.marker || ''))) fail('opaque controlled marker required in the reviewed specification');
  if (typeof spec.statePath !== 'string' || !spec.statePath.startsWith('/') || spec.statePath.length > 200) fail('reviewed state JSON pointer required');
  if (!Array.isArray(input.rounds) || input.rounds.length !== 1) fail('exactly one executed state-change round required');
  const round = input.rounds[0] || {};
  const ids = [round.before, round.action, round.after];
  if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== 3) fail('distinct before action and after receipts required');
  const before = readExecutionReceipt(store, sessionId, round.before);
  const action = readExecutionReceipt(store, sessionId, round.action);
  const after = readExecutionReceipt(store, sessionId, round.after);
  const methodBasis = executionMethodBasis(method);
  requireFreshExecutions([before, action, after], referenceTime);
  for (const receipt of [before, action, after]) {
    if (!receipt.current || receipt.source !== 'host-http-execution' || receipt.outcome !== 'response'
      || receipt.endpoint !== method.endpoint || receipt.methodId !== method.id || receipt.methodVersion !== method.version
      || receipt.methodBasis !== methodBasis) fail('当前执行证据与请求、身份、目标实例或方法不匹配，或缺少完整响应；请重新采集当前条件下的完整对照。');
  }
  const methodOf = receipt => String(receipt.request || '').split(' ')[0].toUpperCase();
  if (['GET', 'HEAD'].includes(methodOf(action))) fail('state change requires a write execution, not a read');
  if (methodOf(before) !== 'GET' || methodOf(after) !== 'GET') fail('state readbacks must be GET executions');
  if (before.status < 200 || before.status >= 300 || after.status < 200 || after.status >= 300) fail('state readbacks must return the current state');
  const stateOf = receipt => {
    let value;
    try { value = JSON.parse(Buffer.from(receipt.responseBodyBase64, 'base64').toString()); } catch { fail('invalid state response JSON'); }
    return pointer(value, spec.statePath);
  };
  const beforeState = stateOf(before), afterState = stateOf(after);
  if (typeof beforeState !== 'string' || typeof afterState !== 'string') fail('reviewed state field must be a string');
  if (!String(action.request).includes(spec.marker)) fail('write execution must carry the reviewed controlled marker');
  if (String(before.request).includes(spec.marker) || String(after.request).includes(spec.marker)) fail('request reflection cannot prove a state change');
  if (beforeState.includes(spec.marker)) fail('before state already contained the marker; no attributable change');
  if (beforeState === afterState) fail('state did not change after the controlled write');
  if (!afterState.includes(spec.marker)) fail('independent readback does not show the controlled marker in the changed state');
  const digest = value => createHash('sha256').update(String(value)).digest('hex');
  return { verified: true, kind: 'state-change-impact/v1', proofKind: 'write', endpoint: method.endpoint, identity: action.authContext,
    methodId: method.id, methodVersion: method.version, methodBasis, receiptIds: ids,
    controlReceiptId: round.before, probeReceiptId: round.action, readbackReceiptId: round.after,
    comparisons: [{ beforeStatus: before.status, actionStatus: action.status, afterStatus: after.status, actionMethod: methodOf(action),
      beforeStateSha256: digest(beforeState), afterStateSha256: digest(afterState), markerSha256: digest(spec.marker),
      stateChanged: true, independentReadback: true, requestReflectionExcluded: true }],
    evidenceLimit: 'Shows the reviewed state field changed after a write carrying the reviewed marker, observed by an independent GET readback at the recorded time; does not judge whether the change was authorized (Desktop impact review) or infer effects beyond the reviewed field.' };
}

// Nday 适用性（v6 第 9.1 / 10.1 节）：只确认「产品、版本（与部署条件）对应原文」，
// **适用性不是漏洞已验证**——配方固定 proofKind='fingerprint'，交付门禁（delivery.js）
// 明确拒绝 fingerprint 充当影响证据，实际影响必须另行核对。
// 阴性（一律不接受）：响应里没有版本原文、未知版本、只有扫描器标签、版本来自请求回显。
function evaluateNdayApplicability(store, sessionId, input, referenceTime = Date.now()) {
  if (!Number.isFinite(referenceTime)) fail('invalid verification timestamp');
  const method = reviewedMethod(store, sessionId, input);
  if (!method || method.effectSpec?.kind !== 'nday-applicability/v1') fail('current reviewed Nday applicability specification required');
  const spec = method.effectSpec;
  if (!identifier(spec.product)) fail('reviewed product name required');
  if (typeof spec.versionPattern !== 'string' || !spec.versionPattern || spec.versionPattern.length > 200) fail('reviewed version pattern required');
  let versionPattern;
  try { versionPattern = new RegExp(spec.versionPattern); } catch { fail('invalid reviewed version pattern'); }
  let deploymentPattern = null;
  if (spec.deploymentPattern !== undefined) {
    if (typeof spec.deploymentPattern !== 'string' || !spec.deploymentPattern || spec.deploymentPattern.length > 200) fail('invalid reviewed deployment pattern');
    try { deploymentPattern = new RegExp(spec.deploymentPattern); } catch { fail('invalid reviewed deployment pattern'); }
  }
  if (!Array.isArray(input.rounds) || input.rounds.length !== 1) fail('exactly one executed fingerprint round required');
  const round = input.rounds[0] || {};
  if (typeof round.fingerprint !== 'string') fail('one fingerprint receipt required');
  const receipt = readExecutionReceipt(store, sessionId, round.fingerprint);
  const methodBasis = executionMethodBasis(method);
  requireFreshExecutions([receipt], referenceTime);
  if (!receipt.current || receipt.source !== 'host-http-execution' || receipt.outcome !== 'response'
    || receipt.endpoint !== method.endpoint || receipt.methodId !== method.id || receipt.methodVersion !== method.version
    || receipt.methodBasis !== methodBasis) fail('当前执行证据与请求、身份、目标实例或方法不匹配，或缺少完整响应；请重新采集当前条件下的完整对照。');
  if (receipt.status < 200 || receipt.status >= 300) fail('fingerprint response did not return the product surface');
  const body = Buffer.from(receipt.responseBodyBase64 || '', 'base64').toString('utf8');
  if (!body.toLowerCase().includes(String(spec.product).toLowerCase())) fail('response does not contain the reviewed product text');
  const match = versionPattern.exec(body);
  if (!match) fail('response does not contain the reviewed version evidence; unknown versions stay separate');
  const version = String(match[1] ?? match[0]).slice(0, 120);
  if (String(receipt.request).includes(version)) fail('request reflection cannot prove product applicability');
  const deploymentMatch = deploymentPattern ? deploymentPattern.exec(body) : null;
  if (deploymentPattern && !deploymentMatch) fail('response does not contain the reviewed deployment condition text');
  const digest = value => createHash('sha256').update(String(value)).digest('hex');
  return { verified: true, kind: 'nday-applicability/v1', proofKind: 'fingerprint', endpoint: method.endpoint, identity: receipt.authContext,
    methodId: method.id, methodVersion: method.version, methodBasis, receiptIds: [round.fingerprint], controlReceiptId: round.fingerprint,
    comparisons: [{ product: String(spec.product).slice(0, 120), version, versionSha256: digest(version), status: receipt.status,
      deploymentMatched: deploymentPattern ? true : null, requestReflectionExcluded: true }],
    evidenceLimit: 'Confirms the reviewed product/version text appeared in a real response at the recorded time. Applicability is NOT a verified vulnerability and cannot satisfy the impact delivery gate (proofKind=fingerprint); actual impact and deployment conditions must be established separately.' };
}

// 泄露/配置（v6 第 9.1 节）：实际非公开内容 + 访问条件 + 原始来源。
// 关键点：同一入口「带复核身份凭据」与「完全匿名」拿到的是**同一份**含受控 marker 的内容，
// 才说明非公开内容确实没有访问控制。marker 由复核规格声明为放在非公开配置里（与文件读取、
// 状态变更同一信任模型：配方证明"匿名也拿到了"，不证明 marker 的来源本身非公开）。
// 阴性（一律不接受）：扫描器标签（没有原文）、匿名拿到的是通用错误页/不同内容、
// 历史截屏（不是宿主回执）、请求回显、参考回执根本没带身份凭据（那就只是公开内容）。
function evaluateConfigDisclosure(store, sessionId, input, referenceTime = Date.now()) {
  if (!Number.isFinite(referenceTime)) fail('invalid verification timestamp');
  const method = reviewedMethod(store, sessionId, input);
  if (!method || method.effectSpec?.kind !== 'config-disclosure/v1') fail('current reviewed config disclosure specification required');
  const spec = method.effectSpec;
  if (!/^[A-Za-z0-9_-]{24,256}$/.test(String(spec.marker || ''))) fail('opaque controlled marker required in the reviewed specification');
  if (!Array.isArray(input.rounds) || input.rounds.length !== 1) fail('exactly one executed disclosure round required');
  const round = input.rounds[0] || {};
  const ids = [round.reference, round.anonymous];
  if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== 2) fail('distinct reference and anonymous receipts required');
  const reference = readExecutionReceipt(store, sessionId, round.reference);
  const anonymous = readExecutionReceipt(store, sessionId, round.anonymous);
  const methodBasis = executionMethodBasis(method);
  requireFreshExecutions([reference, anonymous], referenceTime);
  for (const receipt of [reference, anonymous]) {
    if (!receipt.current || receipt.source !== 'host-http-execution' || receipt.outcome !== 'response'
      || receipt.endpoint !== method.endpoint || receipt.methodId !== method.id || receipt.methodVersion !== method.version
      || receipt.methodBasis !== methodBasis) fail('当前执行证据与请求、身份、目标实例或方法不匹配，或缺少完整响应；请重新采集当前条件下的完整对照。');
    if (String(receipt.request || '').split(' ')[0].toUpperCase() !== 'GET') fail('config disclosure recipe requires GET executions');
  }
  if (reference.status < 200 || reference.status >= 300) fail('reviewed identity reference did not return the configuration content');
  if (anonymous.status < 200 || anonymous.status >= 300) fail('anonymous request did not return the exposed content');
  if (!transportIdentity(reference)) fail('reference receipt must carry the reviewed identity credentials; public content is not a disclosure');
  if (transportIdentity(anonymous)) fail('anonymous control must not carry credentials');
  const body = receipt => Buffer.from(receipt.responseBodyBase64 || '', 'base64').toString('utf8');
  const referenceBody = body(reference), anonymousBody = body(anonymous);
  if (String(reference.request).includes(spec.marker) || String(anonymous.request).includes(spec.marker)) fail('request reflection cannot prove a configuration disclosure');
  if (!referenceBody.includes(spec.marker)) fail('reviewed identity reference does not contain the controlled marker');
  if (!anonymousBody.includes(spec.marker)) fail('anonymous response does not contain the controlled marker');
  if (referenceBody !== anonymousBody) fail('anonymous response differs from the reviewed identity content; a public page or error page is not a disclosure');
  if (anonymousBody.length < spec.marker.length * 2) fail('response too small to be configuration content');
  const digest = value => createHash('sha256').update(String(value)).digest('hex');
  return { verified: true, kind: 'config-disclosure/v1', proofKind: 'other-impact', endpoint: method.endpoint, identity: reference.authContext,
    methodId: method.id, methodVersion: method.version, methodBasis, receiptIds: ids,
    controlReceiptId: round.reference, probeReceiptId: round.anonymous,
    comparisons: [{ referenceStatus: reference.status, anonymousStatus: anonymous.status,
      markerSha256: digest(spec.marker), contentSha256: digest(anonymousBody), identicalContent: true,
      credentialsRequiredForReference: true, anonymousCredentials: false, requestReflectionExcluded: true, publicPageExcluded: true }],
    evidenceLimit: 'Shows the same reviewed configuration content, containing the reviewed marker, was served to the reviewed identity and to a credential-free request at the recorded time. The marker must be planted in a non-public configuration by the operator; this recipe does not prove the marker origin is non-public, nor does it enumerate other leaked fields.' };
}

// 输入处理（v6 第 9.1 节）：输入到处理路径的依据 + 可归因影响 + 必要对照。
// 关键点：受控输入必须在响应里以**被处理过的形态**出现（复核规格给出 processedPattern），
// 对照请求（同一个入口、同一个身份、只差这一个输入值）拿不到这个形态——
// 这样"差异由输入引起"和"输入确实进了处理路径"同时成立。
// 阴性（一律不接受）：普通报错/非 2xx、参数被忽略（两次一样）、原始回显（处理形态本身出现在请求里）、
// 对照请求还改了别的参数（差异无法归因）、偶发延迟或未知异常。
function normalizeControlledRequest(request, value) {
  return String(request || '')
    .replace(/\r\ncontent-length:[^\r\n]*/gi, '')
    .split(value).join('<input>');
}
function evaluateInputProcessing(store, sessionId, input, referenceTime = Date.now()) {
  if (!Number.isFinite(referenceTime)) fail('invalid verification timestamp');
  const method = reviewedMethod(store, sessionId, input);
  if (!method || method.effectSpec?.kind !== 'input-processing/v1') fail('current reviewed input processing specification required');
  const spec = method.effectSpec;
  if (!identifier(spec.marker) || String(spec.marker).length < 4) fail('reviewed controlled input value required');
  if (!identifier(spec.controlValue)) fail('reviewed benign control value required');
  if (String(spec.controlValue) === String(spec.marker)) fail('control value must differ from the controlled input');
  if (!identifier(spec.processedValue)) fail('reviewed processed value required');
  if (!Array.isArray(input.rounds) || input.rounds.length !== 1) fail('exactly one executed input processing round required');
  const round = input.rounds[0] || {};
  const ids = [round.control, round.probe];
  if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== 2) fail('distinct control and probe receipts required');
  const control = readExecutionReceipt(store, sessionId, round.control);
  const probe = readExecutionReceipt(store, sessionId, round.probe);
  const methodBasis = executionMethodBasis(method);
  requireFreshExecutions([control, probe], referenceTime);
  for (const receipt of [control, probe]) {
    if (!receipt.current || receipt.source !== 'host-http-execution' || receipt.outcome !== 'response'
      || receipt.endpoint !== method.endpoint || receipt.methodId !== method.id || receipt.methodVersion !== method.version
      || receipt.methodBasis !== methodBasis) fail('当前执行证据与请求、身份、目标实例或方法不匹配，或缺少完整响应；请重新采集当前条件下的完整对照。');
  }
  if (control.status < 200 || control.status >= 300) fail('control execution did not complete normally; a plain error is not input processing');
  if (probe.status < 200 || probe.status >= 300) fail('probe execution did not complete normally; a plain error is not input processing');
  if (!transportIdentity(control) || transportIdentity(control) !== transportIdentity(probe)) fail('control and probe must use the same reviewed identity');
  if (control.authContext !== probe.authContext || control.hypothesisId !== probe.hypothesisId) fail('control and probe direction bindings differ');
  if (!String(probe.request).includes(spec.marker)) fail('probe execution must carry the reviewed controlled input');
  if (String(control.request).includes(spec.marker)) fail('control execution must not carry the reviewed controlled input');
  if (!String(control.request).includes(spec.controlValue)) fail('control execution must carry the reviewed benign control value');
  if (normalizeControlledRequest(control.request, spec.controlValue) !== normalizeControlledRequest(probe.request, spec.marker)) fail('control and probe must differ only in the reviewed input value');
  const body = receipt => Buffer.from(receipt.responseBodyBase64 || '', 'base64').toString('utf8');
  const controlBody = body(control), probeBody = body(probe);
  if (controlBody === probeBody) fail('responses are identical; an ignored parameter is not input processing');
  if (!probeBody.includes(spec.processedValue)) fail('probe response does not contain the reviewed processed value');
  if (controlBody.includes(spec.processedValue)) fail('control response also contains the processed value; the difference is not attributable to the input');
  if (String(probe.request).includes(spec.processedValue) || String(control.request).includes(spec.processedValue)) fail('request reflection cannot prove input processing');
  const processedText = String(spec.processedValue).slice(0, 120);
  const digest = value => createHash('sha256').update(String(value)).digest('hex');
  return { verified: true, kind: 'input-processing/v1', proofKind: 'other-impact', endpoint: method.endpoint, identity: probe.authContext,
    methodId: method.id, methodVersion: method.version, methodBasis, receiptIds: ids,
    controlReceiptId: round.control, probeReceiptId: round.probe,
    comparisons: [{ controlStatus: control.status, probeStatus: probe.status, controlBodySha256: digest(controlBody), probeBodySha256: digest(probeBody),
      processedSha256: digest(processedText), singleInputDifference: true, ignoredParameterExcluded: true, requestReflectionExcluded: true,
      plainErrorExcluded: true }],
    evidenceLimit: 'Shows one reviewed input value reached a processing path: the probe response contains the reviewed processed form and the control (same entry, identity and request except that value) does not. It does not infer other inputs, wider injection classes or impact beyond the reviewed processing form.' };
}

// 服务端访问（v6 第 9.1 节）：服务端发起访问的可验证记录、目标与结果。
// 记录只能来自宿主回查 DNSLog 平台的命中（interaction_records，source=host-dnslog-query）——
// 模型自报"有回连"不算；触发请求必须携带复核过的回调域名；命中必须发生在触发之后（因果成立）。
// 阴性（一律不接受）：只有客户端访问、单一报错、没有对应服务端记录、记录早于触发请求、域名对不上。
function evaluateServerSideAccess(store, sessionId, input, referenceTime = Date.now()) {
  if (!Number.isFinite(referenceTime)) fail('invalid verification timestamp');
  const method = reviewedMethod(store, sessionId, input);
  if (!method || method.effectSpec?.kind !== 'server-side-access/v1') fail('current reviewed server-side access specification required');
  const spec = method.effectSpec;
  if (!/^[a-z0-9][a-z0-9.-]{3,200}$/i.test(String(spec.callbackHost || ''))) fail('reviewed callback host required');
  if (!Array.isArray(input.rounds) || input.rounds.length !== 1) fail('exactly one executed server-side access round required');
  const round = input.rounds[0] || {};
  if (typeof round.trigger !== 'string' || typeof round.interaction !== 'string') fail('trigger receipt and host-recorded interaction required');
  const trigger = readExecutionReceipt(store, sessionId, round.trigger);
  const interaction = readInteractionRecord(store, sessionId, round.interaction);
  const methodBasis = executionMethodBasis(method);
  requireFreshExecutions([trigger], referenceTime);
  if (!trigger.current || trigger.source !== 'host-http-execution' || !['response', 'timeout', 'transport-error'].includes(trigger.outcome)
    || trigger.endpoint !== method.endpoint || trigger.methodId !== method.id || trigger.methodVersion !== method.version
    || trigger.methodBasis !== methodBasis) fail('服务端访问效果需要当前仍匹配、内容完整的受审方法执行回执');
  if (!String(trigger.request).includes(spec.callbackHost)) fail('trigger execution must carry the reviewed callback host');
  if (interaction.source !== 'host-dnslog-query') fail('host-recorded DNSLog interaction required');
  if (String(interaction.host) !== String(spec.callbackHost)) fail('interaction host does not match the reviewed callback host');
  if (!Array.isArray(interaction.rows) || !interaction.rows.length) fail('no server-side callback recorded for the reviewed host');
  const queriedAt = Date.parse(String(interaction.queriedAt));
  const startedAt = Date.parse(String(trigger.startedAt));
  if (!Number.isFinite(queriedAt) || !Number.isFinite(startedAt) || queriedAt < startedAt) fail('interaction record predates the trigger request; causality not shown');
  if (interaction.lastSeen && Date.parse(String(interaction.lastSeen)) < startedAt) fail('recorded callbacks all predate the trigger request');
  const digest = value => createHash('sha256').update(String(value)).digest('hex');
  return { verified: true, kind: 'server-side-access/v1', proofKind: 'interaction', endpoint: method.endpoint, identity: trigger.authContext,
    methodId: method.id, methodVersion: method.version, methodBasis, receiptIds: [round.trigger],
    controlReceiptId: round.trigger, interactionId: interaction.id,
    comparisons: [{ triggerStatus: trigger.status ?? null, triggerOutcome: trigger.outcome, callbackHost: String(spec.callbackHost),
      callbackHostSha256: digest(spec.callbackHost), interactionRows: interaction.rowCount,
      interactionSource: interaction.source, interactionQueriedAt: interaction.queriedAt, firstSeen: interaction.firstSeen, lastSeen: interaction.lastSeen,
      causallyAfterTrigger: true, hostRecordedQuery: true }],
    evidenceLimit: 'Shows the reviewed callback host received a request from the target side after the reviewed trigger was sent. A callback proves the payload was processed and made an outbound connection; it is NOT a verified impact, permission or code execution, and interaction proof cannot satisfy the impact delivery gate.' };
}

// 浏览器执行（v6 第 9.1 节）：当前 origin、实际浏览器行为、输入到 DOM/页面路径、相关防护。
// 证据只认宿主真开浏览器留下的回执（browser_receipts，source=host-browser-execution）：
// 载荷必须真的把 window.__sakerProbe 设成复核 marker，且 origin 与复核入口一致、不是 file:。
// 阴性（一律不接受）：仅回显文本、被转义、CSP 拦下（probe 没被设置）、本地 file 环境成立、
// 回执 origin 与入口对不上、没有浏览器回执。
function evaluateBrowserExecution(store, sessionId, input, referenceTime = Date.now()) {
  if (!Number.isFinite(referenceTime)) fail('invalid verification timestamp');
  const method = reviewedMethod(store, sessionId, input);
  if (!method || method.effectSpec?.kind !== 'browser-execution/v1') fail('current reviewed browser execution specification required');
  const spec = method.effectSpec;
  if (!/^[A-Za-z0-9_-]{6,200}$/.test(String(spec.marker || ''))) fail('reviewed probe marker required');
  if (!Array.isArray(input.rounds) || input.rounds.length !== 1) fail('exactly one executed browser round required');
  const round = input.rounds[0] || {};
  if (typeof round.trigger !== 'string' || typeof round.browser !== 'string') fail('trigger receipt and host browser receipt required');
  const trigger = readExecutionReceipt(store, sessionId, round.trigger);
  const browser = readBrowserReceipt(store, sessionId, round.browser);
  const methodBasis = executionMethodBasis(method);
  requireFreshExecutions([trigger], referenceTime);
  if (!trigger.current || trigger.source !== 'host-http-execution' || trigger.outcome !== 'response'
    || trigger.endpoint !== method.endpoint || trigger.methodId !== method.id || trigger.methodVersion !== method.version
    || trigger.methodBasis !== methodBasis) fail('当前执行证据与请求、身份、目标实例或方法不匹配，或缺少完整响应；请重新采集当前条件下的完整对照。');
  if (!String(trigger.request).includes(spec.marker)) fail('trigger execution must carry the reviewed probe marker');
  if (browser.source !== 'host-browser-execution') fail('host browser execution receipt required');
  if (browser.marker !== spec.marker) fail('browser receipt marker does not match the reviewed specification');
  if (browser.executed !== true || browser.probeValue !== spec.marker) fail('payload did not execute in a real browser; reflection, escaping or CSP is not execution');
  let browserOrigin, endpointOrigin;
  try { browserOrigin = new URL(String(browser.origin)); endpointOrigin = new URL(method.endpoint); } catch { fail('invalid browser origin'); }
  if (!['http:', 'https:'].includes(browserOrigin.protocol)) fail('browser execution must happen on a real HTTP(S) origin, not a local file');
  if (browserOrigin.origin !== endpointOrigin.origin) fail('browser origin does not match the reviewed endpoint origin');
  const digest = value => createHash('sha256').update(String(value)).digest('hex');
  return { verified: true, kind: 'browser-execution/v1', proofKind: 'other-impact', endpoint: method.endpoint, identity: trigger.authContext,
    methodId: method.id, methodVersion: method.version, methodBasis, receiptIds: [round.trigger], controlReceiptId: round.trigger,
    browserReceiptId: browser.id,
    comparisons: [{ origin: browserOrigin.origin, originSha256: digest(browserOrigin.origin), engine: browser.engine || '',
      probeVariable: browser.probeVariable || 'window.__sakerProbe', executedInBrowser: true, cspViolations: browser.cspViolations ?? 0,
      dialogs: browser.dialogs ?? 0, reflectionExcluded: true, localFileExcluded: true }],
    evidenceLimit: 'Shows the reviewed payload executed in a real browser on the reviewed HTTP(S) origin under the protections present at that time. It is not permission, persistence or RCE, and it does not prove other browsers or contexts behave the same.' };
}

/** 按 method.effectSpec.kind 选配方：不同问题用不同确认依据（v6 第 9.1 节）。 */
function evaluateEffect(store, sessionId, input, referenceTime = Date.now(), singleRound = false) {
  const kind = reviewedMethod(store, sessionId, input)?.effectSpec?.kind;
  if (kind === 'private-json-read/v1') return evaluatePrivateRead(store, sessionId, input, referenceTime, singleRound);
  if (kind === 'path-read-disclosure/v1') return evaluatePathRead(store, sessionId, input, referenceTime);
  if (kind === 'state-change-impact/v1') return evaluateStateChange(store, sessionId, input, referenceTime);
  if (kind === 'nday-applicability/v1') return evaluateNdayApplicability(store, sessionId, input, referenceTime);
  if (kind === 'config-disclosure/v1') return evaluateConfigDisclosure(store, sessionId, input, referenceTime);
  if (kind === 'input-processing/v1') return evaluateInputProcessing(store, sessionId, input, referenceTime);
  if (kind === 'server-side-access/v1') return evaluateServerSideAccess(store, sessionId, input, referenceTime);
  if (kind === 'browser-execution/v1') return evaluateBrowserExecution(store, sessionId, input, referenceTime);
  fail('current reviewed effect specification required');
}
export function assessPrivateReadRound(store, sessionId, input) {
  try { evaluatePrivateRead(store, sessionId, input, Date.now(), true); return { supported: true }; }
  catch (error) { return { supported: false, reason: error.message }; }
}
export function verifyEffect(store, sessionId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 8192) fail('bounded effect verification document required');
  input = { methodId: input.methodId, methodVersion: input.methodVersion, rounds: input.rounds };
  let verdict;
  const kind = reviewedMethod(store, sessionId, input)?.effectSpec?.kind;
  try { verdict = evaluateEffect(store, sessionId, input); }
  catch (error) { verdict = { verified: false, kind: kind || 'unknown', reason: error.message, outcome: 'inconclusive' }; }
  const record = { id: 'effect-' + randomUUID(), source: 'host-effect-verifier', recordedAt: new Date().toISOString(), input, ...verdict };
  store.db.prepare('INSERT INTO effect_verifications (session_id,id,record) VALUES (?,?,?)').run(sessionId, record.id, JSON.stringify(record));
  return effectSummary(record);
}
export function readEffectVerification(store, sessionId, id) {
  const row = store.db.prepare('SELECT record FROM effect_verifications WHERE session_id=? AND id=?').get(sessionId, id);
  if (!row) fail('effect verification not found in current session');
  const record = JSON.parse(row.record);
  let currentVerdict;
  try { currentVerdict = evaluateEffect(store, sessionId, record.input); }
  catch (error) { currentVerdict = { verified: false, reason: error.message }; }
  return { ...record, current: record.verified === true && currentVerdict.verified === true, currentReason: currentVerdict.reason || record.reason || '' };
}
export function effectSummary(record) {
  const { input, comparisons, ...summary } = record;
  return { ...summary, detail: 'redteam_execution action=effect-detail id=' + record.id };
}
