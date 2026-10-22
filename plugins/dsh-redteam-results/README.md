# dsh-redteam-results

自由测试和按文档测试的任务、证据、发现与交付插件。

## 工作起点

- **自由测试**：从目标、账号、请求、JS、源码、扫描结果或 CVE 直接开始；常规、Nday、0Day 是方向偏好。
- **按文档测试**：读取 Word、Excel 和文本，保存来源位置与修订，把要求整理成检查项并连续执行。

公共知识库、固定方法模块和常规转 Nday 流程不参与新任务。研究记录、工作方向和模块选择只作为历史数据保留。

## 状态与证据

- 任务状态保存范围、身份、预算、协作方式、暂停、阻碍和原用量。
- 完整阴性结论需要本次真实动作或明确复用的观察；问题结论需要关联可复核发现。
- 请求、浏览器页面、截图、下载、文档片段和发现引用分别保存。
- 未知写入必须先核对；连接中断后不会自动重放相同业务提交。
- 崩溃恢复只接管确认已停止的运行，活进程不会被第二个窗口抢占。

## 按文档测试

项目运行使用 `project_document` 读取来源，用 `project_check define/next` 保存和领取检查，再用 `project_request`、`saker_browser` 或项目文件工具执行并记录结果。

检查表显示：

- 原文要求；
- 当前结果；
- 实际做了什么；
- 缺少什么条件；
- 对应请求、页面观察或附件引用。

`project_check next/detail` 只返回显式字符串、数组或 `null`，保证官方宿主的无损 JSON 校验通过。

## 浏览器与请求

目标页面优先使用受管 Chrome for Testing / CDP。直接 HTTP 走可计量执行入口，保存方法、目标、身份、状态、响应摘要和完整回执。范围、排除路径、只读和并发限制在派发前检查。

## 交付

结果页分别提供执行记录、发现的问题和测试资料。导出包含检查表、发现、复现材料、请求回执、截图和附件；导出本身不访问目标，也不调用模型。秘密字段按常见请求头和 JSON 字段脱敏。

## 归档兼容

- 新归档：`saker.task-archive/3`。
- 旧归档：`saker.task-archive/2` 完整校验后忽略退役知识区。
- 项目来源、材料、身份引用、发现和证据继续恢复。

## 测试

```powershell
node --import ../../scripts/test-stub-register.mjs test/run.mjs
node --import ../../scripts/test-stub-register.mjs ../../scripts/test-project-tools.mjs
node --import ../../scripts/test-stub-register.mjs ../../scripts/test-desktop-task-ui.mjs
```
