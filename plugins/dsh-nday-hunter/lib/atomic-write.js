// 整文件替换要「先写同目录临时文件，再换名」。
//
// 为什么：直接 writeFileSync 会先截断目标再写。写入中途失败（盘满、进程被杀、
// 断电）会留下半个 JSON，下次读的时候解析失败 —— 用户的筛选策略或攻击进度就
// 凭空消失了。同目录 tmp + rename 让替换要么整体生效、要么目标保持原样。
//
// 边界：这只保证「文件不被写坏」。并发两个写者的丢失更新需要锁，本文件不解决，
// 不要在别处把它当成互斥手段。
import nodeFs from 'node:fs'
import path from 'node:path'

let sequence = 0

/**
 * 原子替换整文件内容。
 * @param {string} file 目标路径（父目录必须已存在）
 * @param {string|Buffer} data 完整内容
 * @param {{ fs?: object, encoding?: string }} [options] 注入点只服务测试
 * @returns {string} 目标路径
 */
export function writeFileAtomicSync(file, data, options = {}) {
  const io = options.fs ?? nodeFs
  const encoding = options.encoding ?? 'utf8'
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${sequence++}.tmp`)
  try {
    io.writeFileSync(temporary, data, encoding)
    io.renameSync(temporary, file)
  } catch (error) {
    try { io.unlinkSync(temporary) } catch { /* 临时文件可能根本没建起来 */ }
    throw error
  }
  return file
}
