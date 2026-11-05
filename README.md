<h1 align="center">Saker</h1>

<p align="center"><strong>让 AI 专注分析，让安全测试少些重复工作。</strong></p>

<p align="center">
  <a href="https://github.com/ITroyeSivan/Saker/releases/latest"><img alt="Saker v0.6.3" src="https://img.shields.io/badge/Saker-v0.6.3-4f66ee"></a>
  <img alt="DeepSeek Harness Desktop 0.2.2-rc.1" src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.2--rc.1-18243b">
  <img alt="Windows 10 / 11" src="https://img.shields.io/badge/Windows-10%20%2F%2011-2878d7">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-16a085"></a>
</p>

<p align="center">
  <a href="https://github.com/ITroyeSivan/Saker/releases/latest">下载</a> ·
  <a href="#为什么做-saker">设计理念</a> ·
  <a href="#三种场景">使用场景</a> ·
  <a href="#从想法到实际操作">功能与界面</a> ·
  <a href="#安装与更新">安装</a> ·
  <a href="docs/release-v0.6.3.md">更新日志</a>
</p>

Saker 是 [DeepSeek Harness Desktop](https://github.com/deepseek-ai/deepseek-harness) 的安全测试插件，面向 **SRC 挖掘、授权攻防、项目案例测试和 CTF**。

给出目标、材料和关注点，就可以开始工作。模型分析线索、选择工具并验证假设；你随时补充业务信息或调整方向。Saker 将浏览器、测试资料、按需协作和执行记录接在同一个聊天入口，减少切换工具、整理材料和重复说明的时间。

当前版本 **0.6.3**，适配官方 Desktop **0.2.2-rc.1**。

![Saker 聊天入口：选择场景，说明目标和关注点后开始工作](docs/media/main-session.png)

> 项目正在快速迭代，仅供个人学习与授权实验，暂不建议用于生产环境或正式项目交付。

## 为什么做 Saker

一次安全测试往往要在浏览器、请求报文、源码和工具输出之间反复切换。随着线索出现，测试人员还会更换账号、补充业务规则、调整研究方向。AI 已经能承担其中不少分析和操作，工具需要跟上这种工作方式。

Saker 以 dsh 的会话、模型和工具机制为基础，围绕安全测试补充资料管理、浏览器操作、案例执行、比赛环境和结果查看。我们的设计取舍也落实在这些功能中。

**测试路线跟着线索走。** 可以从网站、整批资产、请求、源码或一个 CVE、PoC 仓库开始。只有目标时先收集信息；已有账号、接口或疑点时直接验证。常规测试、Nday 发现和 0Day 挖掘用于表达关注点，具体方法和顺序由模型结合当前材料选择。

**人参与关键判断。** 测试人员熟悉业务，模型适合持续分析和执行。发现异常后补一句业务背景、切换一个身份，往往就能改变下一步验证的方向。你可以选择自行推进、询问时机和汇报频率，在需要时接手浏览器；独立调查或另一角度复核再交给助手。

**程序记录过程，模型集中分析。** 调用了什么工具、返回了什么、哪一步出错，由程序自动保存。模型无须为每次操作再做一次登记。执行记录与漏洞结论分开：请求成功返回说明操作确实执行过，影响是否成立仍要结合响应、身份和业务行为判断。

**每次调用只带需要的内容。** 提示词示例由你选用和修改，工具按需加载，资料正文按需读取。联网研究可以直接提供公告或仓库链接；离线比赛需要参考材料时，再开启本地资料。查看和导出已有记录不调用模型。

## 三种场景

| 场景 | 从哪里开始 | Saker 提供什么 |
| --- | --- | --- |
| **自由测试** | 授权域名、资产清单、账号、报文、JS、源码、CVE 或仓库链接 | 真实浏览器、资产与工具接入、按需协作、执行记录和发现 |
| **案例测试** | 项目环境说明、评审文档、Excel 案例或粘贴的要求 | 文档导入、逐项检查、缺少条件说明、历史与重测、结果导出 |
| **比赛模式** | 题面、附件和实例 | 按题管理、本地执行、交互进程、候选答案、可选离线资料 |

自由测试接受多个网址、通配子域、IP/CIDR 和排除项。可以先发现资产，也可以跳过信息收集，直接研究已有线索。例如：

```text
检查 example.com 授权范围内的 Web 资产，排除 pay.example.com。
先结合已配置的 FOFA 查找后台、登录入口和遗漏资产，
根据产品指纹与近期漏洞线索确定优先级，再验证符合条件的入口。
```

```text
阅读这个 CVE 公告和 GitHub PoC，核对我提供的资产是否符合利用条件。
先说明你的判断，再开展验证；发现异常后保留原始请求和响应供我复核。
```

```text
按项目环境说明和 Excel 案例逐项执行，沿用我提供的账号。
缺条件的项目注明原因，继续其他独立项，最后整理各项结果和依据。
```

## 从想法到实际操作

### 把需求写清楚，直接开始

聊天框上方的“写提示词”提供可搜索的需求示例。填写目标和重点，或直接改写完整文字，再复制或插入输入框；**插入不会自动发送**。常用需求可保存为个人模板，支持收藏、导入和导出。

![写提示词：选需求、改关键信息、复制或插入输入框](docs/media/prompt-editor.png)

### 浏览器、报文和工具一起使用

Saker 通过独立的 **Chrome for Testing + CDP** 操作真实页面，使用当前浏览器的登录态和前端交互。“我来操作”用于本人接手页面，处理完后继续原任务。

Burp、Yakit 等 MCP 服务，本机扫描工具，以及 FOFA、Hunter、Quake 资产平台可按需配置接入。发现来自页面、接口还是源码，都能带着已有材料继续分析。dsh 原有的文件、命令和模型能力继续提供支持。

### 按项目文档逐项检查

导入项目环境和测试要求，保留原文出处，再开始执行。支持本地 Word、Excel、文本，以及云文档导出文件或粘贴内容。

检查表集中展示要求、执行情况、结论和说明。缺账号、缺数据等条件单独列出，其他独立项继续；暂停、历史和重测分别保留对应记录。需要交付时，从结果页查看完整依据并导出。

![案例测试：导入环境说明和待检查要求](docs/media/project-documents.png)

### 比赛围绕题目展开

题面、附件、实例和执行记录按题保存。命令的输入、输出和进程状态分别保留，可以续读长输出，也可以向交互进程继续输入。候选答案单独管理，由用户或平台确认是否通过。

本地资料默认关闭，离线时按需启用。题目附件始终可读，不受参考资料开关影响。支持本机执行；Docker 使用本地已有环境与镜像，不自动下载镜像。

![比赛模式：题面、附件、本地执行与候选答案](docs/media/competition-mode.png)

### 按自己的节奏协作

“设置”集中管理范围、排除项、账号、询问、汇报、助手和可选预算。你可以让主模型独立工作，也可以为调查、复核等独立任务配置助手及模型；共用本地模型服务时可控制并发。

调整额度保留已用量。进度和错误持续可见，阅读已有记录、筛选和导出不额外发起模型总结。

![任务设置：询问时机、汇报方式与助手模型](docs/media/task-settings.png)

## 安装与更新

需要 **Windows 10/11**、官方 DeepSeek Harness Desktop，以及 **Node.js 24.9 或更高版本**。当前适配 Desktop **0.2.2-rc.1**，安装器保留对 **0.2.1-rc.5、0.2.1-rc.2、0.2.0-rc.2** 的支持。

1. 安装并打开 [官方 Desktop](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)，完成初始化和模型配置，再完全退出应用。
2. 从 [Releases](https://github.com/ITroyeSivan/Saker/releases/latest) 下载 `Saker-0.6.3-desktop.zip` 并解压。
3. 在解压目录运行，替换成实际应用安装路径：

```powershell
node scripts/install-desktop.mjs --desktop-dir "C:/path/to/DeepSeek Harness" --check
node scripts/install-desktop.mjs --desktop-dir "C:/path/to/DeepSeek Harness"
```

安装器先备份配置，再通过官方命令安装 **15 个插件和根包**，保留会话、账号、个人模板和 MCP 配置，并更新桌面的 **Saker (dsh Desktop)** 快捷方式。升级时移除退役插件，保留历史数据。

**安装后保留解压目录，尤其是 `dist/desktop`。** 已安装插件会引用其中的包文件。模型、本机工具、浏览器及外部服务按自己的环境配置。

| 文档 | 内容 |
| --- | --- |
| [安装与首次配置](docs/getting-started.md) | 安装、模型、浏览器及外部服务配置 |
| [功能说明](docs/features.md) | 聊天入口、三种场景、记录与结果 |
| [插件清单](docs/plugin-list.md) | 组件及其职责 |
| [更新日志](docs/release-v0.6.3.md) | 当前版本变化 |

## 反馈与许可

欢迎通过 [Issues](https://github.com/ITroyeSivan/Saker/issues) 反馈问题。描述使用场景、预期行为和实际表现，有助于定位；分享日志或截图前，请遮蔽账号、Cookie、Token 和个人信息。

仅在拥有或已明确授权的环境中使用。Saker 自有代码采用 [MIT](LICENSE)，第三方内容遵循各自许可证，见 [第三方说明](THIRD_PARTY_NOTICES.md)。感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供的开源基础。
