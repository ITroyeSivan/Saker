# Saker v0.3.3

## 修复

- `dsh-knowledge-hub`：托管知识包的 shallow clone 发生分叉时，不再永久停在
  `git pull --ff-only` 失败；自动重克隆到新目录，并把旧目录改名备份。同步列表支持单包重试，
  失败提示可直接展开原因。
- `dsh-attack-atlas`：方法论模板的 `graph` 字符串改为可读校验错误，非法 JSON 或非对象输入
  不再抛出裸 `SyntaxError`。
- `dsh-webshell-mgr`：冰蝎/哥斯拉目录列表响应统一经过上下文化 JSON 解析，坏响应会带协议名和
  响应预览，不再只报 `Unexpected token`。

## 可维护性

- 新增 `scripts/configure-model-reasoning.mjs`：为手工声明的 `llm-pi-ai` 模型幂等补
  `compat.thinkingFormat` 与 `reasoningEfforts`，写入前做整份 YAML 等价校验并保留备份。
- `scripts/install-all.mjs` 安装结束后自动运行该配置工具；设置 `SAKER_MODEL_REASONING=0`
  可关闭。
- 新增 `scripts/test-model-reasoning.mjs`，覆盖首次写入、字段保留、备份和重复执行幂等。
