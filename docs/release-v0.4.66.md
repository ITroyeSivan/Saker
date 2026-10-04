# Saker v0.4.66

发布日期：2026-09-29

## 变更

- `dsh-nday-hunter` 新增免费源后台采集器：CISA KEV、NVD、OSV、GitHub Advisories、nuclei-templates 公开 commit feed，以及配置检索词后的微信公众号 search-assisted 采集。
- 新增 `nday_source_radar`、`nday_source_collect`、`nday_metrics`：查看采集状态、立即采集或保存配置，并记录候选数、API 请求、首轮命中率、指纹误报率与查询到 RCE 的平均耗时。
- 情报候选按编号、URL 或标题去重合并，保留来源时间、可信等级、新鲜度和 `dedupKey`；失败、验证码和反爬不会被伪装成零结果。
- `nday_scope_hunt` 支持 `platform=auto|fofa|hunter|quake`；FOFA 不可用时按 Hunter → Quake 降级，并保留 `platformAttempts`、`degradedFrom` 和不支持字段警告。
- `dsh-hunter` 设置页新增「Nday 情报与策略」专用面板，支持策略字段、免费源开关、立即采集和指标展示；FOFA/Hunter/Quake key 继续只从设置页或本机数据库读取。
- `dsh-hunter`、`dsh-nday-hunter` 与根包版本分别升级到 `1.5.0`、`1.5.0`、`0.4.66`。

## 诚实边界

- CNVD/CNNVD 当前没有稳定、匿名、可自动化的免费 API；采集器不会把它们伪装成已接入数据源，仍由宿主搜索和人工页面补足。
- 奇安信 CERT 等只有来源指引的站点不会被标记为自动接口。
- nuclei-templates 更新、公众号文章和测绘命中都只是候选线索，必须回源、核对版本/前置条件并独立验证后才能升级。

## 验证

- Saker 源码全量回归：47 套，13,258 通过、0 失败、16 跳过。
- `rpc-contract`：0 个端点契约问题、0 个跨插件 import 问题；`tool-smoke`、`badpath-smoke`、`audit-bundle` 均通过。
- 真实 `web` profile：源码与已装产物比对 2,270 个文件、24 个插件，全部字节同步；profile 25 条 deps / 27 条 bundles 与源码一致。
- DeepSeek Harness `0.2.0-rc.1`：真实 Web 宿主启动成功；`/dsh-hunter/nday.config.get`、`nday.config.set`、`nday.metrics.get` 真实 RPC 返回成功，未注册通道返回 405；模型请求工具面 63 个，包含 `nday_source_fetch`、`nday_source_radar`、`nday_source_collect`、`nday_metrics`、`nday_scope_hunt` 等 17 个 `nday_*`/资产工具。
- Chrome for Testing 真实 UI 验收：设置页「Nday 情报与策略」面板可见，排序策略、免费源开关、采集器状态和命中率/成本区均正常渲染。
- `0.2.0-rc.1` 桌面 bundle 构建通过；本轮未重复启动 Electron 桌面应用，桌面端安装边界沿用上一轮已完成的真实验证。
