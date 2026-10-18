# 测试方法库（模型按需读取）

本插件提供**模型可读**的测试方法库：随包内置官方方法（`lib/methods/`，只读），
每轮把当前任务允许的测试方向以 `<saker-methods>` 简短目录注入提示词，
模型围绕当前问题用 `saker_method` 工具按需读取正文。

本版本**没有**可视化选择页，也没有聊天工具栏上的方向选择器；
选择由任务流程维护（见下），用户可见入口只有任务本身。

## 工具

| 工具 | 作用 |
|---|---|
| `saker_method action=list` | 列出当前启用的测试方向（分页，`offset`） |
| `saker_method action=read key=<group/id>` | 读取某个方向的说明正文；未启用或不存在时明确拒绝 |

工具只读文本，**不执行请求**；方法正文不改变范围、共享预算、证据记录与独立复核要求。

## 选择从哪来

- 每个任务的选择存在 `redteam-results/results.db`（任务模块表），带修订号；
  任务流程在轮次之间沿用并递增修订号，子任务沿用主任务设置。
- 旧版本的用户组合仍在 `~/.dsh/method-stack/profiles/<presetId>.json`，
  仅作为迁移来源；应用旧组合时只取当前支持的 Web 方向。
- 组合内容变化会追加 `~/.dsh/method-stack/audit.log`（时间/模式/组合/修订号）。

## 用户自定义

用户层方法放在 `~/.dsh/methods/<group>/<id>/`，同名会 shadow 内置方法（与宿主 scoped section 同构）。
所有路径跟随 `DSH_HOME`，不另立一套数据目录。

## 按需读取，不整库加载

默认全选只表示"允许按需采用"，不等于逐项扫描：每轮只给简短目录，
模型用 `knowledge_search` 定位资料、`knowledge_read` 精读必要片段；
被关闭的方向无法通过 `saker_method` 读取。
