# dsh-hunter (hunter 狩猎)

FOFA / 奇安信 Hunter / 360 Quake **三方资产测绘聚合**：统一 DSL 一次编写 → 自动转换为各平台语法 → 配额感知分页导出，并接入 code-audit 的活体验证流水线（L0 互联网资产指纹核对，L1 最小影响 EXP 仅作用于用户授权资产，L2 完整利用不做）。

## 能力

- **聚合检索**：Web 设置页的搜索接口提供统一 DSL（`host="x" && port="80"` 类），内部按平台规则转写并合并去重。
- **模型工具 `asset_search`**：同一套 adapter 直接给模型调用；先用显式 `scope` 过滤授权范围，
  再把范围内结果归一合并到工作区 `asset-inventory.json` / `assets.md`。范围外结果只计数、不落账。
  未配置任何平台 key 时明确失败并给 `subfinder/httpx/fscan/asset_ingest` 降级路径，不返回空成功。
- **模型工具 `asset_search_batch`**：批量执行 Nday 指纹查询，返回逐查询候选映射；FOFA 请求全局串行限速，授权范围加入查询并在本地再次过滤。支持 FOFA 官方语法中的 `fid`、`app`、`product`、`product.version`、`category`、哈希、banner、JARM、证书/TLS 指纹等字段；FOFA 不支持的字段不会静默降级到 Hunter/Quake 的宽查询。部分高级字段受 FOFA 账号等级限制，相关 API 错误会按查询组保留。
- **设置与配额**：Web 设置面板填三家 API key（独立 SQLite `~/.dsh/hunter/hunter.db` 存储），配额感知的分页/导出与每日预算护栏。
- **实测流水线**（Live-Verify）：读 redteam-results 成果库取 finding → 指纹搜索 → 存活探测 → L0/L1 分级验证 → 回写 `retestNote / evidence / status` + 历史 + 会话 followup 通知。
- **授权边界**：互联网资产仅 L0（GET 首页+指纹）；L1 最小影响验证**仅对用户显式标记授权的资产**执行；不提供 L2 完整利用。

## 组成

- 宿主插件（`webServer` + `webRuntime` + `tools` 注入）：`/dsh-hunter` 前缀 RPC——设置 / 查询 / 导出 / 实测 / 历史；模型侧 `asset_search`。
- 客户端：会话侧栏「hunter」入口 + 设置面板。
- 存储：`~/.dsh/hunter/hunter.db`（API key + 实测历史 + 授权白名单）；复用 redteam-results 的 `results.db` 读 finding。
- 平台适配：`lib/adapters.js`（FOFA / Hunter / Quake 语法转写 + 配额映射）。

## 配置

在 Web「hunter」设置面板填入三平台 API key；实测前先在成果页把目标标记为「授权」。

## 测试

`node --import ../../scripts/test-stub-register.mjs test/run.mjs`——DSL 转写、配额分页、授权边界、实测流水线。
