# Third-Party Notices

Saker 本体（模式/提示词/插件源码/文档）以 MIT 授权（见根目录 `LICENSE`）。
本仓库另随附以下第三方内容，**其各自许可证独立于 Saker 的 MIT 授权**，
再分发时请遵守相应条款：

## 1. semgrep 通用规则集 — `preset/code-audit/refs/standards/semgrep-oss/`

- 来源：Semgrep 社区规则库（OSS 规则集）。
- 许可证：**LGPL-2.1 + "Commons Clause" License Condition v1.0**（完整文本见该目录内 `LICENSE`）。
- 约束要点：可自由使用与再分发，但**不得将本规则集或其衍生作为收费产品/服务的核心价值销售**（Commons Clause "Sell" 限制）。
- 说明：这些规则被 `dsh-semgrep-audit` 插件作为离线规则集引用；Saker 仅以原样聚合分发，不修改。

## 2. Trail of Bits Semgrep 规则 — `preset/code-audit/refs/standards/semgrep-oss/trailofbits/`

- 来源：Trail of Bits 发布的 Semgrep 规则。
- 许可证：**AGPL-3.0**（完整文本见该子目录内 `LICENSE`）。
- 约束要点：逐字再分发需保留本声明；若修改后对外提供网络服务，需按 AGPL 开放对应修改源码。

## 3. 「禅子」代码审计规则参考 — `preset/code-audit/refs/standards/chanzi-rules/`

- 内容：代码审计分类规则的方法论说明（cypher/MD 形式），整理自公开安全社区资料，`README-src.md` 记录了原始编写约定。
- 授权：以公开资料整理用于授权测试教学；如涉及原始作者不愿被再分发的部分，请联系移除。

## 4. 一般说明

- `preset/*/refs/` 下其余知识库文档为团队自研方法论或整理自公开安全资料，README 已声明"仅用于授权测试学习"；其中引用到的外部检测模式（如私钥正则等）均属公开安全知识。
- `preset/code-audit/refs/lang/*/semgrep-rules/` 为用户自建规则，无第三方许可负担。

## 5. PayloadsAllTheThings — `preset/shared/refs/PayloadsAllTheThings/`

- 来源：https://github.com/swisskyrepo/PayloadsAllTheThings（swisskyrepo）
- 许可证：**MIT**（该目录内随附上游 `LICENSE` 原文）
- 快照：commit `3ac2790`（master，浅克隆，2026-09-07 收录）
- 收录范围：仅 `md/txt/yaml/yml` 文本（各章节 README、Intruder payload 清单、方法论），不含图片/二进制/脚本
- 约束要点：MIT 允许自由使用与再分发，需保留版权声明与本声明；用途限定授权测试与学习（详见该目录 `_PATT_SOURCE_NOTICE.md`）

如你是上述任一内容的权利人并认为本仓库的收录方式不妥，欢迎提 Issue 联系移除。
