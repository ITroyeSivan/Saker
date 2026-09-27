# dsh-sec-enforce (确定性执行护栏)

三种安全预设（pentest / code-audit / ctf-solver）的**确定性工具调用护栏**：用 dsh-tools 的原生 guard 缝
（`ctx.tools.guard()`，pre-execute、同步、可拒绝、宿主平面全局注册）把四条纪律从"模型自查"
变成**机器强制**。Guard 只对两安全预设触发；每次拒绝写入工作区 `enforce-log.md`。

## 四道硬门 + ask 审批层

| 门 | 拦截对象 | 通过条件 |
|---|---|---|
| `reportGate` | `write`/`edit` 落 `reports/` | `gate-log.md` 已含本模式「报告门」PASS（pentest P3 / code-audit A3，与 dsh-stage-gate 对齐，报错文本指名该调哪道门） |
| `writeBoundary` | 写操作 | 目标在任务工作区内（工具级最小权限；审计只读对象、产物限工作区，统一「不出工作区」）。**相对路径以会话工作区为基准解析**（不是宿主进程 cwd）——`artifacts/evidence/x.md` 这类相对写法必须放行，2026-09-25 真机会话里它曾被误判成越界 |
| `dangerousOps` | 高危 bash | 大范围 `rm` / 裸 `DROP` / 停机重启 / 资金类 POST——拒绝并指路「呈报计划 → 审批」 |
| `rateDiscipline` | 全端口扫描 | 裸 `nmap -p-` 无速率控制 / `masscan --rate>1000` / 裸 `ffuf` 无 `-rate`——拒绝并给出修法 |
| `askGate`（v1.1+） | 变更性但可逆操作 | 账号与权限体系变更 / 防火墙规则修改 / flood 类压测 / `memshell_cli action=run` → 宿主原生人工审批（allowed-once 放行，拒绝/超时/无审批通道即拒） |
| `intentGate`（v1.2+） | 报告写入 | 存在未结束的工作方向时阻止，直到全部结束 |
| `constraintGate`（v1.3+） | bash/fetch | 任务台账 deny 约束关键词命中即拦截并引用约束原文 |
| `pipelineGate`（v1.4.6+） | pentest 的子代理/工作流派发 | `asset-inventory.json` 至少有一个资产前不允许先扇出；先做 FOFA/Hunter/Quake 或导入 TScanPlus/fscan/nmap/httpx 结果 |
| `spreadGate`（v1.4.7+） | pentest 的资产组铺开派发 | `attack-progress.json` 没有 `confirmed` 代表资产时，引用该资产组的“批量/铺开”子代理直接拦截；只允许写代表资产 id 的单资产验证任务 |

## 组成

- `lib/index.js`：guard 注册（pre-execute 瀑布：先取下游决策，仅当下游 allow 时叠加本层约束）；
  deny/allow 约束登记与匹配；资产清单前置门；代表资产铺开门；enforce-log 落盘。
- 测试：`node test/run.mjs`——各门判定、ask 降级、工作方向门、约束门、资产清单前置门、代表资产门、memshell 执行审批、enforce-log 格式。

## 配置

无独立设置页；约束数据来自任务台账（operation_constraints），与 dsh-stage-gate 同一数据面。
