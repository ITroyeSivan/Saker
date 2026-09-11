# 开发与发布

仓库结构、插件约定、打包安装、测试与发版流程。

## 仓库结构

```text
Saker/
├── preset/
│   ├── pentest/                  # 渗透测试模式：persona、playbook、参考资料
│   ├── code-audit/               # 代码审计模式：persona、playbook、规则集
│   └── shared/refs/              # 随包 PayloadsAllTheThings 快照（MIT）
├── shared/
│   ├── skills/                   # 两种模式共享的协作与复核技能（6 个）
│   ├── refs/                     # 共享参考资料
│   └── scripts/                  # 工具面辅助脚本
├── plugins/                      # 21 个独立功能插件
├── scripts/                      # 全量打包（pack-all）与安装（install-all）
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

改插件代码时**必须同时升 `package.json` 的版本号**。`install-all.mjs` 按版本号跳过同版本包——
不升版本 = 不重装 = 改动静默不生效。这是本项目最容易踩的坑，改完请核对一次。

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
node scripts/pack-all.mjs        # 生成根模式包和 21 个插件包
node scripts/install-all.mjs     # 装进 dsh 的 web profile
```

可用环境变量：

| 变量 | 用途 |
|---|---|
| `SAKER_PROFILE` | 指定安装到哪个 profile，默认 `web` |
| `DSH_CLI` | `dsh` 不在 PATH 时，指向 CLI 入口（如源码树的 `apps/cli/lib/bin.js`） |
| `DSH_HOME` | 覆盖配置目录 |

脚本会跳过已安装的同版本包、自动升级更高版本，并清理因重新打包而失效的旧 `file:` 依赖，可安全重复执行。

> **发布前 `pack-all` 和 `install-all` 都要跑。**
> 曾经出现 `pack-all` 22/22 全绿、而安装阶段必崩的情况（变量声明被上一行的注释吞掉）。
> 打包通过 ≠ 装得上，这是两道工序。

## 测试

15 套插件测试，968 条断言。跑单个插件：

```bash
cd plugins/<插件目录>
node --import ../../scripts/test-stub-register.mjs test/run.mjs
```

`test-stub-register.mjs` 是统一测试桩，负责解析宿主的裸包名与 `@dsh-external/*` 子路径导出。
**不套桩会直接 `ERR_MODULE_NOT_FOUND`**——早期 15 套里只有 4 套能跑，就是因为缺它。

跑全部：

```bash
for d in plugins/*/; do
  [ -f "$d/test/run.mjs" ] || continue
  ( cd "$d" && node --import ../../scripts/test-stub-register.mjs test/run.mjs )
done
```

多数套件需要本机装有对应程序（如 `php`）才能跑回路烟测，缺失时会显式 `skip` 而不是假装通过。

## 发版

1. 升 `package.json` 版本号（根包与有改动的插件）
2. 补齐 `docs/release-vX.Y.Z.md`，README 徽章同步版本
3. 提交，打**附注 tag**：`git tag -a vX.Y.Z -m "…"`
4. 推分支与 tag：`git push origin HEAD:main && git push origin vX.Y.Z`
5. 在 GitHub 建 Release，正文直接取 `docs/release-vX.Y.Z.md`

发布说明按「适配 / 修复 / 性能」分块写，附验证环境与验收基线。
**未实跑的项一律标注「未验证」**，不要用静态结论冒充实测结果。
