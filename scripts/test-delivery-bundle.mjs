import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { openStore, registerFinding, updateFinding, getFinding } from '../plugins/dsh-redteam-results/lib/store.js';
import { deliveryMaterialDigest } from '../plugins/dsh-redteam-results/lib/delivery.js';
import { saveChecks } from '../plugins/dsh-redteam-results/lib/checked.js';
import { buildDeliveryFiles, zipDelivery, redactCredentials } from '../plugins/dsh-redteam-results/lib/bundle.js';
let failed = 0;
async function test(name, fn) { try { await fn(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message); } }
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-bundle-'));
process.env.DSH_HOME = home; process.env.DSH_ATLAS_DB = path.join(home, 'unused-atlas.db');
const { apply, dispatch, releaseChainRefs } = await import('../plugins/dsh-redteam-results/lib/index.js');
const store = openStore(path.join(home, 'redteam-results', 'results.db')), disposers = [];
const method = { kind: 'script', mechanism: 'controlled-fixture-impact', methodVersion: 'v1', endpoint: 'https://fixture.test/input',
  prerequisites: ['Authorized fixture identity'], dependencies: ['Python standard library'], parameters: ['Read TEST_IDENTITY from environment'],
  code: 'import os\nprint(os.environ["TEST_IDENTITY"])\n', language: 'python', runCommand: 'python finding-1.py',
  successCriterion: 'Observed fixture execution marker, absent in negative control', reviewSteps: 'Repeat with independent marker and control', recovery: 'Fixture has no persistent effect',
  verification: { status: 'verified', evidenceIds: ['fixture-response'] } };
const input = { title: 'Controlled fixture', severity: 'high', type: 'RCE', target: 'https://fixture.test', evidenceLevel: 'impact', proofKind: 'execution',
  impact: 'Recorded fixture execution', evidence: 'fixture-response', reproduction: JSON.stringify(method),
  requestPkt: 'POST /input?token=query-secret HTTP/1.1\nCookie: sid=cookie-secret\nAuthorization: Bearer auth-secret\n\n{"password":"body-secret"}',
  responsePkt: 'HTTP/1.1 200 OK\nSet-Cookie: sid=response-secret\n\nfixture-marker' };
const review = { status: 'verified', secondRating: 'high', secondRatingNote: 'Independent fixture replay produced the execution marker while the negative control did not.' };
const confirmed = session => { const row = registerFinding(store, session, 'pentest', input); return updateFinding(store, session, 'pentest', row.id, review); };
// Internal verdict fixture tests serialization only, not host execution or impact.
const formatterFixture = row => ({ ...row, executionEvidence: { verified: true, impactVerified: true, binding: deliveryMaterialDigest(row) } });
function zipContents(bytes) {
  const archive = path.join(home, 'verification.zip'); fs.writeFileSync(archive, bytes);
  const command = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive = [System.IO.Compression.ZipFile]::OpenRead($env:SAKER_ARCHIVE); try { $result = @($archive.Entries | ForEach-Object { $stream = $_.Open(); $memory = New-Object System.IO.MemoryStream; try { $stream.CopyTo($memory); @{name=$_.FullName; content=[Convert]::ToBase64String($memory.ToArray())} } finally { $stream.Dispose(); $memory.Dispose() } }); ConvertTo-Json -InputObject $result -Compress } finally { $archive.Dispose() }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, SAKER_ARCHIVE: archive } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return Object.fromEntries(JSON.parse(result.stdout.trim()).map(row => [row.name, Buffer.from(row.content, 'base64').toString('utf8')]));
}
try {
  const stored = confirmed('s1'), row = formatterFixture(stored);
  await test('formatter verdict fixture contains script instructions evidence and three-column checks without attesting execution', () => {
    assert.equal(getFinding(store, 's1', stored.id).delivery.ready, false);
    const bundle = buildDeliveryFiles([row], []);
    assert.equal(bundle.confirmedFindings, 1);
    assert.equal(bundle.files['delivery/repro/finding-1/finding-1.py'], method.code);
    for (const text of [method.endpoint, method.methodVersion, method.successCriterion, method.recovery]) assert(bundle.files['delivery/repro/finding-1.md'].includes(text));
    assert(bundle.files['delivery/evidence/finding-1-response.txt'].includes('fixture-marker'));
    assert.equal(bundle.files['delivery/checked.tsv'], '资产\t检查项\t状态\n');
  });
  await test('shareable bundle redacts common credentials without modifying local evidence', () => {
    const text = Object.values(buildDeliveryFiles([row], []).files).join('\n');
    for (const secret of ['query-secret', 'cookie-secret', 'auth-secret', 'body-secret', 'response-secret']) assert(!text.includes(secret));
    assert(row.requestPkt.includes('cookie-secret'));
    assert(redactCredentials('password=form-secret&x=1').includes('password=[REDACTED]'));
  });
  await test('literal credential scripts are refused while environment inputs remain intact', () => {
    for (const code of ['token = "literal-secret"', 'headers = {"Cookie": "sid=literal-secret"}', 'curl -H "Cookie: sid=literal-secret" https://fixture.test/', 'curl https://u:p@fixture.test/']) {
      assert.throws(() => buildDeliveryFiles([formatterFixture({ ...row, reproduction: JSON.stringify({ ...method, code }) })], []), /literal credential/);
    }
    assert.equal(buildDeliveryFiles([row], []).files['delivery/repro/finding-1/finding-1.py'], method.code);
  });
  await test('saved script filename and execution directory match its command instead of invented names', () => {
    const custom = { ...method, runCommand: 'python actual-script.py --target https://fixture.test/' };
    const files = buildDeliveryFiles([formatterFixture({ ...row, reproduction: JSON.stringify(custom) })], []).files;
    assert.equal(files['delivery/repro/finding-1/actual-script.py'], method.code);
    assert(files['delivery/repro/finding-1.md'].includes('运行目录：repro/finding-1/'));
    for (const patch of [{ runCommand: 'python -c "print(1)"' }, { scriptFilename: '../escape.py' }, { scriptFilename: 'CON.py', runCommand: 'python CON.py' }]) {
      assert.throws(() => buildDeliveryFiles([formatterFixture({ ...row, reproduction: JSON.stringify({ ...method, ...patch }) })], []), /scriptFilename/);
    }
  });
  await test('pending callback and duplicate findings cannot inflate or pollute the effective report', () => {
    const bundle = buildDeliveryFiles([row, { ...row, id: 'duplicate' }, { ...row, id: 'pending', status: 'pending' }, { ...row, id: 'callback', proofKind: 'interaction' }], []);
    assert.equal(bundle.confirmedFindings, 1); assert.equal(bundle.incompleteRecords, 2);
    assert.equal(Object.keys(bundle.files).filter(name => name.endsWith('.py')).length, 1);
  });
  await test('empty findings yield truthful compact delivery and not-run methods keep their status', () => {
    assert(buildDeliveryFiles([], []).files['delivery/findings.md'].includes('本轮未确认有效漏洞'));
    const pending = { ...row, reproduction: JSON.stringify({ ...method, verification: { status: 'not-run', evidenceIds: [] } }) };
    const bundle = buildDeliveryFiles([pending], []);
    assert.equal(bundle.confirmedFindings, 0);
    assert.equal(bundle.incompleteRecords, 1);
    assert(!Object.keys(bundle.files).some(name => name.startsWith('delivery/repro/')));
  });
  await test('standard Windows ZIP reader recovers every bundled UTF8 file byte-for-byte', () => {
    const files = buildDeliveryFiles([row], []).files;
    assert.deepEqual(zipContents(zipDelivery(files)), files);
  });
  await test('archive refuses traversal absolute paths and excessive contents', () => {
    for (const name of ['delivery/../escape', 'C:/escape', 'delivery/a\\b', 'delivery/a:b']) assert.throws(() => zipDelivery({ [name]: 'x' }), /unsafe/);
    assert.throws(() => zipDelivery({ 'delivery/huge': 'x'.repeat(32 * 1024 * 1024 + 1) }), /size limit/);
  });
  await test('bundle endpoint isolates session data and current-session tool writes a usable unique artifact', async () => {
    const check = { assetId: 'a', entryId: 'check', endpoint: method.endpoint, methodVersion: 'v1', authContext: 'fixture', requestRevision: 'r1', status: 'not-tested', evidenceIds: [] };
    saveChecks(store, 's1', [check]);
    const bundle = await dispatch({}, store, 'delivery.bundle', { sessionId: 's1' });
    assert.equal(bundle.confirmedFindings, 0); assert.equal(bundle.checkedCount, 1);
    assert(zipContents(Buffer.from(bundle.archive, 'base64'))['delivery/checked.tsv'].includes('未测'));
    assert.equal((await dispatch({}, store, 'delivery.bundle', { sessionId: 'other' })).confirmedFindings, 0);
    await assert.rejects(dispatch({}, store, 'delivery.bundle', {}), /sessionId/);
    const tools = new Map();
    apply({ tools: { register: tool => tools.set(tool.name, tool) }, effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); }, webServer: { register: () => () => {} } });
    const tool = tools.get('redteam_delivery');
    const exec = { agent: { session: { id: 's1', header: { agentPreset: 'pentest', cwd: pathToFileURL(home).href } } } };
    const first = await tool.execute({}, exec), second = await tool.execute({}, exec);
    assert.equal(first.ok, true, first.error); assert.notEqual(first.path, second.path);
    assert.equal(path.dirname(first.path), fs.realpathSync(home));
    assert.deepEqual(zipContents(fs.readFileSync(first.path)), zipContents(Buffer.from(bundle.archive, 'base64')));
    assert.equal((await tool.execute({}, { agent: { session: { id: 's1', header: { agentPreset: 'pentest' } } } })).ok, false);
    assert.equal((await tool.execute({}, { agent: { session: { id: 's1', header: { agentPreset: 'code-audit', cwd: home } } } })).ok, false);
  });
  await test('browser archive download reconstructs binary bytes before creating the download', () => {
    const source = fs.readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js', import.meta.url), 'utf8');
    const start = source.indexOf('function downloadArchive('), end = source.indexOf('//#region 导出生成器', start);
    let received;
    const context = { atob: value => Buffer.from(value, 'base64').toString('binary'), Uint8Array, download: (...args) => { received = args; } };
    runInNewContext(source.slice(start, end) + '; downloadArchive("fixture.zip", "AAEC//4=");', context);
    assert.equal(received[0], 'fixture.zip'); assert.deepEqual(Buffer.from(received[1]), Buffer.from([0, 1, 2, 255, 254]));
    assert.equal(received[2], 'application/zip');
  });
} finally { for (const dispose of disposers.reverse()) await dispose(); releaseChainRefs(); store.close(); fs.rmSync(home, { recursive: true, force: true }); }
process.exitCode = failed ? 1 : 0;
