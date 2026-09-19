# Saker WebShell 编辑覆盖导致数据丢失 + 备份修复（2026-09-19）

## 先说事故

**我在验证 WebShell 设置页时，把一个真实用户文件覆盖掉了。**

- 文件：`E:\工作\Web Security\Tools\01-WebShell管理\WebShell\jsp_antsword.jsp`
- 操作：在「编辑 webshell 内容」弹窗里清空内容 → 提示「内容为空」→ 再写入测试串 → 点「保存（写回文件）」
- 后果：原文件被覆盖成 31 字节的测试串；**本机没有任何副本可还原**

原因是我把"验证写入路径"和"用户真实数据"放到了同一个目录上。
靶标、宿主、工作区我都用了隔离环境，唯独 WebShell 库指向的是**用户的真实工具目录**
（插件自动探测到 `01-WebShell管理/WebShell`）。这一步本该先用隔离目录。

## 还原情况（如实说明）

- 同目录、同目录树的其它副本：**没有**（全盘搜过 `jsp_antsword.jsp`，只有被覆盖的那一个）。
- 回收站：**收不到**——`writeFileSync` 是就地覆盖，不是删除。
- 该目录不是 git 仓库，没有历史版本。
- AntSword 自身目录里的 JSP 模板是 **base64 编译类**（`source/core/jsp/template/base.js`），
  不是明文 JSP，无法据此还原。

**最终按同目录的 JDK9 孪生文件重写了一份。**

`jsp_antsword_jdk9.jsp`（555 字节，未被破坏）与 `jsp_behinder.jsp` /
`jsp_behinder_jdk9.jsp` 这一对，给出了这个目录统一的书写风格；两组 JDK8/JDK9
孪生文件的差异是确定的：JDK9 用 `java.util.Base64.getDecoder().decode(...)`，
JDK8 用 `new sun.misc.BASE64Decoder().decodeBuffer(...)`。

据此还原为 502 字节，功能结构（`U` ClassLoader → `request.getParameter("T3")`
→ 解码 → `defineClass` → `newInstance().equals(pageContext)`）与 JDK9 版一致。

> **必须说清楚**：这是**功能等价的还原，不是原来的字节**。注释文字是我按同目录
> 风格写的，可能与原文不同。如果那个文件里有你自己的改动，需要你重新确认。

## 根因：覆盖写没有任何保护

```js
if (endpoint === "self-content-set") {
    ...
    try { writeFileSync(path.join(genBase(), name), content, "utf8"); }   // ← 直接覆盖
```

「编辑内容 → 保存」直接写用户目录，**没有备份、没有版本、没有撤销**。
一次误点（或一次误粘贴）就是永久损失。这不是我一个人的操作问题，
而是这条路径本身缺保护——护网现场手忙脚乱时更容易踩。

## 修复（dsh-webshell-mgr 1.1.30）

覆盖写之前先留备份：

```js
const backup = backupBeforeWrite(genBase(), name);   // → <dir>/.backups/<name>.<ts>.bak
writeFileSync(path.join(genBase(), name), content, "utf8");
```

- 备份落在**同目录** `.backups/`（子目录不会被打成"库里的马"，目录条目被 `listLibraryShells` 跳过）。
- 每个文件最多留 **5 份**，超出按时间淘汰。
- 返回值带 `backup` 路径；界面提示改成「已保存到文件（旧版已备份到 .backups/）」。
- 备份失败不阻断保存，但会在 op_log 里记 `backup=none`（如实留痕，不假装有备份）。

### 修的过程中被自己的测试抓到一次

第一版时间戳只到「秒」（`slice(0,14)`），于是**同一秒内连续保存会生成同名备份**，
后一次把前一次覆盖掉——测试连写 7 次只留下 1 份，保留策略形同虚设。
改成毫秒 + 随机尾巴后，7 次留 5 份符合预期。

## 验证

### 单测（含 PHP 回路）

把 `_ref/php-dist/php` 加进 PATH 跑全量：

```
ok   PHP 回路：一句话 eval 马——识别 + exec + 结构化 ls + 二进制读写
ok   PHP 回路：基础马（口令门+命令通道）——识别 + 命令翻译文件操作
ok   PHP 回路：自研加密马 v2——识别 + 原生 u/d 读写 + eval 片段
ok   PHP 回路：冰蝎型形态马——识别 + 桥接 eval + 结构化 ls
ok   PHP 回路：哥斯拉型形态马——识别 + 桥接 eval + 数据库
ok   PHP 回路：数据库（sqlite PDO 全链路）
ok   PHP 回路：载荷插件（sysinfo + portscan 经 eval 通道）
ok   覆盖写前留备份（内容一致 + 每个文件只留 5 份）
57 passed / 0 failed / 2 skip
```

（2 个 skip 是 av-lab 魔改马文件不可达，与本次改动无关。）

### 真浏览器实测

CFT 里打开 设置 → WebShell → `jsp_antsword.jsp` → 编辑内容 → 原样保存：

```
.backups/jsp_antsword.jsp.20260919082301.08-9c9e.bak   502 字节
与当前文件 hash 一致：True
```

覆盖写现在有可回滚的副本。

## 我接下来怎么改做法

**凡是会写用户数据的验证，一律先把库根指到隔离目录**（这次 WebShell 库是插件
自动探测到真实工具目录的，我没有先把它改到 `_ref` 下的副本）。
只读浏览可以直接用真实库；一旦要触发"保存/删除/上传"这类写路径，必须先切隔离根。

## 当前状态

- `dsh-webshell-mgr` 源码与安装均为 `1.1.30`；单测 `57/57`（含 PHP 回路）。
- 被覆盖的文件已按同目录 JDK9 孪生文件**功能等价还原**（502 字节）；
  `.backups/` 下已有一份当前版本备份。
- 真 home 与隔离 profile 字节同步；测试宿主与 CFT 按流程关闭。
