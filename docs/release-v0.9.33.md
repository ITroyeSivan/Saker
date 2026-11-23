# Saker 0.9.33

### ✨ 新增功能

- 模块完成改为按固定版 `outputs` 合同校验：`analysis-complete` 必须有结构化分析产物；`verification-observed` 还必须有关联的真实 receipt/browser 观察。
- 支持 `artifact` 产物（kind/title/detail/sourceRefs）；work/finding 只作上下文或依赖，不再冒充完成产物。
- 账号权限对照要求至少两个不同身份的真实观察，并关联到同一结构化产物。
- 新增 `roles.reconcile` 显式释放对账入口。

### 🐛 问题修复

- `verified:true` 不再混用：分别返回 reference / product / observation / finding 状态。
- 回执完整性未知、目标不符、身份不符、错误 outcome、错误产物类型均拒绝；失败不改变调用 revision/state。
- `roots.detail`、`roles.list`、角色状态改为纯读；释放对账不再由打开页面触发。
- 释放已观察但待对账、cleanup-failed 和跨代旧事件在快照中明确显示；终态不被旧事件重复推进。
- 覆盖图端点显示方法+路径、主机、身份和状态；检查节点显示业务名称，ID 退到副标题/详情。

### 🎨 体验优化

- 图节点扩大到可容纳两行信息，减少只显示截断 URL 和内部 `check-7` 的情况。
- 任务详情和角色库显示“释放已观察、状态待对账”等真实中间态。

### ⚠️ 其他变更

- 根包升到 `0.9.33`。
- `@dsh-external/dsh-redteam-results` 升到 `1.4.26`。
- A/B 继续暂停；未发布、未 push、未提交 Git。
