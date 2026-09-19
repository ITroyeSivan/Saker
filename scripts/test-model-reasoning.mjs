import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'configure-model-reasoning.mjs')
const HOST_SRC = process.env.DSH_SRC || resolve(ROOT, '..', '_ref', 'dsh-src-0.1.6-alpha.1')
const yamlPkg = join(HOST_SRC, 'node_modules', 'js-yaml', 'package.json')
if (!existsSync(yamlPkg)) {
  console.log('skip model-reasoning（缺少 js-yaml，设置 DSH_SRC 后重跑）')
  process.exit(0)
}
const yaml = createRequire(pathToFileURL(yamlPkg).href)('js-yaml')
const HOME = mkdtempSync(join(tmpdir(), 'saker-model-reasoning-'))
const settings = join(HOME, 'settings.yaml')

let pass = 0
let fail = 0
const ok = (name, condition, detail) => {
  if (condition) {
    pass += 1
    console.log(`ok   ${name}`)
  } else {
    fail += 1
    console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

writeFileSync(settings, [
  'llm-pi-ai:',
  '  providers:',
  '    {',
  '      custom:',
  '        {',
  '          displayName: opencode go,',
  '          models:',
  '            [',
  '              { id: deepseek-flash, name: deepseek-flash, description: keep-me, contextWindow: 1000000, maxTokens: 384000 }',
  '            ]',
  '        }',
  '    }',
  '',
].join('\n'), 'utf8')

const run = () => spawnSync(process.execPath, [SCRIPT, '--settings', settings, '--apply'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, DSH_SRC: HOST_SRC },
})

try {
  const first = run()
  ok('首次应用退出成功', first.status === 0, `${first.stdout}\n${first.stderr}`)
  const parsed = yaml.load(readFileSync(settings, 'utf8'))
  const model = parsed?.['llm-pi-ai']?.providers?.custom?.models?.find((item) => item.id === 'deepseek-flash')
  ok('补上 deepseek thinkingFormat', model?.compat?.thinkingFormat === 'deepseek', JSON.stringify(model))
  ok('补上四档 reasoningEfforts', model?.reasoningEfforts?.off === null && model?.reasoningEfforts?.low === 'low' && model?.reasoningEfforts?.high === 'high' && model?.reasoningEfforts?.max === 'max', JSON.stringify(model?.reasoningEfforts))
  ok('目标模型已有字段未被覆盖', model?.description === 'keep-me' && model?.maxTokens === 384000, JSON.stringify(model))
  ok('写入前保留备份', readdirSync(HOME).some((name) => name.startsWith('settings.yaml.bak-reasoning-')), readdirSync(HOME).join(','))

  const second = run()
  const backups = readdirSync(HOME).filter((name) => name.startsWith('settings.yaml.bak-reasoning-')).length
  ok('重复执行幂等且不新增备份', second.status === 0 && /SKIP/.test(second.stdout) && backups === 1, `${second.stdout} backups=${backups}`)
} finally {
  rmSync(HOME, { recursive: true, force: true })
}

console.log(`model-reasoning: ${pass} ok / ${fail} fail`)
process.exit(fail ? 1 : 0)
