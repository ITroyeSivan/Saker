> 2026-10-03入口调整：新任务仅保留渗透测试，其下为常规测试、Nday发现、0Day挖掘。文中旧模式资料仅供历史兼容；当前用法见[使用介绍](saker-improvements-and-plugin-guide-2026-10-02.md)。

# 开发与发布

仓库结构、插件约定、打包安装、测试与发版流程。

> Nday 模式的整体方案、当前进展、rc.2/桌面端待做项见 [Nday 模式开发交接](./nday-development-handoff.md)。

## 仓库结构

```text
Saker/
├── preset/
│   ├── pentest/                  # 渗透测试模式：persona、playbook、参考资料
│   ├── code-audit/               # 代码审计模式：persona、playbook、规则集
│   └── shared/refs/              # 随包 PayloadsAllTheThings 快照（MIT）
├── shared/
│   ├── skills/                   # 两个专业模式共享的协作与复核技能（6 个）
│   ├── refs/                     # 共享参考资料
│   └── scripts/                  # 工具面辅助脚本
├── plugins/                      # 24 个独立功能插件
├── scripts/                      # 全量打包（pack-all）与桌面安装（install-desktop）
├── lib/preset-root.js            # 模式注册入口
├── cordis.patch.yml              # bundle 加载配置
├── docs/                         # 使用文档、功能说明、发布说明
│   ├── images/                   # 功能截图（15 张）+ 首页拼图与生成脚本
│   └── release-v*.md             # 各版本发布说明
├── core-patches/                 # 可选的宿主品牌与鉴权改动说明
└── THIRD_PARTY_NOTICES.md        # 第三方内容许可声明
```

`dsh-saker` 根包的发布文件不包含 `plugins/` 和 `core-patches/`。Saker 可直接使用；不应用可选宿主补丁时，界面保留 dsh 原有品牌和登录行为。

## 插件约定

每个插件是独立 bundle，各有自己的 README、`package.json` 和 `lib/`，互不依赖。

发布插件改动时**必须更新 `package.json` 的版本号**。桌面开发验证使用不可变摘要产物：`install-desktop.mjs` 对每次打包内容生成独立文件依赖并校验安装字节，因此同版本开发包的内容变动也会重新安装。发布仍须按版本管理，不能用开发验证的摘要代替正式版本。

插件目录结构：

```text
plugins/dsh-<名字>/
├── package.json          # name / version / files 白名单
├── README.md             # 配置、边界、验证方式
├── lib/
│   ├── index.js          # 宿主侧：注册工具、RPC、服务
│   └── client.js         # 客户端侧：设置页界面（可选）
└── test/run.mjs          # 离线测试（可选）
```

> 版本较新的 dsh 对插件运行时上下文有破坏性变更（例如 `connection` 服务的注入项与路由注册归属）。
> **这类变更静态 API 差分发现不了，必须在真实宿主上实跑。** 详见 [发布说明](./release-v0.2.5.md)。

## 打包与安装

```bash
node scripts/pack-all.mjs        # 生成根模式包和 24 个插件包
node scripts/install-desktop.mjs --desktop-dir "C:/path/to/DeepSeek Harness"
```

可用环境变量：

| 变量 | 用途 |
|---|---|
| `DSH_DESKTOP_DIR` | 官方 Windows 桌面安装目录；可代替 `--desktop-dir` |
| `DSH_HOME` | 覆盖配置目录 |

当前验证基线为官方桌面端 0.2.0-rc.2。先打开应用初始化 desktop profile，再完全退出后安装。安装器校验版本及运行进程，调用应用随附的 CLI 完成整套插件事务，并比对安装后的文件字节；不得通过 npm CLI 或直接编辑 profile 管理桌面插件。`install-all.mjs` 仅保留显式自定义 legacy profile 支持，不再用于网页端或桌面端安装。

> **发布前 `pack-all` 和 `install-desktop` 都要跑。**
> 曾经出现 `pack-all` 22/22 全绿、而安装阶段必崩的情况（变量声明被上一行的注释吞掉）。
> 打包通过 ≠ 装得上，这是两道工序。

## 测试

当前完整回归包含 61 套测试（套件及断言数以运行结果为准）。跑单个插件：

```bash
cd plugins/<插件目录>
node --import ../../scripts/test-stub-register.mjs test/run.mjs
```

`test-stub-register.mjs` 是统一测试桩，负责解析宿主的裸包名与 `@dsh-external/*` 子路径导出。
**不套桩会直接 `ERR_MODULE_NOT_FOUND`**——早期部分套件无法运行，就是因为缺它。

跑全部：

```bash
node scripts/run-all-tests.mjs
```

完整入口还包含根包、交付、共享上下文、任务策略、方法包及桌面专项，并把失败写入退出码。部分套件需要本机装有对应程序（如 `php`）才能跑回路烟测，缺失时会显式 `skip`。

## 发版

1. 升 `package.json` 版本号（根包与有改动的插件）
2. 补齐 `docs/release-vX.Y.Z.md`，README 徽章同步版本
3. 提交，打**附注 tag**：`git tag -a vX.Y.Z -m "…"`
4. 推分支与 tag：`git push origin HEAD:main && git push origin vX.Y.Z`
5. 在 GitHub 建 Release，正文直接取 `docs/release-vX.Y.Z.md`

发布说明按「适配 / 修复 / 性能」分块写，附验证环境与验收基线。
**未实跑的项一律标注「未验证」**，不要用静态结论冒充实测结果。
