---
name: ctf-playbook
description: CTF 解题作战手册：flag 纪律、通用开局、六题型（Web/Pwn/Reverse/Crypto/Misc/Forensics）第一动作与推进路径、工具手册、卡点与换路规则、多路并行分工、未解题交接留痕。目标是把 flag 拿到并证明，不是出报告。
tools: curl, python3, pwntools, gdb, objdump, strings, file, binwalk, exiftool, zsteg, sqlmap, ffuf, gobuster, hashcat, john, nc, socat, openssl
---

# CTF 解题作战手册

> 本技能随 ctf-solver 预设走。
> persona 中的硬规则（flag 纪律、破坏性边界、卡点规则、负面清单）不在此重复。
> 与 pentest-playbook 的分工：那个讲"怎么把漏洞证到位并出报告"，这个讲"怎么最快拿到 flag"。

## 目录（按需定位，不必从前往后读）

| 章节 | 讲什么 | 什么时候读 |
|---|---|---|
| flag 处置 | 格式识别、原文照录、不自动提交 | 拿到可疑串时 |
| 通用开局 | 每题开工前 5 分钟的标准动作 | 每题开工 |
| Web 题 | 源码/端点/注入/上传/反序列化 | Web 题 |
| Pwn 题 | 保护识别/原语定位/利用链 | Pwn 题 |
| Reverse 题 | 静态优先/动态兜底/flag 校验定位 | Reverse 题 |
| Crypto 题 | 构造识别/已知弱点/数学攻击 | Crypto 题 |
| Misc & Forensics | 文件类型/元数据/隐写/流量/内存 | Misc 题 |
| 工具手册 | 常用工具与参数速查 | 调用某个工具前 |
| 卡点与换路 | N 条路失败后的处置 | 卡住时 |
| 多路并行 | 子代理分工建议 | 题量大或卡死时 |
| 交接留痕 | 未解题的留痕格式 | 收尾/换人 |

---

## flag 处置

**识别**：平台会在题目描述里声明 flag 格式。常见 `flag{...}`、`CTF{...}`、`DASCTF{...}`、`SCTF{...}`，
也有平台用自定义前缀或纯哈希。**以题目声明的格式为准**，不要凭"看起来像"就下结论。

**照录**：拿到后**逐字节原样报出**。大小写、下划线、连字符、花括号、末尾空格都可能算错。
不要"整理格式"、不要补全、不要去掉前后缀——除非题目明确说只提交花括号内内容。

**验证**：
- Web 题：从响应体/数据库回显/环境变量里直接读到的，原样即 flag。
- Pwn/Reverse：从程序输出里抓的，注意区分**真 flag** 与 `fake_flag{...}` 诱饵（很常见）。
- Crypto：解出的明文可能就是 flag，也可能是 flag 的编码形式（base64/hex/rot13）——先按题面要求的编码试一次。

**不自动提交**：不向任何平台自动提交 flag。拿到后告知用户，由用户决定。

**记录**：每解出一题即刻调 `redteam_finding_register` 登记（title=题名、severity=info、target=题目标识、
summary=flag 原文与解题路径、type=CTF），复现脚本或截图路径写进 poc 字段。**不要等全部解完再补登记**。

---

## 通用开局

拿到一道题的**前 5 分钟**标准动作（顺序不要颠倒）：

1. **读题面**：题型、附件、连接信息、flag 格式、分值、已解人数（解出人数多 = 常规套路，少 = 需要巧思）。
2. **拿附件**：`file <附件>` 看真实类型（扩展名常骗人）；压缩包先看注释与文件名编码（中文乱码可能是 GBK）。
3. **连服务**：`nc host port` 先手工交互一次，看 banner、提示、交互模式（菜单/裸协议）。
4. **看流量**（如果给了 pcap）：`strings` 先捞关键字，再 `tshark -r x.pcap -Y http` 过滤。
5. **定第一动作**：按题型章节走（下面各节的第一行就是"第一动作"）。

**开工同时**：如果这题的思路可能有 2 条以上独立路线，**现在就登记进方向层**
（`campaign_idea_open`），比如"路线 A：SQLi 直接读；路线 B：上传绕过后读"。卡住时不用重新想。

---

## Web 题

**第一动作**：`robots.txt` / `.git/` / `.svn/` / `www.zip` / `index.php.bak` / `~index.php`
——**先捡源码**，有源码的 Web 题难度直接降一档。

**源码到手后**（这是 Web 题最高产的一步）：
```bash
# 从 JS bundle 提取路由与接口
grep -oE '"/[a-zA-Z0-9_/.-]+"' app.js | sort -u
# 找敏感逻辑：签名、加密、校验、硬编码
grep -nE 'sign|md5|sha|secret|key|token|admin|flag' app.js
```
- 前端校验 = 没有校验（直接改请求）。
- 找到签名算法 → 本地复现签名 → 伪造任意请求。

**注入面**（按成功率排序）：
- **SQLi**：先手工确认（`'` 报错、`and 1=1` / `and 1=2` 差异、`sleep(3)` 时延），再上 `sqlmap`。
  过滤绕过优先试：`/**/`、大小写、`%0a`、双写、`||`（SQLite/Oracle）、`||` vs `+`（MySQL 要空格）。
- **SSTI**：`{{7*7}}` → 49 就是模板注入。Python 系走 `{{config}}` / `{{''.__class__}}` 链；
  Twig/Jinja 的 payload 不通用，先确定引擎（报错信息里通常有）。
- **LFI**：`../../etc/passwd` 起步；被过滤就试 `....//`、`%2e%2e/`、绝对路径、
  php filter（`php://filter/convert.base64-encode/resource=index.php` 读源码比 `data://` 稳）。
- **SSRF**：`http://127.0.0.1/`、`http://[::1]/`、十进制 IP（`2130706433`）、
  302 跳转、`file://`、gopher（打内网 Redis/MySQL 时有用）。
- **反序列化**：PHP 看 `unserialize`/`__wakeup`/`__destruct`；Java 看 `readObject` 与常见链
  （`ysoserial`）；Python 看 `pickle.loads`。**先确认能不能控制输入进入反序列化点**，再谈链。

**文件上传**：先确认**黑名单还是白名单**。
- 黑名单绕过：`.phtml` `.php5` `.php%00.jpg`（老版本）、`.jpg.php`、大小写 `.PHP`、
  `.htaccess` 自定义解析。
- 白名单绕过：配合解析漏洞（Apache 多后缀、Nginx `%00`/`/1.jpg/x.php`）。
- **上传成功后必须记录确切路径**（`/upload/xxx.php`），这是复现的关键。

**命令执行**：确认 `whoami` 能执行就够；CTF 环境可以直接读 flag（`cat /flag`、`cat /flag*`）。
常见命令：`cat${IFS}/flag`、`c\at /flag`、`$(cat</flag)`（过滤空格/关键字时）。

---

## Pwn 题

**第一动作**：`checksec ./chall`（或 `pwn checksec`）——保护决定路线。

| 保护 | 意味着 |
|---|---|
| NX off | 可以直接往栈上写 shellcode |
| Canary | 溢出前需要泄露 canary（格式化字符串 / `puts` 越读） |
| PIE | 需要先泄露一个代码地址 |
| RELRO full | 不能改 GOT，改 `__malloc_hook`/`__free_hook` 或 fsop |

**定位原语**：
```bash
file ./chall && strings -a ./chall | head -50
objdump -d ./chall | less   # 或 IDA/Ghidra
```
常见：栈溢出（找 ret 与 buf 距离）、格式化字符串（找用户可控的 printf 第一参数）、
UAF/堆溢出（看 malloc/free 序列）、整数溢出（size 计算）。

**利用链**（按保护组合）：
- 无 canary 无 PIE 有 NX：`ret2libc`（泄露 libc 基址 → system("/bin/sh")）。
- 有 canary：先 leak，再构造 payload 前带上 canary。
- 有 PIE：先 leak 代码地址，算基址。
- 堆题：确定 libc 版本（`./libc.so.6` 用 `strings libc.so.6 | grep version` 或 libc-database）再选 gadget。

**常用骨架**：
```python
from pwn import *
context(log_level='debug', arch='amd64', os='linux')
p = remote('host', 1337)        # 或 process('./chall')
elf = ELF('./chall'); libc = ELF('./libc.so.6')
# 交互、泄露、构造 payload...
p.interactive()
```

**注意**：pwn 题的 flag 通常在**靶机上的 `/flag`**，拿到 shell 后直接 `cat /flag`。
如果题目要求"读文件"而不是"拿 shell"，`open/read/write` 的 ROP 链比 shell 更稳。

---

## Reverse 题

**第一动作**：`file` + `strings` —— 有 1/3 的简单题 flag 直接躺在 strings 里（或一眼看出是 rot13/base64）。

**静态优先**：
```bash
strings -a -n 6 ./chall | grep -iE 'flag|ctf|\{'
objdump -d -M intel ./chall | less
# 有 IDA/Ghidra 就用；没有时用 rabin2 辅助
```
- 找**字符串比较**或**逐字符校验**：程序通常会构造期望值再和输入比对。
- 找 `strcmp`/`memcmp`/自写的循环异或 —— 这是最典型的 flag 校验。
- .NET/Java/Go：`.NET` 用 `dnSpy` 思路（`strings` + IL 反编译）、Java 用 `jd-gui`、
  Go 用 `strings` 捞 `/main.` 附近。

**动态兜底**（静态卡住时）：
```bash
gdb ./chall
b *main+0x...        # 断在比较点
r                    # 输入任意字符串
x/s $rdi / $rsi      # 看两边比什么
```
- `ltrace`/`strace` 能直接看出调了哪些库函数、参数是什么。
- 有反调试/自修改代码时，先 patch 掉反调试（`nop` 掉 ptrace 检查）。

**混淆处理**：加壳先脱（`upx -d`）；控制流平坦化就跟着状态机走；
**别陷在还原上**——能通过动态打断点拿到期望值，就不需要完全理解算法。

---

## Crypto 题

**第一动作**：看给了什么（公钥/密文/nonce/参数），**识别构造**再谈攻击。

| 现象 | 攻击 |
|---|---|
| RSA 小 e（3/5/17），密文短 | 直接开 e 次方根（`gmpy2.iroot`） |
| 两次 RSA 共享 n，不同 e | 共模攻击（扩展欧几里得） |
| 同一 nonce 加密两条消息（AES-CTR/流密码） | 异或两条密文得明文异或，已知一段即解全部 |
| ECB 模式且明文可控 | 字节翻转 / 分块重排（实现"加密成管理员"） |
| CBC 且能看错误 | padding oracle |
| 已知部分明文（crib） | 异或直接出密钥流 |
| 参数小（n 只有几百位） | `factordb` / `yafu` / `sage` 分解 |
| 广播（同 m，多组 n,e） | Håstad 广播攻击 |

**工具**：
```bash
python3 -c "from gmpy2 import iroot; print(iroot(c, 3))"
# RsaCtfTool（有就先用）：python3 RsaCtfTool.py --publickey pub.pem --uncipherfile flag.enc
# 对称：判断分组模式（ECB 看密文块是否重复）
```
**编码**必须先剥：base64/base32/hex/rot13/url/摩斯，CyberChef 思路走一遍再进密码学。
**"看起来很乱但长度是 16 的倍数"** → 先怀疑 AES/分组密码；"长度和明文一样" → 流密码/异或。

---

## Misc & Forensics

**第一动作**：`file` + `exiftool` + `binwalk` —— 90% 的 Misc 题在这一步就有线索。

**文件类**：
- `file` 判真实类型（扩展名骗人）→ `binwalk -e` 拆嵌套（zip/png 里藏 zip）
- `exiftool` 看元数据（作者、注释、GPS）
- `zsteg`/`stegsolve` 看 LSB 隐写（PNG/BMP）
- `steghide extract -sf x.jpg`（JPEG，可能要口令）
- 压缩包：`zip2john` 拿 hash → `john`/`hashcat` 爆；伪加密（改 flag 位）、CRC 碰撞、
  明文攻击（已知一部份明文）
- 音频：看频谱（`audacity`）、`sox` 看波形、DTMF/摩斯

**流量类（pcap）**：
```bash
tshark -r x.pcap -Y http -T fields -e http.request.uri -e http.file_data
tshark -r x.pcap -Y 'tcp.stream eq 0' -T fields -e data.text
# 导出对象：文件→导出HTTP对象（wireshark GUI），或 binwalk 直接拆 pcap
```
**USB 流量**（HID）：提取 `usb.capdata` 后按 HID 键码表还原按键（注意 8 字节格式与偏移）。

**内存镜像**：`volatility3` —— `windows.pslist` → `windows.filescan` → `windows.dumpfiles`；
`strings` 先捞 flag 关键字是最快的。

**编码与杂项**：进制转换、盲文、二维码（`zbarimg`）、条形码、图片长宽被改（修复 IHDR 的宽高）、
像素点取色（Python + PIL 读 RGB 序列）、零宽字符（`\u200b` 类）。

---

## 工具手册

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `file` / `binwalk` | 真实类型 / 嵌套拆分 | `binwalk -e`（提取）、`-Me`（递归） |
| `strings` | 捞可见串 | `-a -n 6`（全部、最短 6） |
| `exiftool` | 元数据 | 直接跟文件 |
| `zsteg` / `steghide` | 图片隐写 | `zsteg -a`；`steghide extract -sf` |
| `tshark` | 流量过滤 | `-Y` 过滤、`-T fields -e` 取字段 |
| `sqlmap` | SQLi 自动化 | `-r req.txt -p param --batch --dbs` |
| `ffuf` / `gobuster` | 目录爆破 | `-w dict -u URL/FUZZ`、`-x php,html,bak` |
| `hashcat` / `john` | 口令破解 | 先 `*2john` 提取 hash，再 `-m` 指定类型 |
| `gdb` + pwndbg | 动态调试 | `b`、`r`、`x/s`、`vmmap` |
| `objdump` / `rabin2` | 反汇编 | `-d -M intel` |
| `pwntools` | Pwn 利用 | `remote`/`process`/`ELF`/`ROP` |
| `nc` / `socat` | 连服务 | `nc host port` |
| `hashcat --identify` | 认 hash 类型 | 不确定时先跑这个 |

**字典**：目录爆破用 `common.txt`（SecLists）起步，跑空再上大字典；
**不要一上来就上大字典**——CTF 的路径通常是可猜的词（admin/flag/backup/source）。

---

## 卡点与换路

**默认规则**（persona 里也写了）：同一题 **3 条独立路径**都失败 → 换题或换思路。

**3 条路径怎么算独立**：改一个 payload 参数不算；换个漏洞类、换个入口、换个假设才算。

**卡住时的固定动作**：
1. **回题面**：重读一遍——80% 的卡点是因为漏看了题面里的提示（附件名、描述里的双关、分值）。
2. **查方向层**：`campaign_idea_list` 看开工时登记的其他路线，挑一条走。
3. **查记忆**：`campaign_memory_search` 搜同题型/同平台——历史套路可能直接给答案。
4. **换工具**：手工卡住就上自动化（sqlmap/ffuf），自动化卡住就回手工（看源码找逻辑洞）。
5. **降维**：不会的题先放着，把会的做完。**总分最大化比单题死磕重要**。

**明确不要做的事**：
- 不要在没有新信息的情况下重复试同一类 payload。
- 不要在还没看源码的情况下就上自动化工具。
- 不要在 Reverse 上追求完全还原算法（能拿到期望值就够）。

---

## 多路并行

CTF 是天然适合并行的场景。建议分工：

- **按题型分**：一个子代理负责 Web，另一个负责 Crypto —— 互不干扰，各自推进。
- **按思路分**（同一题）：路线 A 做 SQLi，路线 B 做上传绕过 —— 谁先通谁报。
- **按阶段分**：一个做静态分析出结论，另一个验证结论。

工具：`subagent` / `subagent_fork` 起独立子代理；`workflow` 做流水线（如批量爆破 + 结果解析）。

**并行时的纪律**：
- 每条路线**先登记方向**（`campaign_idea_open`），避免两条路线撞车或重复劳动。
- 子代理的结论**必须有原始输出**（命令 + 回显），不采信无证据的结论。
- 拿到 flag 后**立即上报并登记**，不要等其他路线跑完。

---

## 交接留痕

**未解出的题也要留痕**——这是换人或下一场最值钱的资产。格式：

```markdown
### 题名（题型，分值）
- 状态：未解出 / 部分（拿到 flag1，flag2 未拿）
- 试过的路径：
  1. 路径 A：做了什么、结果是什么（报错/无回显/被拦）
  2. 路径 B：同上
  3. 路径 C：同上
- 卡点判断：为什么失败（过滤规则猜到了什么程度、哪个假设没验证）
- 下一步建议：最值得试的方向（含具体命令）
- 附件/脚本：脚本路径、抓包文件路径
```

**同时登记方向层**：把"值得试但没试成"的路径 `campaign_idea_open` 登记（附依据），
下一场开局 `campaign_idea_list` 就能直接接上。
