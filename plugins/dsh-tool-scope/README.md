# dsh-tool-scope

按会话模式收窄发给模型的工具清单。插件使用宿主的 `agent.ctx.tools.restrict({ deny })`，在请求构造前隐藏不适用的工具定义。

## Pentest 工具面

Pentest 的目标是快速侦察、核对适用 Nday 或验证一个原创漏洞假设，并在取得一条可复现 RCE 证据后停止。默认隐藏：

- 子代理、工作流、任务矩阵和资产编组入口；
- WebShell、内存马、命中后利用计划、内网与横向工具；
- Nday 语料整理和批量交接工具；
- 战役记忆与轨迹查询工具。

默认保留轻量指纹、`nday_catalog`、`nday_match`、`zday_pattern`、`oob_probe`、RCE 证据登记和知识检索。Nmap、目录/内容扫描、Nuclei、Afrog、SQLMap 与爬取工具通过 `active-scan` 包按需加载；单目标 Nday 不需要加载它。Pentest 中 `tool_pack` 入口保持可见，以便按需加载；批量匹配只用于用户明确提供的授权目标。

## 其他模式

规则 `webshell`、`ctf`、`security` 按对应插件的模式门禁隐藏模型在当前模式下不能调用的工具。`pentest-rce-focus` 只应用于 Pentest。工具名按实时清单匹配，避免向宿主传递未知名称。

| 模式 | 主要过滤 |
|---|---|
| Pentest | CTF、WebShell、派单/工作流、矩阵、记忆/轨迹、后渗透、内网和语料维护入口；主动扫描器默认收起 |
| Code Audit | CTF、WebShell、当前模式不可用的工具包入口 |
| CTF Solver | WebShell、当前模式不可用的工具包入口 |
| 其他/默认 | 按各规则白名单过滤；未列入规则的宿主工具保持可见 |

## 配置

```yaml
- insert:
    - id: dsh-tool-scope
      name: '@dsh-external/dsh-tool-scope'
      config:
        enable: true
        log: true
        rules:
          webshell: true
          ctf: true
          security: true
          pentest-rce-focus: true
          toolPack: true
```

`enable: false` 可关闭过滤；逐条规则设为 `false` 可恢复对应工具的可见性。`restrict()` 失败时会记录警告并保留原工具清单。

## 边界

该插件改变模型能看到的工具声明，不替代目标授权、执行端权限或审批策略。Pentest 提示词也要求只测试明确授权的目标、只收集与单条 RCE 路径有关的信息，并在 RCE 证实后停止。

## 测试

```bash
node --import ../../scripts/test-stub-register.mjs test/run.mjs
```
