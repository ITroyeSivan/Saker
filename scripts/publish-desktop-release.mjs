// Publish only the pushed commit and verified Desktop assets. Credentials stay
// in memory. Resume an interrupted draft; never replace an existing asset.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { assertReleaseContent, checkPublicContent } from './lib/public-content.mjs';

const [repository, tag, notesPath, zipPath] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^v\d+\.\d+\.\d+$/.test(tag ?? '') || !notesPath || !zipPath)
  throw Error('Usage: node scripts/publish-desktop-release.mjs owner/repo vX.Y.Z notes.md delivery.zip');
const env = { ...process.env, GIT_TERMINAL_PROMPT:'0', GCM_INTERACTIVE:'never' };
function git(...args) {
  const result=spawnSync('git',args,{encoding:'utf8',windowsHide:true,env});
  if(result.status!==0)throw Error('Git check failed: '+args[0]);return result.stdout.trim();
}
if(git('status','--porcelain'))throw Error('Commit all intended changes before publication');
const commit=git('rev-parse','HEAD');
if(commit!==git('rev-parse','refs/remotes/origin/main'))throw Error('Push this commit to origin/main before publication');
const remote=git('remote','get-url','origin');
if(![`https://github.com/${repository}.git`,`https://github.com/${repository}`,`git@github.com:${repository}.git`].includes(remote))
  throw Error('Origin does not match the requested repository');
const version=JSON.parse(readFileSync('package.json','utf8')).version;
if(tag!=='v'+version || basename(zipPath)!==`Saker-${version}-desktop.zip`)throw Error('Version, tag and asset disagree');
const body=readFileSync(notesPath,'utf8');
assertReleaseContent(body);
checkPublicContent(process.cwd());
const zip=readFileSync(resolve(zipPath));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const checksum=Buffer.from(`${hash(zip)}  ${basename(zipPath)}\n`);
writeFileSync(resolve(zipPath)+'.sha256',checksum);
const localAssets=[{name:basename(zipPath),bytes:zip,type:'application/zip'},
  {name:basename(zipPath)+'.sha256',bytes:checksum,type:'text/plain'}];
const credential=spawnSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',windowsHide:true,env});
if(credential.status!==0)throw Error('Git credential unavailable');
const fields=Object.fromEntries(credential.stdout.split(/\r?\n/).filter(Boolean).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
if(!fields.password)throw Error('Git credential has no token');
const headers={accept:'application/vnd.github+json',authorization:`Bearer ${fields.password}`,
  'user-agent':'saker-desktop-release','x-github-api-version':'2022-11-28'};
const base=`https://api.github.com/repos/${repository}`;
async function api(path,{method='GET',data,allow404=false}={}) {
  const result=await fetch(base+path,{method,headers:{...headers,...(data?{'content-type':'application/json'}:{})},
    ...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(60000)});
  if(allow404 && result.status===404)return null;
  if(!result.ok)throw Error(`GitHub ${method} ${path} returned ${result.status}`);
  return result.json();
}
// A pre-existing tag must already identify this commit (including annotated tags).
async function verifyTag(required=false) {
  let value=await api('/git/ref/tags/'+encodeURIComponent(tag),{allow404:!required});
  if(!value)return;
  let object=value.object;
  for(let depth=0;object.type==='tag' && depth<8;depth++)object=(await api('/git/tags/'+object.sha)).object;
  if(object.type!=='commit' || object.sha!==commit)throw Error('Existing release tag does not match HEAD');
}
await verifyTag();
let release=await api('/releases/tags/'+encodeURIComponent(tag),{allow404:true});
if(release && release.body!==body)throw Error('Existing release notes differ; inspect before changing them');
if(!release)release=await api('/releases',{method:'POST',data:{tag_name:tag,target_commitish:commit,name:`Saker ${tag}`,body,draft:true,prerelease:false}});
const uploaded=[];
for(const asset of localAssets) {
  let existing=(await api(`/releases/${release.id}/assets?per_page=100`)).find(row=>row.name===asset.name);
  if(!existing) {
    if(!release.draft)throw Error('Published release is missing an asset; inspect before mutation');
    const url=new URL(release.upload_url.replace(/\{.*$/,''));
    if(url.protocol!=='https:' || url.hostname!=='uploads.github.com')throw Error('Unexpected GitHub upload host');
    url.searchParams.set('name',asset.name);
    const result=await fetch(url,{method:'POST',headers:{...headers,'content-type':asset.type},body:asset.bytes,
      redirect:'error',signal:AbortSignal.timeout(300000)});
    if(!result.ok)throw Error(`Upload ${asset.name} returned ${result.status}; inspect draft before retry`);
    existing=await result.json();
  }
  if(existing.state!=='uploaded' || existing.size!==asset.bytes.length)throw Error('Remote asset is incomplete: '+asset.name);
  const expected='sha256:'+hash(asset.bytes);
  if(existing.digest) {
    if(existing.digest!==expected)throw Error('Remote asset digest mismatch: '+asset.name);
  } else {
    const result=await fetch(existing.url,{headers:{...headers,accept:'application/octet-stream'},signal:AbortSignal.timeout(300000)});
    if(!result.ok)throw Error('Cannot verify remote asset: '+asset.name);
    const digest=createHash('sha256');for await(const chunk of result.body)digest.update(chunk);
    if('sha256:'+digest.digest('hex')!==expected)throw Error('Downloaded asset mismatch: '+asset.name);
  }
  uploaded.push({name:asset.name,size:existing.size,sha256:expected.slice(7),url:existing.browser_download_url});
}
if(release.draft)release=await api(`/releases/${release.id}`,{method:'PATCH',data:{draft:false}});
await verifyTag(true);
const verified=await api('/releases/tags/'+encodeURIComponent(tag));
if(verified.draft || verified.prerelease)throw Error('Release is not a normal published release');
// Draft asset URLs use an untagged identifier. Read the promoted assets again
// instead of reporting those temporary URLs as the public download links.
const publishedAssets=uploaded.map(local=>{
  const remote=verified.assets.find(asset=>asset.name===local.name);
  if(!remote || remote.state!=='uploaded' || remote.size!==local.size || (remote.digest && remote.digest!=='sha256:'+local.sha256))
    throw Error('Published asset changed: '+local.name);
  return {...local,url:remote.browser_download_url};
});
console.log(JSON.stringify({ok:true,commit,tag,url:verified.html_url,assets:publishedAssets},null,2));
