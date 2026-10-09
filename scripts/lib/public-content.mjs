import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const internalPath=/^(?:_ref\/|docs\/(?:verification|reports|plans|images)\/|docs\/(?:saker-.+|.+-20\d\d-\d\d-\d\d)\.md$|docs\/nday-(?:development-handoff|implementation-audit)\.md$)/;
const privateText=/(?:用户反馈原话|他说得对|用户反馈[「（(]|[A-Z]:[\\/]Users[\\/](?!<|%|example\b|name\b)[^\\/\s"'`]+|docs\/verification\/|saker-(?:goal-prompt|consolidated-delivery|implementation-progress)-20\d\d)/;
export function assertReleaseContent(body){
  for(const heading of ['✨ 新增功能','🐛 问题修复','🎨 体验优化','⚠️ 其他变更'])if(!body.includes('### '+heading))throw Error('Missing release section: '+heading);
  if(privateText.test(body)||/(?:验收|回归\s*\d|\d[\d,]*\s*(?:通过|失败|跳过|断言)|实测|校准|测试结果|测试记录|开发对话|G0[–—-]G10)/.test(body))throw Error('Release contains development records');
}
export function checkPublicContent(root){
  const failures=[];
  function walk(directory){
    for(const entry of readdirSync(directory,{withFileTypes:true})){
      const file=join(directory,entry.name),name=relative(root,file).replaceAll('\\','/');
      if(entry.isSymbolicLink())continue;
      if(entry.isDirectory()){
        if(['.git','node_modules','dist','.pnpm','refs','rules'].includes(entry.name))continue;
        if(internalPath.test(name+'/')){failures.push(name);continue;}
        walk(file);continue;
      }
      if(internalPath.test(name)){failures.push(name);continue;}
      if(!/\.(?:md|js|mjs|json|ya?ml|ps1|txt)$/.test(name)||name==='scripts/lib/public-content.mjs')continue;
      const text=readFileSync(file,'utf8');
      if(privateText.test(text))failures.push(name+': private content');
      if(/^docs\/release-v/.test(name)){try{assertReleaseContent(text);}catch(e){failures.push(name+': '+e.message);}}
      if((name==='README.md'||/^docs\//.test(name))&&name.endsWith('.md')){
        for(const match of text.matchAll(/\]\(([^)]+)\)/g)){
          const link=match[1].split('#')[0];
          if(!link||/^(?:https?:|mailto:)/.test(link))continue;
          if(!existsSync(join(directory,link)))failures.push(name+': missing link '+link);
        }
      }
    }
  }
  walk(root);
  if(failures.length)throw Error('Public content check failed:\n'+failures.join('\n'));
  return {passed:true};
}
