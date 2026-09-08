# dsh-skill-browse

**技能浏览、上传安装与引用**——设置页「技能」面板，把当前可见的技能摊开，并支持直接装进用户层。

## 它解决什么

技能散在三处（随包共享、随模式、用户自己装的），平时看不到全貌，想装一个新的又要手动解压到 `$DSH_HOME/skills`。本插件只做两件事：**看**和**装**。

## 三层数据源

| 层 | 位置 | 说明 |
|---|---|---|
| `shared` | `dsh-saker` 根包 `shared/skills/` | 两种模式共享的协作与复核技能 |
| `preset` | `dsh-saker` 根包 `preset/<mode>/skills/` | 当前模式专属技能（随所选模式变化） |
| `user` | `$DSH_HOME/skills/` | 你自己安装的技能，可卸载 |

同名时按 `shared` → `preset` → `user` 的顺序去重，先出现的胜出——与宿主 `skill-filesystem` 的遮蔽语义一致。

数据源解析用 `createRequire` 沿 `node_modules` 向上找 `dsh-saker/package.json`，所以插件装在 profile 里也能读到根包内容；只装了本插件、没装 `dsh-saker` 时，`shared` / `preset` 两段为空，只剩 `user`。

## 安装与卸载

**安装**：上传 `.zip` / `.tgz` / `.tar.gz`（≤32MB，base64 传输）。压缩包需要满足其一：

- 一个目录，内含 `SKILL.md`（可带同目录资源，会一起复制）
- 一个顶层 `<name>.md`（平铺式）

`SKILL.md` 必须有合法 frontmatter（`name` + `description`），`name` 为小写 kebab-case。落盘后由宿主 `skill-filesystem` 的 watcher 热载，**无需重启**。

**撞名保护**：如果 `name` 与随包技能重名，会被上层遮蔽而失效，插件会直接拒绝并提示改名。

**卸载**：仅限 `user` 层。目录式删 `$DSH_HOME/skills/<name>/`，平铺式删 `<name>.md`。

## 调用语义

本插件不发明新语法，沿用宿主既有约定：

- **模型侧**：会话开始时 `tool-skill` 注入 `<available_skills>` 目录，模型调 `skill` 工具按名加载正文。
- **用户侧**：输入框打 `/` 触发宿主 `ui-skill` 候选，选 `/<name>` 注入当轮。

面板提供一键复制真实引用串 `/<name>`。

## 配置

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enable` | boolean | `true` | 关闭后不注册面板 |
| `dshHome` | string | `''` | 覆盖 `$DSH_HOME`；为空时用 `~/.dsh`（仅在环境变量未设置时生效） |

## 边界

- 只写用户层，不动随包技能；随包技能要改请改 `dsh-saker` 包。
- 压缩包解压在临时目录完成，先只读探测再落盘，失败会清理临时目录。
- 不校验技能内容的安全性——技能正文会进入模型上下文，装之前请自己看一眼。
