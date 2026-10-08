// Audit captured transport JSON without publishing prompts, bodies, or authentication.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const bytes=value=>value===undefined?0:Buffer.byteLength(JSON.stringify(value));
const source=name=>/^redteam_/.test(name)?'dsh-redteam-results'
  :/^(stage_gate|operation_|task_)/.test(name)?'dsh-stage-gate'
  :/^knowledge_/.test(name)?'dsh-knowledge-hub'
  :/^trace_/.test(name)?'dsh-trace-vault'
  :/^(campaign_|gates_)/.test(name)?'dsh-campaign-memory'
  :/^tool_pack$/.test(name)?'dsh-tool-scope'
  :/^(mcp_call|mcp_search)$/.test(name)?'dsh-mcp-studio'
  :/^mcp__/.test(name)?'MCP server'
  :/^(ask_user_question|create_goal|get_goal|update_goal|edit|glob|grep|pwsh|read|write|skill|todo_write|job_|subagent_|web_|present|list_agents|send_message|interrupt_agent|workflow|exit_plan_mode)/.test(name)?'host'
  :'unattributed';
const label=block=>block.type!=='text'?block.type
  :block.text?.startsWith('Current runtime context')?'runtime-context'
  :block.text?.includes('following workspace instructions')?'workspace-instructions'
  :block.text?.includes('A skill is a reusable')?'skills':'text';
export function auditModelRequest(raw,file='captured-request.json'){
  const input=Buffer.isBuffer(raw)?raw:Buffer.from(raw),body=JSON.parse(input.toString('utf8'));
  const canonical=JSON.stringify(body), canonicalBytes=Buffer.byteLength(canonical);
  const parts={system:bytes(body.system),tools:bytes(body.tools),messages:bytes(body.messages),
    packageInventory:bytes(body.dsh_plugin_packages)};
  parts.other=canonicalBytes-Object.values(parts).reduce((n,b)=>n+b,0);
  if(parts.other<0)throw Error('Invalid byte partition');
  const tools=(body.tools??[]).map(tool=>({name:tool.name??tool.function?.name??'unknown',bytes:bytes(tool)}));
  const grouped=new Map();for(const tool of tools){const key=source(tool.name),row=grouped.get(key)??{source:key,count:0,definitionBytes:0};row.count++;row.definitionBytes+=tool.bytes;grouped.set(key,row)}
  const messages=(body.messages??[]).map((message,index)=>({index,role:message.role,bytes:bytes(message),
    blocks:Array.isArray(message.content)?message.content.map(block=>({kind:label(block),bytes:bytes(block)})):[]}));
  return {file:basename(file),sha256:createHash('sha256').update(input).digest('hex'),rawBytes:input.length,
    canonicalBytes,canonicalWire:input.toString('utf8')===canonical,
    bytePartitions:parts,model:body.model,toolCount:tools.length,packageCount:body.dsh_plugin_packages?.packages?.length??null,
    toolSources:[...grouped.values()].sort((a,b)=>b.definitionBytes-a.definitionBytes),
    largestTools:tools.sort((a,b)=>b.bytes-a.bytes).slice(0,12),messages,
    systemHistoryBytes:messages.filter(m=>m.role==='system').reduce((n,m)=>n+m.bytes,0),
    titleLike:tools.length===0&&typeof body.system==='string'&&/title/i.test(body.system),
    limitations:['Bytes are not token attribution or monetary cost.','Package metadata is a transport extension; model billing treatment is unknown.','Tool ownership uses conservative name rules; unknown tools remain unattributed.']};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  if(process.argv.length<3)throw Error('Usage: node scripts/audit-model-request.mjs <captured-request.json> [...]');
  console.log(JSON.stringify(process.argv.slice(2).map(file=>auditModelRequest(readFileSync(file),file)),null,2));
}
