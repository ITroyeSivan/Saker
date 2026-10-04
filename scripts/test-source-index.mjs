import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SourceIndex, SOURCE_INDEX_SCHEMA } from '../plugins/dsh-nday-hunter/lib/source-index.js';
import { fetchCisaKev, fetchNvd, fetchGithubAdvisories, fetchOsv } from '../plugins/dsh-nday-hunter/lib/free-sources.js';
import { attachApiDocument } from '../plugins/dsh-nday-hunter/lib/api-source-document.js';
import { compareSemver, assessSourceDocument } from '../plugins/dsh-nday-hunter/lib/source-applicability.js';
import { parseCpe } from '../plugins/dsh-nday-hunter/lib/nvd-applicability.js';
import { fetchSourcePage } from '../plugins/dsh-nday-hunter/lib/source-pages.js';
import { collectorPaths, readCollectorState, readSourceRecord, readSourceHistory, readSourceContent, readSourceApplicability, querySourceCandidates, runCollector } from '../plugins/dsh-nday-hunter/lib/source-pipeline.js';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-index-'));
const now = Date.parse('2026-10-02T00:00:00Z'), sha = value => createHash('sha256').update(value).digest('hex');
const record = (number, source = 'nvd', extra = {}) => ({ source, id: `CVE-2026-${1000 + number}`, ids: [`CVE-2026-${1000 + number}`],
  title: `Product ${number}`, summary: 'Public source metadata', products: ['金蝶', 'ProductA'], status: 'active',
  published: '2026-10-01T00:00:00Z', url: `https://example.invalid/${number}`, ...extra });
const assessNvd = (document, environment) => assessSourceDocument(document, 'nvd-cve-2.0', { assetId: 'fixture-asset', assetEvidenceIds: ['service-binding'], ...environment });
let failures = 0;
async function check(name, fn) { try { await fn(); console.log('ok   ' + name); } catch (error) { failures++; console.log('FAIL ' + name + ': ' + error.stack); } }
function store(home, fn) { const index = new SourceIndex(collectorPaths(home), {}, now); try { return fn(index); } finally { index.close(); } }
try {
  await check('NVD AND OR and environmental conditions retain three-valued eligibility without false vulnerability witnesses', () => {
    const app = 'cpe:2.3:a:acme:portal:1.0.0:*:*:*:*:*:*:*', os = 'cpe:2.3:o:acme:os:10:*:*:*:*:*:*:*';
    const application = { criteria: app, vulnerable: true }, operating = { criteria: os, vulnerable: false };
    const doc = { configurations: [{ operator: 'AND', nodes: [{ operator: 'OR', cpeMatch: [application] }, { operator: 'OR', cpeMatch: [operating] }] }] };
    const environment = cpes => ({ cpes: cpes.map(cpe => ({ cpe, evidenceIds: ['observed-v1'] })), cpeInventoryComplete: true, cpeInventoryEvidenceIds: ['complete-cpe-v1'] });
    assert.equal(assessNvd(doc, environment([app, os])).state, 'satisfied');
    assert.equal(assessNvd(doc, environment([app])).state, 'not-applicable');
    assert.equal(assessNvd(doc, { cpes: [{ cpe: app, evidenceIds: ['observed-v1'] }] }).state, 'unknown');
    doc.configurations[0].operator = 'OR';
    assert.equal(assessNvd(doc, environment([app])).state, 'satisfied');
    assert.equal(assessNvd(doc, environment([os])).state, 'not-applicable');
    assert.equal(assessNvd(doc, { cpes: [{ cpe: os, evidenceIds: ['os-v1'] }] }).state, 'unknown');
    doc.configurations[0].nodes = [{ operator: 'OR', cpeMatch: [operating] }];
    assert.equal(assessNvd(doc, environment([os])).reason, 'no-positive-vulnerable-condition');
  });
  await check('NVD negation and double negation preserve unknowns and never invent configuration operators', () => {
    const app = 'cpe:2.3:a:acme:portal:1.0.0:*:*:*:*:*:*:*', os = 'cpe:2.3:o:acme:os:10:*:*:*:*:*:*:*';
    const doc = { configurations: [{ operator: 'AND', nodes: [
      { operator: 'OR', cpeMatch: [{ criteria: app, vulnerable: true }] },
      { operator: 'OR', negate: true, cpeMatch: [{ criteria: os, vulnerable: false }] }] }] };
    const env = { cpes: [{ cpe: app, evidenceIds: ['app'] }], cpeInventoryComplete: true, cpeInventoryEvidenceIds: ['inventory'] };
    assert.equal(assessNvd(doc, env).state, 'satisfied');
    assert.equal(assessNvd(doc, { ...env, cpeInventoryComplete: false }).state, 'unknown');
    assert.equal(assessNvd(doc, { ...env, cpes: [...env.cpes, { cpe: os, evidenceIds: ['os'] }] }).state, 'not-applicable');
    delete doc.configurations[0].operator; assert.equal(assessNvd(doc, env).state, 'unknown');
    doc.configurations[0] = { negate: true, nodes: [{ operator: 'OR', negate: true, cpeMatch: [{ criteria: app, vulnerable: true }] }] };
    assert.equal(assessNvd(doc, env).state, 'satisfied');
    doc.configurations[0].nodes[0].negate = false; assert.equal(assessNvd(doc, env).state, 'unknown');
    doc.configurations[0].negate = 'false'; assert.equal(assessNvd(doc, env).state, 'unknown');
  });
  await check('CPE matching distinguishes ANY NA escaping and zero-or-one question marks without regex backtracking', () => {
    const make = (product, edition = '*') => `cpe:2.3:a:acme:${product}:1.0.0:*:${edition}:*:*:*:*:*`;
    const assess = (criteria, cpe) => assessNvd({ configurations: [{ nodes: [{ operator: 'OR', cpeMatch: [{ criteria, vulnerable: true }] }] }] },
      { cpes: [{ cpe, evidenceIds: ['binding'] }], cpeInventoryComplete: true, cpeInventoryEvidenceIds: ['inventory'] });
    assert.equal(assess(make('Portal?'), make('portal')).state, 'satisfied');
    assert.equal(assess(make('portal?'), make('portalx')).state, 'satisfied');
    assert.equal(assess(make('portal?'), make('portalxy')).state, 'not-applicable');
    assert.equal(assess(make('portal\\?'), make('portal')).state, 'not-applicable');
    assert.equal(assess(make('portal\\?'), make('portal\\?')).state, 'satisfied');
    assert.equal(assess(make('portal\\:server'), make('portal\\:server')).state, 'satisfied');
    assert.equal(assess(make('portal', '-'), make('portal', '*')).state, 'unknown');
    assert.equal(assess(make('portal', '-'), make('portal', '-')).state, 'satisfied');
    assert.equal(assess(make('portal', '-'), make('portal', '\\-')).state, 'not-applicable');
    assert.equal(assess(make('*'), make('portal*')).state, 'unknown');
    for (const pattern of ['por*tal', '**portal', '*?portal', 'portal*?', 'port al']) assert.equal(parseCpe(make(pattern)), null);
    const begin = Date.now(); assert.equal(assess(make('?'.repeat(1000) + 'z'), make('a'.repeat(1000))).state, 'not-applicable');
    assert(Date.now() - begin < 2000);
    assert.throws(() => assess(make('portal'), 'cpe:/a:acme:portal:1.0.0'), /formatted name/);
  });
  await check('NVD version bounds require a supported evidenced comparator and preserve SemVer case and endpoints', () => {
    const criteria = 'cpe:2.3:a:acme:portal:*:*:*:*:*:*:*:*';
    const match = { criteria, vulnerable: true, versionStartIncluding: '1.0.0', versionEndExcluding: '2.0.0' };
    const doc = { configurations: [{ nodes: [{ operator: 'OR', cpeMatch: [match] }] }] };
    const assess = (version, extra = {}) => assessNvd(doc, { cpes: [{ cpe: criteria.replace('portal:*', 'portal:' + version), evidenceIds: ['package-version'], ...extra }],
      cpeInventoryComplete: true, cpeInventoryEvidenceIds: ['complete'] });
    const scheme = { versionScheme: 'semver', versionSchemeEvidenceIds: ['vendor-semver'] };
    assert.equal(assess('1.5.0').state, 'unknown'); assert.equal(assess('1.5.0', { versionScheme: 'semver' }).state, 'unknown');
    assert.equal(assess('1.5.0', scheme).state, 'satisfied'); assert.equal(assess('2.0.0', scheme).state, 'not-applicable');
    assert.equal(assess('2.0.0').state, 'not-applicable'); assert.equal(assess('*', scheme).state, 'unknown');
    match.versionEndExcluding = '1.0.0-B'; match.versionStartIncluding = '0.0.0';
    assert.equal(assess('1.0.0-a', scheme).state, 'not-applicable');
    match.versionEndExcluding = '1.0.0-a'; assert.equal(assess('1.0.0-Z', scheme).state, 'satisfied');
    match.versionEndIncluding = '1.0.0'; assert.equal(assess('1.0.0', scheme).state, 'unknown');
    assert.throws(() => assess('1.0.0', { versionScheme: 'debian' }), /Unsupported/);
  });
  await check('NVD source revision and additional affected formats cannot be silently ignored', () => {
    const home = path.join(temp, 'nvd-applicability');
    const cpe = 'cpe:2.3:a:acme:portal:1.0.0:*:*:*:*:*:*:*';
    const doc = { id: 'CVE-2026-4444', configurations: [{ nodes: [{ operator: 'OR', cpeMatch: [{ criteria: cpe, vulnerable: true }] }] }] };
    const first = attachApiDocument({ ...record(0), id: doc.id }, doc, 'nvd-cve-2.0', home);
    store(home, index => index.commitPage([first], {}, { now })); const revision = readSourceHistory('nvd', doc.id, {}, home)[0].revision;
    const env = { assetId: 'fixture-asset', assetEvidenceIds: ['service-binding'], cpes: [{ cpe, evidenceIds: ['observed'] }], cpeInventoryComplete: true, cpeInventoryEvidenceIds: ['inventory'] };
    assert.equal(readSourceApplicability('nvd', doc.id, env, {}, home).state, 'satisfied');
    assert.equal(assessNvd({ ...doc, affected: [] }, env).state, 'satisfied');
    assert.equal(assessNvd({ ...doc, affected: {} }, env).reason, 'nvd-condition-channels-disagree-or-incomplete');
    assert.equal(readSourceApplicability('nvd', doc.id, { ...env, assetId: undefined }, {}, home).reason, 'assetId-and-assetEvidenceIds-required');
    assert.throws(() => readSourceApplicability('nvd', doc.id, { ...env, cpes: [{ ...env.cpes[0], assetId: 'another-asset' }] }, {}, home), /different asset/);
    doc.affected = [{ source: 'new-format', affectedData: [] }];
    store(home, index => index.commitPage([attachApiDocument(first, doc, 'nvd-cve-2.0', home)], {}, { now }));
    assert.equal(readSourceApplicability('nvd', doc.id, env, {}, home).reason, 'nvd-condition-channels-disagree-or-incomplete');
    assert.equal(readSourceApplicability('nvd', doc.id, env, { revision }, home).state, 'satisfied');
    assert.equal(readSourceApplicability('nvd', doc.id, env, { revision }, home).findingConfirmed, false);
  });
  await check('NVD native products retain exact identity default status sorted changes and semantic endpoints', () => {
    const product = { vendor: 'Acme Inc.', product: 'Portal', defaultStatus: 'unaffected', versions: [{ version: '1.0.0', lessThan: '2.0.0', versionType: 'semver', status: 'affected',
      changes: [{ at: '1.8.0', status: 'affected' }, { at: '1.5.0', status: 'unaffected' }] }] };
    const doc = { affected: [{ source: 'cna', affectedData: [product] }] };
    const assess = (version, extra = {}) => assessNvd(doc, { products: [{ vendor: 'Acme Inc.', product: 'Portal', version, evidenceIds: ['native-identity-version'], ...extra }] });
    assert.equal(assess('1.0.0').state, 'satisfied'); assert.equal(assess('1.5.0').state, 'not-applicable');
    assert.equal(assess('1.8.0').state, 'satisfied'); assert.equal(assess('2.0.0').state, 'not-applicable');
    assert.equal(assess('1.0.0', { vendor: 'acme' }).state, 'unknown');
    delete product.defaultStatus; assert.equal(assess('2.0.0').state, 'unknown');
    product.versions[0].versionType = 'custom'; assert.equal(assess('1.0.0').state, 'unknown');
    product.versions = [{ version: 'release-X', status: 'affected' }];
    assert.equal(assess('release-X').state, 'satisfied'); assert.equal(assess('release-Y').state, 'unknown');
    product.defaultStatus = 'unaffected'; product.versions[0].versionType = 'python';
    assert.equal(assess('release-Y').state, 'unknown'); assert.equal(assess('release-X').state, 'satisfied');
    delete product.defaultStatus;
    product.versions = [{ version: '0', lessThan: '1.*', versionType: 'semver', status: 'affected' }];
    assert.equal(assess('1.999.0').state, 'satisfied'); assert.equal(assess('2.0.0-alpha').state, 'unknown');
    product.defaultStatus = 'unaffected'; assert.equal(assess('2.0.0-alpha').state, 'not-applicable');
    product.versions[0].lessThan = '1.2.*'; assert.equal(assess('1.3.0-alpha').state, 'not-applicable');
    product.versions = [{ version: '1.0.0', lessThanOrEqual: '2.0.0', versionType: 'semver', status: 'affected' }];
    assert.equal(assess('2.0.0').state, 'satisfied');
    product.versions[0].lessThan = '3.0.0'; assert.equal(assess('2.0.0').state, 'unknown');
    product.versions = [{ version: '0', lessThan: '*', versionType: 'semver', status: 'affected' }];
    assert.equal(assess('bad-version').state, 'unknown'); assert.equal(assess('999.0.0').state, 'satisfied');
  });
  await check('NVD native context restrictions require observed evidence and reject cross-asset products', () => {
    const product = { vendor: 'Acme', product: 'Portal', defaultStatus: 'affected', platforms: ['Linux'], modules: ['import'] };
    const doc = { affected: [{ source: 'cna', affectedData: [product] }] };
    const fact = { vendor: 'Acme', product: 'Portal', version: '1', evidenceIds: ['product'], platforms: ['Linux'], platformsEvidenceIds: ['os'], modules: ['import'], modulesEvidenceIds: ['module'] };
    const assess = extra => assessNvd(doc, { products: [{ ...fact, ...extra }] });
    assert.equal(assess({}).state, 'satisfied'); assert.equal(assess({ modulesEvidenceIds: [] }).state, 'unknown');
    assert.equal(assess({ platforms: ['Windows'] }).state, 'unknown');
    assert.equal(assess({ platforms: ['Windows'], platformsInventoryComplete: true, platformsInventoryEvidenceIds: ['full-os'] }).state, 'not-applicable');
    assert.throws(() => assess({ assetId: 'another-service' }), /different asset/);
    product.programRoutines = [{ name: 'parse' }]; assert.equal(assess({}).state, 'unknown');
    assert.equal(assess({ programRoutines: ['parse'], programRoutinesEvidenceIds: ['function'] }).state, 'satisfied');
    assert.equal(assessNvd(doc, { products: [] }).state, 'unknown');
    assert.equal(assessNvd(doc, { products: [], productInventoryComplete: true, productInventoryEvidenceIds: ['full-product-inventory'] }).state, 'not-applicable');
  });
  await check('NVD native registry identities and providers cannot override complementary CPE conditions', () => {
    const product = { packageURL: 'pkg:npm/fixture', defaultStatus: 'affected' };
    const doc = { affected: [{ source: 'cna', affectedData: [product] }] };
    const env = { products: [{ packageURL: 'pkg:npm/fixture', evidenceIds: ['purl'] }] };
    assert.equal(assessNvd(doc, env).state, 'satisfied');
    doc.affected.push({ source: 'adp', affectedData: [{ ...product, defaultStatus: 'unaffected' }] });
    assert.equal(assessNvd(doc, env).state, 'unknown'); assert.equal(assessNvd(doc, env).nativeProductReason, 'native-product-provider-conflict');
    doc.affected.pop();
    const cpe = 'cpe:2.3:a:acme:portal:1.0.0:*:*:*:*:*:*:*';
    doc.configurations = [{ nodes: [{ operator: 'OR', cpeMatch: [{ criteria: cpe, vulnerable: true }] }] }];
    assert.equal(assessNvd(doc, env).state, 'unknown');
    const joined = { ...env, cpes: [{ cpe, evidenceIds: ['cpe'] }], cpeInventoryComplete: true, cpeInventoryEvidenceIds: ['all-cpes'] };
    assert.equal(assessNvd(doc, joined).state, 'satisfied');
    assert.equal(assessNvd(doc, { ...joined, cpes: [] }).state, 'unknown');
    product.packageURL = 'pkg:npm/fixture@1.0.0'; assert.equal(assessNvd(doc, joined).state, 'unknown');
    delete doc.configurations; delete product.packageURL; Object.assign(product, { collectionURL: 'https://registry.example', packageName: 'fixture' });
    assert.equal(assessNvd(doc, { products: [{ collectionURL: 'https://registry.example', packageName: 'fixture', evidenceIds: ['registry'] }] }).state, 'satisfied');
    assert.equal(assessNvd(doc, { products: [{ collectionURL: 'https://other.example', packageName: 'fixture', evidenceIds: ['registry'] }] }).state, 'unknown');
  });
  await check('NVD native product decisions process every condition beyond clipped source previews', () => {
    const products = Array.from({ length: 25 }, (_, i) => ({ vendor: 'Acme', product: 'Product-' + i, defaultStatus: 'affected' }));
    const doc = { affected: [{ source: 'cna', affectedData: products }] };
    const env = { products: products.map(product => ({ vendor: product.vendor, product: product.product, evidenceIds: ['observed-' + product.product] })) };
    for (let i = 0; i < 24; i++) products[i].defaultStatus = 'unaffected';
    const result = assessNvd(doc, env); assert.equal(result.state, 'satisfied'); assert.equal(result.evaluatedConditions, 25);
    assert.equal(result.productMatches.length, 20); assert.equal(result.evidenceIds.length, 20); assert.equal(result.evidenceCount, 26);
    assert.equal(result.findingConfirmed, false);
    assert.equal(assessNvd(doc, { ...env, assetEvidenceIds: [] }).state, 'unknown');
    assert.throws(() => assessNvd(doc, { products: [{ product: 'x', platforms: ['Linux'], platformsEvidenceIds: [''] }] }), /evidence IDs/);
  });
  await check('SemVer precedence handles prereleases build metadata and arbitrary numeric precision', () => {
    const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let i = 1; i < order.length; i++) { assert.equal(compareSemver(order[i - 1], order[i]), -1); assert.equal(compareSemver(order[i], order[i - 1]), 1); }
    assert.equal(compareSemver('1.0.0+one', '1.0.0+two'), 0);
    assert.equal(compareSemver('9007199254740992.0.0', '9007199254740993.0.0'), -1);
    for (const version of ['01.0.0', '1.0', 'v1.0.0', '1.0.0-01', '1.0.0+', '1.0.0-']) assert.equal(compareSemver(version, '1.0.0'), null);
  });
  await check('OSV ranges sort transitions preserve fixed boundaries and union multiple limits', () => {
    const doc = { affected: [{ package: { ecosystem: 'npm', name: 'fixture' }, ranges: [{ type: 'SEMVER', events: [
      { fixed: '3.2.5' }, { introduced: '3.0.0' }, { fixed: '1.0.2' }, { introduced: '1.0.0' }] }] }] };
    const assess = version => assessSourceDocument(doc, 'osv', { packages: [{ ecosystem: 'npm', name: 'fixture', version, evidenceIds: ['inventory-v1'] }] });
    for (const version of ['1.0.0', '1.0.1', '3.0.0', '3.2.4']) assert.equal(assess(version).state, 'satisfied');
    for (const version of ['0.9.0', '1.0.2', '2.0.0', '3.2.5']) assert.equal(assess(version).state, 'not-applicable');
    doc.affected[0].ranges[0].events = [{ introduced: '0' }, { last_affected: '2.0.0' }];
    assert.equal(assess('2.0.0').state, 'satisfied'); assert.equal(assess('2.0.1').state, 'not-applicable');
    doc.affected[0].ranges[0].events = [{ introduced: '0' }, { limit: '1.0.0' }, { limit: '2.0.0' }];
    assert.equal(assess('1.5.0').state, 'satisfied'); assert.equal(assess('2.0.0').state, 'not-applicable');
    doc.affected[0].ranges[0].events.push({ limit: '*' }); assert.equal(assess('3.0.0').state, 'satisfied');
    doc.affected[0].ranges[0].events = [{ introduced: '1.0.0' }, { fixed: '1.0.0+build' }]; assert.equal(assess('1.0.1').state, 'unknown');
    doc.affected[0].ranges[0].events = [{ introduced: '0', fixed: '2.0.0' }]; assert.equal(assess('1.0.1').state, 'unknown');
  });
  await check('native unsupported ranges missing evidence and incomplete inventories never imply exclusions', () => {
    const doc = { affected: [{ package: { ecosystem: 'Debian:12', name: 'fixture' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '1.0-1+deb12u2' }] }] }] };
    const fact = { ecosystem: 'Debian:12', name: 'fixture', version: '1.0-1+deb12u1', evidenceIds: ['package-lock'] };
    assert.equal(assessSourceDocument(doc, 'osv', { packages: [fact] }).state, 'unknown');
    const numericNative = structuredClone(doc); numericNative.affected[0].ranges[0].events = [{ introduced: '0' }, { fixed: '2.0.0' }];
    assert.equal(assessSourceDocument(numericNative, 'osv', { packages: [{ ...fact, version: '3.0.0' }] }).state, 'unknown');
    doc.affected[0].versions = [fact.version]; assert.equal(assessSourceDocument(doc, 'osv', { packages: [fact] }).state, 'satisfied');
    assert.equal(assessSourceDocument(doc, 'osv', { packages: [{ ...fact, evidenceIds: [] }] }).state, 'unknown');
    assert.equal(assessSourceDocument(doc, 'osv', { packages: [] }).state, 'unknown');
    assert.equal(assessSourceDocument(doc, 'osv', { packages: [], inventoryComplete: true }).state, 'unknown');
    assert.equal(assessSourceDocument(doc, 'osv', { packages: [], inventoryComplete: true, inventoryEvidenceIds: ['complete-inventory'] }).state, 'not-applicable');
    assert.equal(assessSourceDocument({ ...doc, withdrawn: '2026-10-01' }, 'osv', { packages: [fact] }).state, 'unknown');
    doc.affected[0].ranges = []; doc.affected[0].versions = [];
    assert.equal(assessSourceDocument(doc, 'osv', { packages: [fact] }).state, 'unknown');
  });
  await check('stored applicability binds exact source revision and cache integrity with bounded input', () => {
    const home = path.join(temp, 'source-applicability');
    const doc = { id: 'OSV-2026-7777', affected: [{ package: { ecosystem: 'npm', name: 'fixture' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.0.0' }] }] }] };
    const first = attachApiDocument({ ...record(0, 'osv'), id: doc.id }, doc, 'osv', home);
    store(home, index => index.commitPage([first], {}, { now }));
    const revision = readSourceHistory('osv', doc.id, {}, home)[0].revision;
    const environment = { packages: [{ ecosystem: 'npm', name: 'fixture', version: '1.5.0', evidenceIds: ['inventory-v1'] }] };
    assert.equal(readSourceApplicability('osv', doc.id, environment, {}, home).state, 'satisfied');
    doc.affected[0].ranges[0].events[1].fixed = '1.0.0';
    const second = attachApiDocument(first, doc, 'osv', home); store(home, index => index.commitPage([second], {}, { now }));
    assert.equal(readSourceApplicability('osv', doc.id, environment, {}, home).state, 'not-applicable');
    assert.equal(readSourceApplicability('osv', doc.id, environment, { revision }, home).state, 'satisfied');
    assert.equal(readSourceApplicability('osv', doc.id, environment, { revision }, home).findingConfirmed, false);
    assert.throws(() => assessSourceDocument(doc, 'osv', { packages: [], extra: 'x'.repeat(256 * 1024) }), /256 KiB/);
    assert.throws(() => assessSourceDocument(doc, 'osv', { packages: [{ name: 'fixture', ecosystem: 'npm', evidenceIds: [null] }] }), /evidence IDs/);
    fs.writeFileSync(second.advisory.contentFile, 'tampered'); assert.throws(() => readSourceApplicability('osv', doc.id, environment, {}, home), /digest/);
  });
  await check('declared aliases exclude upstream related and body-mentioned vulnerability identifiers', () => {
    const doc = { id: 'OSV-2026-1234', aliases: ['CVE-2026-1234'], upstream: ['CVE-2020-9999'], related: ['CVE-2021-9999'], details: 'Compare with CVE-2022-9999' };
    const row = attachApiDocument({ ...record(0, 'osv'), id: doc.id, ids: [doc.id, ...doc.aliases, ...doc.upstream, ...doc.related, 'CVE-2022-9999'] }, doc, 'osv');
    assert.deepEqual(row.ids, [doc.id, ...doc.aliases]); assert.equal(row.identifierSemantics, 'declared-only');
  });
  await check('API source documents retain complete native conditions and future fields with bounded previews', async () => {
    const home = path.join(temp, 'api-documents');
    const nvd = { id: 'CVE-2026-2345', published: '2026-01-01', lastModified: '2026-10-01', vulnStatus: 'Analyzed',
      configurations: [{ operator: 'AND', negate: true, nodes: [{ operator: 'OR', negate: false, cpeMatch: Array.from({ length: 30 }, (_, i) => ({
        vulnerable: i !== 29, criteria: `cpe:2.3:a:vendor:product-${i}:*:*:*:*:*:*:*:*`, versionStartIncluding: '1.0.0', versionEndExcluding: '2.0.0' })) }] }],
      references: Array.from({ length: 60 }, (_, i) => ({ url: `https://vendor.invalid/advisories/${i}`, tags: ['Vendor Advisory'] })),
      futureField: { keep: true, long: 'unchanged '.repeat(3000) } };
    const ghsa = { ghsa_id: 'GHSA-aaaa-bbbb-cccc', cve_id: nvd.id, published_at: '2026-01-01', updated_at: '2026-10-01',
      vulnerabilities: [{ package: { ecosystem: 'npm', name: '@fixture/lib' }, vulnerable_version_range: '>= 1.0.0, < 2.0.0',
        first_patched_version: '2.0.0', vulnerable_functions: ['parse'] }], description: 'package advisory', futureField: { preserve: true } };
    const osv = { id: 'OSV-2026-1234', published: '2026-01-01', modified: '2026-10-01', aliases: ['GHSA-aaaa-bbbb-cccc'],
      upstream: ['CVE-2020-1234'], related: ['CVE-2021-1234'],
      affected: [{ package: { ecosystem: 'Debian:12', name: 'fixture', purl: 'pkg:deb/debian/fixture?distro=bookworm' },
        versions: ['1.0-1+deb12u1'], ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '1.0-1+deb12u2' }] }],
        ecosystem_specific: { severity: 'HIGH' }, database_specific: { backport: true } }] };
    const fetchImpl = async url => ({ ok: true, status: 200, text: async () => JSON.stringify(String(url).includes('/cves/')
      ? { vulnerabilities: [{ cve: nvd }], startIndex: 0, totalResults: 1 } : String(url).includes('/advisories') ? [ghsa] : osv) });
    const window = { since: '2026-09-01', until: '2026-10-02', home, limit: 100 };
    const pages = [await fetchSourcePage('nvd', window, fetchImpl), await fetchSourcePage('github-advisories', window, fetchImpl),
      { rows: await fetchOsv({ id: osv.id, home, fetchImpl }) }];
    const originals = [nvd, ghsa, osv];
    for (let i = 0; i < pages.length; i++) {
      const row = pages[i].rows[0];
      assert(row.advisory.contentAvailable); assert(!JSON.stringify(row).includes('futureField'));
      store(home, index => index.commitPage([row], {}, { now }));
      let offset = 0, text = '';
      for (;;) { const part = readSourceContent(row.source, row.id, { offset, limit: 3000 }, home);
        assert.equal(part.representation, 'serialized-api-json'); text += part.text; if (part.nextOffset === null) break; offset = part.nextOffset; }
      assert.deepEqual(JSON.parse(text), originals[i]);
    }
    const state = readCollectorState(home, now);
    assert.equal(state.recordCount, 3); assert(!JSON.stringify(state).includes('contentFile'));
    assert(!JSON.stringify(state).includes('versionEndExcluding')); assert(!JSON.stringify(state).includes('vulnerable_version_range'));
    assert(!pages[2].rows[0].ids.includes('CVE-2020-1234')); assert(!pages[2].rows[0].ids.includes('CVE-2021-1234'));
  });
  await check('API source modifications create pinned original revisions even when summaries stay unchanged', async () => {
    const home = path.join(temp, 'api-revisions');
    const document = { id: 'CVE-2026-1111', configurations: [{ nodes: [{ cpeMatch: [{ versionEndExcluding: '2.0' }] }] }] };
    const first = attachApiDocument(record(0, 'nvd', { id: document.id }), document, 'nvd-cve-2.0', home);
    store(home, index => index.commitPage([first], {}, { now }));
    const revision = readSourceHistory('nvd', document.id, {}, home)[0].revision;
    const changed = structuredClone(document); changed.configurations[0].nodes[0].cpeMatch[0].versionEndExcluding = '2.1';
    const second = attachApiDocument({ ...first, advisory: undefined }, changed, 'nvd-cve-2.0', home);
    store(home, index => index.commitPage([second], {}, { now }));
    assert.equal(readSourceHistory('nvd', document.id, {}, home).length, 2);
    assert.deepEqual(JSON.parse(readSourceContent('nvd', document.id, { revision }, home).text), document);
    assert.deepEqual(JSON.parse(readSourceContent('nvd', document.id, {}, home).text), changed);
    assert.notEqual(first.advisory.sha256, second.advisory.sha256);
  });
  await check('API document cache refuses changed cached bytes invalid identities and oversized records', () => {
    const home = path.join(temp, 'api-cache-protection'), candidate = record(0);
    const document = { id: candidate.id, field: 'original' };
    const row = attachApiDocument(candidate, document, 'nvd-cve-2.0', home);
    fs.writeFileSync(row.advisory.contentFile, fs.readFileSync(row.advisory.contentFile, 'utf8').replace('original', 'modified'));
    assert.throws(() => attachApiDocument(candidate, document, 'nvd-cve-2.0', home), /digest differs/);
    assert.throws(() => attachApiDocument(candidate, { id: 'other' }, 'nvd-cve-2.0', home), /identity differs/);
    assert.throws(() => attachApiDocument(candidate, document, 'unknown', home), /format/);
    assert.throws(() => attachApiDocument(candidate, { ...document, field: 'x'.repeat(8 * 1024 * 1024) }, 'nvd-cve-2.0', home), /exceeds 8 MiB/);
  });
  await check('limited API discovery keeps chronology withdrawal and document availability honest', async () => {
    const nvd = { id: 'CVE-2021-44228', published: '2021-12-10', lastModified: '2026-10-01', vulnStatus: 'Rejected' };
    const ghsa = { ghsa_id: 'GHSA-aaaa-bbbb-cccc', updated_at: '2026-10-01', withdrawn_at: '2026-09-30' };
    const osv = { id: 'OSV-2026-1234', modified: '2026-10-01', withdrawn: '2026-09-30' };
    const fetchImpl = async url => ({ ok: true, status: 200, text: async () => JSON.stringify(String(url).includes('/cves/')
      ? { vulnerabilities: [{ cve: nvd }] } : String(url).includes('/advisories') ? [ghsa] : osv) });
    const rows = [(await fetchNvd({ fetchImpl }))[0], (await fetchGithubAdvisories({ fetchImpl }))[0], (await fetchOsv({ id: osv.id, fetchImpl }))[0]];
    for (const row of rows) { assert.equal(row.modified, '2026-10-01'); assert(row.withdrawnAt); assert.equal(row.advisory.contentAvailable, false); assert(!row.advisory.contentFile); }
    assert.equal(rows[0].published, '2021-12-10');
  });
  await check('KEV catalogue addition never replaces an old disclosure or makes legacy records fresh', async () => {
    const home = path.join(temp, 'kev-chronology');
    const raw = { dateReleased: '2026-10-01', vulnerabilities: [{ cveID: 'CVE-2021-44228', dateAdded: '2026-10-01', vulnerabilityName: 'Log4Shell', vendorProject: 'Apache', product: 'Log4j' }] };
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(raw) });
    const limited = await fetchCisaKev({ fetchImpl });
    const page = await fetchSourcePage('cisa-kev', { query: '', limit: 100 }, fetchImpl);
    assert.equal(limited[0].published, ''); assert.equal(page.rows[0].published, '');
    assert.equal(page.rows[0].kev.dateAdded, '2026-10-01');
    const old = { ...record(0, 'nvd'), id: 'CVE-2021-44228', ids: ['CVE-2021-44228'], published: '2021-12-10' };
    store(home, index => {
      index.commitPage([old, page.rows[0]], {}, { now });
      const candidate = index.query().rows[0];
      assert.equal(candidate.published, '2021-12-10'); assert.equal(candidate.freshness, 'stale');
      assert.equal(index.counts(now).freshCandidates, 0);
    });
    const legacy = path.join(temp, 'legacy-kev');
    store(legacy, index => {
      index.commitPage([{ ...page.rows[0], published: '2026-10-01', kev: undefined }], {}, { now });
      const candidate = index.query().rows[0];
      assert.equal(candidate.published, ''); assert.equal(candidate.freshness, 'unknown');
      assert.equal(candidate.kev.dateAdded, '2026-10-01');
      assert.equal(index.counts(now).freshCandidates, 0);
    });
  });
  await check('KEV upgrade corrects persisted chronology without changing source bytes history or checkpoints', () => {
    const home = path.join(temp, 'kev-upgrade');
    const kev = { ...record(0, 'cisa-kev'), published: '2026-10-01' };
    let revision, generation;
    store(home, index => {
      index.commitPage([kev], { checkpoints: { 'cisa-kev': { watermark: '2026-10-01' } } }, { now });
      revision = index.history('cisa-kev', kev.id)[0].revision;
      generation = index.metadata('generation');
      const stale = { ...index.query().rows[0], published: '2026-10-01', freshness: 'fresh' };
      index.statement('UPDATE candidates SET published_ms=?,body=?').run(Date.parse('2026-10-01'), JSON.stringify(stale));
      index.statement("DELETE FROM metadata WHERE key='kevChronology'").run();
      assert.equal(index.counts(now).freshCandidates, 1);
    });
    store(home, index => {
      assert.equal(index.counts(now).freshCandidates, 0);
      assert.equal(index.query().rows[0].published, '');
      assert.equal(index.query().rows[0].kev.dateAdded, '2026-10-01');
      assert.equal(index.record('cisa-kev', kev.id).published, '2026-10-01');
      assert.equal(index.history('cisa-kev', kev.id).length, 1);
      assert.equal(index.history('cisa-kev', kev.id)[0].revision, revision);
      assert.equal(index.metadata('state').checkpoints['cisa-kev'].watermark, '2026-10-01');
      assert.equal(index.metadata('generation'), generation + 1);
    });
    store(home, index => assert.equal(index.metadata('generation'), generation + 1));
  });
  await check('legacy migration retains every record, original bytes and committed versus dangling revision history', () => {
    const home = path.join(temp, 'legacy'), paths = collectorPaths(home); fs.mkdirSync(paths.dir, { recursive: true });
    const old = record(0, 'nvd', { status: 'original', extraBody: 'original '.repeat(10000) });
    const changed = { ...old, status: 'updated' }, dangling = { ...changed, status: 'uncommitted-tail' };
    const rows = [changed, ...Array.from({ length: 600 }, (_, index) => record(index + 1))];
    const bytes = Buffer.from(JSON.stringify({ schema: 'saker.nday.source-collector/2', records: rows, checkpoints: { nvd: { watermark: null, window: { cursor: '601' } } } }));
    fs.writeFileSync(paths.state, bytes);
    fs.writeFileSync(paths.revisions, [old, changed, dangling].map((row, index, all) => JSON.stringify({ source: row.source, key: `${row.source}:${row.id}`,
      revision: sha(JSON.stringify(row)), previousRevision: index ? sha(JSON.stringify(all[index - 1])) : null,
      observedAt: new Date(now).toISOString(), record: row })).join('\n'));
    const state = readCollectorState(home, now);
    assert.equal(state.schema, SOURCE_INDEX_SCHEMA); assert.equal(state.recordCount, 601); assert.equal(state.records.length, 20);
    assert.equal(state.checkpoints.nvd.window.cursor, '601');
    assert(fs.readFileSync(paths.state + '.legacy-' + sha(bytes) + '.json').equals(bytes));
    assert.equal(readSourceRecord('nvd', old.id, home).extraBody, old.extraBody);
    assert.equal(readSourceRecord('nvd', old.id, home).status, 'updated');
    const history = readSourceHistory('nvd', old.id, {}, home);
    assert.equal(history.length, 3); assert.equal(history[2].previousRevision, history[1].revision);
    assert.equal(readSourceRecord('nvd', old.id, home, history[0].revision).status, 'original');
    assert(!JSON.stringify(state).includes('extraBody'));
    const page = querySourceCandidates({ query: '金蝶', limit: 100 }, home);
    assert.equal(page.total, 601); assert.equal(page.rows.length, 100);
    assert.equal(querySourceCandidates({ query: "' OR 1=1 --", limit: 100 }, home).total, 0);
    assert.throws(() => querySourceCandidates({ query: 'other', limit: 100, cursor: page.nextCursor }, home), /changed/);
  });
  await check('page write failure rolls back current records, history and cursor together', () => {
    const home = path.join(temp, 'rollback');
    store(home, index => {
      index.commitPage([record(0)], { checkpoints: { nvd: { cursor: '1' } } }, { now });
      const first = index.history('nvd', record(0).id)[0];
      index.db.exec("CREATE TRIGGER fail_record BEFORE INSERT ON records WHEN new.id='CVE-2026-1002' BEGIN SELECT RAISE(ABORT,'fixture page failure'); END;");
      assert.throws(() => index.commitPage([record(1), record(2)], { checkpoints: { nvd: { cursor: '3' } } }, { now }), /fixture page failure/);
      assert.equal(index.counts(now).recordCount, 1);
      assert.equal(index.history('nvd', record(1).id).length, 0);
      assert.equal(index.metadata('state').checkpoints.nvd.cursor, '1');
      assert.equal(index.history('nvd', record(0).id)[0].revision, first.revision);
    });
  });
  await check('abrupt writer termination preserves the last committed page and recovers SQLite WAL', async () => {
    const home = path.join(temp, 'process-crash');
    store(home, index => index.commitPage([record(0)], { checkpoints: { nvd: { cursor: '1' } } }, { now }));
    const module = pathToFileURL(path.resolve('plugins/dsh-nday-hunter/lib/source-index.js')).href;
    const code = `import {SourceIndex} from ${JSON.stringify(module)};
      const index = new SourceIndex(${JSON.stringify(collectorPaths(home))}, {}, ${now});
      index.db.exec('BEGIN IMMEDIATE');
      index.upsert(${JSON.stringify(record(1))}, new Date(${now}).toISOString(), new Set());
      index.setMetadata('state', {schema:${JSON.stringify(SOURCE_INDEX_SCHEMA)},checkpoints:{nvd:{cursor:'2'}}});
      process.stdout.write('uncommitted-ready\\n'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes.toString(); });
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Crash fixture readiness timeout: ' + stderr)), 10000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); reject(new Error('Crash fixture exited before ready: ' + code + ' ' + stderr)); });
        child.stdout.on('data', bytes => { if (bytes.toString().includes('uncommitted-ready')) { clearTimeout(timeout); resolve(); } });
      });
    } finally {
      const exited = new Promise(resolve => child.once('close', resolve));
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    const state = readCollectorState(home, now);
    assert.equal(state.recordCount, 1); assert.equal(state.checkpoints.nvd.cursor, '1');
    assert.equal(readSourceRecord('nvd', record(1).id, home), null);
    assert.equal(readSourceHistory('nvd', record(1).id, {}, home).length, 0);
  });
  await check('SQLite commit survives a stale valid inspection mirror after restart', () => {
    const home = path.join(temp, 'stale'), paths = collectorPaths(home);
    store(home, index => index.commitPage([record(0), record(1)], { checkpoints: { nvd: { window: { cursor: '2' } } } }, { now }));
    fs.writeFileSync(paths.state, JSON.stringify({ schema: SOURCE_INDEX_SCHEMA, recordCount: 0, checkpoints: { nvd: { window: { cursor: null } } } }));
    const state = readCollectorState(home, now);
    assert.equal(state.recordCount, 2); assert.equal(state.checkpoints.nvd.window.cursor, '2');
  });
  await check('metadata search includes alternate source text, literal two-character terms and stable bounded pages', () => {
    const home = path.join(temp, 'search');
    store(home, index => {
      index.commitPage(Array.from({ length: 241 }, (_, number) => record(number)), {}, { now });
      const page = index.query({ limit: 100, now });
      assert.equal(page.rows.length, 100); assert.equal(page.total, 241);
      const second = index.query({ limit: 100, cursor: page.nextCursor, now });
      const third = index.query({ limit: 100, cursor: second.nextCursor, now });
      assert.equal(new Set([...page.rows, ...second.rows, ...third.rows].map(row => row.id)).size, 241);
      assert.equal(third.nextCursor, null);
      index.commitPage([record(0, 'github', { summary: 'unique-alternate-source needle', published: '2020-01-01' })], {}, { now });
      assert.equal(index.query({ query: 'unique-alternate-source' }).total, 1);
      assert.equal(index.query({ query: '金蝶' }).total, 241);
      assert.equal(index.query({ query: 'needle', source: 'nvd' }).total, 1);
      assert.equal(index.query({ query: 'needle', source: 'afrog-files' }).total, 0);
      assert.throws(() => index.query({ limit: 100, cursor: page.nextCursor }), /changed/);
      assert.throws(() => index.query({ limit: 101 }), /Invalid/);
    });
  });
  await check('withdrawal from the thirteenth source record is visible beyond clipped source previews', () => {
    const home = path.join(temp, 'review');
    store(home, index => {
      index.commitPage(Array.from({ length: 13 }, (_, number) => record(number, 'github', { ids: ['CVE-2026-9999'],
        status: number === 12 ? 'rejected' : 'active' })), {}, { now });
      assert.equal(index.query().total, 1);
      assert.equal(index.query().rows[0].requiresSourceReview, true);
      assert.equal(index.counts().recordCount, 13);
    });
  });
  await check('collector retries a failed transaction from its old cursor without duplicate revisions', async () => {
    const home = path.join(temp, 'collector-failure');
    store(home, index => index.db.exec("CREATE TRIGGER fail_record BEFORE INSERT ON records WHEN new.id='CVE-2026-1002' BEGIN SELECT RAISE(ABORT,'fixture page failure'); END;"));
    const failure = await runCollector({ sources: ['nvd'], maxPagesPerRun: 1 }, { home, now,
      fetchPage: async () => ({ rows: [record(1), record(2)], complete: false, nextCursor: '2' }) });
    assert.equal(failure.ok, false); assert.equal(failure.recordCount, 0);
    assert.equal(failure.checkpoints.nvd.window.cursor, null);
    store(home, index => index.db.exec('DROP TRIGGER fail_record'));
    const retry = await runCollector({ sources: ['nvd'], maxPagesPerRun: 1, noCache: true }, { home, now: now + 1000,
      fetchPage: async (_source, options) => { assert.equal(options.cursor, null); return { rows: [record(1), record(2)], complete: true, nextCursor: null }; } });
    assert.equal(retry.recordCount, 2); assert.equal(readSourceHistory('nvd', record(1).id, {}, home).length, 1);
  });
  await check('missing or damaged index and damaged migration history never become empty successful states', () => {
    const home = path.join(temp, 'missing'), paths = collectorPaths(home); fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.state, JSON.stringify({ schema: SOURCE_INDEX_SCHEMA, recordCount: 999 }));
    assert.throws(() => readCollectorState(home), /index missing/);
    const corrupt = path.join(temp, 'corrupt'), corruptPaths = collectorPaths(corrupt); fs.mkdirSync(corruptPaths.dir, { recursive: true });
    fs.writeFileSync(corruptPaths.index, 'damaged sqlite original');
    assert.throws(() => readCollectorState(corrupt), /database/);
    assert.equal(fs.readFileSync(corruptPaths.index, 'utf8'), 'damaged sqlite original');
    const damaged = path.join(temp, 'history-damaged'), damagedPaths = collectorPaths(damaged); fs.mkdirSync(damagedPaths.dir, { recursive: true });
    fs.writeFileSync(damagedPaths.state, JSON.stringify({ records: [record(0)] })); fs.writeFileSync(damagedPaths.revisions, '{broken');
    assert.throws(() => readCollectorState(damaged), /JSON/);
    const db = new DatabaseSync(damagedPaths.index);
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n, 0); } finally { db.close(); }
    assert.equal(fs.readFileSync(damagedPaths.revisions, 'utf8'), '{broken');
  });
  await check('original content is paged by exact revision and refuses tampered bytes or paths outside the cache', () => {
    const home = path.join(temp, 'original'), paths = collectorPaths(home), contentDir = path.join(paths.dir, 'source-content/git');
    fs.mkdirSync(contentDir, { recursive: true });
    const oldText = '金蝶 original '.repeat(3000), contentFile = path.join(contentDir, 'old.txt');
    fs.writeFileSync(contentFile, oldText);
    const raw = record(0, 'nvd', { repositoryFile: { contentFile, sha256: sha(oldText), contentAvailable: true } });
    store(home, index => index.commitPage([raw], {}, { now }));
    const revision = readSourceRecord('nvd', raw.id, home).revision;
    const changedFile = path.join(contentDir, 'new.txt'); fs.writeFileSync(changedFile, 'new fixed bytes');
    store(home, index => index.commitPage([{ ...raw, repositoryFile: { ...raw.repositoryFile, contentFile: changedFile, sha256: sha('new fixed bytes') } }], {}, { now }));
    let offset = 0, collected = '';
    do {
      const page = readSourceContent('nvd', raw.id, { revision, offset, limit: 4000 }, home);
      assert(page.text.length <= 4000); collected += page.text; offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(collected, oldText);
    assert.equal(readSourceContent('nvd', raw.id, {}, home).text, 'new fixed bytes');
    fs.writeFileSync(contentFile, 'tampered');
    assert.throws(() => readSourceContent('nvd', raw.id, { revision }, home), /digest differs/);
    const outside = path.join(temp, 'outside.txt'); fs.writeFileSync(outside, 'outside original');
    store(home, index => index.commitPage([record(1, 'nvd', { repositoryFile: { contentFile: outside, sha256: sha('outside original') } })], {}, { now }));
    assert.throws(() => readSourceContent('nvd', record(1).id, {}, home), /outside its cache/);
  });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
process.exitCode = failures ? 1 : 0;
