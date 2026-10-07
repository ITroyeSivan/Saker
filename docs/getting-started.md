# 桌面端安装与首次配置

当前版本：Saker **0.4.88**。已验证的宿主：Windows 官方 DeepSeek Harness Desktop **0.2.0-rc.2**。

[下载 Saker](https://github.com/ITroyeSivan/Saker/releases/latest) · [下载对应官方桌面](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)

## 使用发布包

1. 安装并打开官方 Desktop，完成首次初始化，配置一个可用模型。
2. 下载 `Saker-0.4.88-desktop.zip`，解压到长期保留的目录。
3. 完全退出 Desktop。在解压目录打开 PowerShell，运行：

```powershell
node scripts/install-desktop.mjs --desktop-dir "C:/实际安装目录/DeepSeek Harness" --check
node scripts/install-desktop.mjs --desktop-dir "C:/实际安装目录/DeepSeek Harness"
```

脚本安装需要 Node.js ≥22.5，不需要另外安装 pnpm。它调用指定应用内的官方命令，在一个安装事务中添加 24 个功能插件和根包，并检查已安装文件。当前安装器只接受已验证的 Desktop 0.2.0-rc.2。

安装完成后双击桌面的 **Saker (dsh Desktop)** 快捷方式。脚本每次更新都会刷新它；更换应用目录时保留原来的用户数据目录和 `.dsh` 配置。

请保留解压目录中的 `dist/desktop`：安装后的插件依赖会引用其中按内容保存的 tgz。不要把它当作临时缓存删除。已停用的插件不会被脚本擅自启用，可在官方「插件」页自行开启。

## 在应用内安装

不想使用脚本时，可在官方「插件」页依次安装发布包内的 tgz：先功能插件，最后 `dsh-saker-0.4.88.tgz`，再按应用提示重启。应用内安装使用桌面自带的 Node 和 pnpm，无需额外安装它们。

如果需要命令行管理插件，通过应用菜单「管理 dsh 命令」安装桌面自带命令；完全退出应用后再操作 desktop profile。不要用 npm 安装的独立 dsh 命令修改它。

```powershell
# 此处的 dsh 必须来自官方桌面菜单
dsh plugin --profile desktop list
```

## 从源码安装

需要 Node.js ≥22.5 和 pnpm。

```powershell
git clone https://github.com/ITroyeSivan/Saker.git
cd Saker
node scripts/pack-all.mjs
# 完全退出官方 Desktop 后：
node scripts/install-desktop.mjs --desktop-dir "C:/实际安装目录/DeepSeek Harness"
```

当前桌面版本使用 `install-desktop.mjs`。`install-all.mjs` 与 `dsh web` 是历史网页流程。

## 首次配置

| 入口 | 需要做什么 |
|---|---|
| 模型 | 选择可用模型；简单验证可用 Low |
| 安全配置 | 填写实际工具路径，检查探测结果；需要时配置 Burp、Yakit 等服务 |
| MCP 工作台 | 导入或添加服务，启动对应进程，检查连接及工具列表 |
| 漏洞情报更新 | 选择来源并更新，查看完成或失败状态 |
| 知识库、技能、方法编排 | 按本轮问题选择资料与方法，个人内容可导入或编辑 |

MCP 配置存在与服务在线是两件事：Burp/Yakit 没启动时会显示未连接，可用工具为 0。不要因此重新创建一份配置。路径显示不存在的本机工具需补充实际安装位置。

## 开始一个任务

新会话选择「渗透测试」，再选常规测试、Nday 发现或 0Day 挖掘。提供一个小目标、测试账号和已有材料，写清你想验证的问题。需要换方向或缺少资料时与你确认；相关验证不逐个疑点打断。

点击「示例与流程」可展开当前模式的三个示例，复制后替换名称、地址和已有材料。复制不会开始任务。常规测试可选择只做当前模式、收集后自动接 Nday、常规与 Nday 同时进行；子代理上限可选 0、1、2，选择立即保存。两方向共用预算和截止时间；取消、受阻或预算耗尽时不会自动续接。没有子代理时由主代理交替推进两个方向。

同一处可选择交互频率：

| 选择 | 行为 |
|---|---|
| 仅必要时询问（默认） | 沿已有范围、资料和预算连续推进，结束时集中汇总，不要求反复发送“继续” |
| 阶段汇报，自动继续 | 在阶段完成时简短汇报，然后继续，不等待回复 |
| 阶段完成后等我确认 | 阶段结束后暂停，在「redteam 成果」页的任务面板点击「确认并继续」 |

任务开始后仍可在成果页的任务面板改交互频率。已经出现的阶段确认不会因为改选项而自动解除，仍需点一次「确认并继续」；也可选择停止本轮。确认沿用原截止时间，等待期间不会暂停计时或重置操作预算。缺关键资料、需要登录、范围不清、正常访问失败或被封禁时，任何频率都应停止并说明原因。

小任务通常由主代理完成，确有需要才分派站点子任务。IP 被封或正常访问失效时及时停止请求。疑点、已确认问题和交付材料分别记录，响应差异本身不能当作漏洞结论。

## 更新与卸载

更新前完全退出应用，换用新的发布包运行同一安装命令。快捷方式保持原入口与用户数据；重新打开后检查插件版本、MCP 配置和当前任务入口。

卸载可在官方「插件」页进行，或退出后使用桌面自带命令：

```powershell
dsh plugin --profile desktop remove dsh-saker
```

插件卸载不会自动删除历史会话、成果数据库或交付文件。实测范围及仍未验证的项目见[桌面功能复测](verification/desktop-healthcheck-2026-10-04.md)。
