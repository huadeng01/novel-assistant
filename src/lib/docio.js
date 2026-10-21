// 文档读写工具：书库导入与续写页导入/导出共用。纯前端，无后端。
//
// 读取（readDocumentFile）：
//   · .txt / .md      —— 直接按纯文本读；
//   · .docx           —— 用 mammoth 浏览器版抽取纯文本（保留段落换行）；
//   · .doc（老式二进制）—— 浏览器内无法可靠解析，明确抛错并提示转存 .docx（见方案 Q1）。
//
// 导出（exportDocument）：四种格式
//   · .txt / .md      —— 纯文本 Blob；
//   · .docx           —— 用 docx 库生成标准 OOXML（Word / WPS / LibreOffice 均可打开）；
//   · .doc            —— 生成 Word 兼容 HTML 并以 .doc 落盘（Word / WPS 可直接打开，零额外依赖）。
//
// 依赖 mammoth / docx 均按需 dynamic import，会被 Vite 拆成独立 chunk，不进主包、不影响首屏。
import { downloadBlob } from './utils.js' // L(尾批)：下载逻辑单一出处——原 docio.triggerDownload 与 utils.downloadText 各写一份逐字相同的下载逻辑，已合并到 utils.downloadBlob

export const READ_ACCEPT = '.txt,.md,.doc,.docx'

export const EXPORT_FORMATS = [
  { id: 'txt', label: 'TXT 纯文本', ext: 'txt', mime: 'text/plain' },
  { id: 'md', label: 'Markdown', ext: 'md', mime: 'text/markdown' },
  { id: 'doc', label: 'DOC（Word 兼容）', ext: 'doc', mime: 'application/msword' },
  { id: 'docx', label: 'DOCX（Word）', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
]

export function extOf(filename = '') {
  const m = String(filename).toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

export function baseName(filename = '') {
  return String(filename).replace(/\.[a-z0-9]+$/i, '').trim()
}

// 生成导出文件名：始终追加 -{suffix}，保证与导入文件名不同（避免覆盖用户导入的原文件）。
// base 为空时回退到「续写原文」。
export function buildExportName(base, format, { suffix = '续写全文' } = {}) {
  const f = EXPORT_FORMATS.find((x) => x.id === format) || EXPORT_FORMATS[0]
  const stem = baseName(base) || '续写原文'
  return `${stem}-${suffix}.${f.ext}`
}

let _mammoth = null
async function loadMammoth() {
  if (_mammoth) return _mammoth
  // 浏览器专用打包版：自包含，不拉入 Node polyfill；按需加载不进主包
  const mod = await import('mammoth/mammoth.browser.js')
  _mammoth = mod.default || mod
  return _mammoth
}

export async function docxToText(arrayBuffer) {
  const mammoth = await loadMammoth()
  const res = await mammoth.extractRawText({ arrayBuffer })
  return String(res?.value ?? '').replace(/\r\n/g, '\n')
}

// item10（第十轮）：解码后乱码探测——gbk 兜底对**非 GBK 编码**会解出「有字数的乱码」，绕过 useBooks「少于100字」检查进 IDB 喂 AI（item41 想防的形态换个编码复活）。
//   统计 U+FFFD 替换符 + C0 控制符（除 \t\n\r）占比：全空 或 >10% 判解码失败。真 GBK 文件解码干净（占比 ~0），不误伤。
//   ✅ 能拦：UTF-16LE/BE→gbk 夹大量 \u0000 等 C0 控制符（node 实测 bad 占比 ~19% > 10%）→ 抛编码错误。
//   ⚪ 已知且**接受**的产品范围外限制（非 bug、勿再 flag）：Big5 / Shift-JIS→gbk 解出的是**错位汉字**（如 Big5「測試」字节 → gbk 解成「代刚」），
//     U+FFFD/控制符占比 ~0% → 绕过本探测、返回可见乱码。【产品决策（用户 2026-10-20）：产品场景 = 简体中文，UTF-8 + GBK 已覆盖用户全部导入需求；
//     Big5（繁中）/ Shift-JIS（日文）不在范围内，故不做自动编码识别。且此类乱码是**可见**的（用户导入后立即在原文框看到错字，非静默损坏既有数据），
//     用户可自行另存为 UTF-8/GBK 重导——危害可控、接受、不修。】decodeLooksBroken 的判据/阈值刻意不动（启发式识别繁中/日文误判真实 GBK 的代价更高）。
const decodeLooksBroken = (s) => {
  const t = String(s || '')
  if (!t.replace(/\s/g, '')) return true // 全空/全空白：没解出有效内容
  let bad = 0
  for (const ch of t) {
    const c = ch.codePointAt(0)
    if (c === 0xfffd || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d)) bad += 1
  }
  return bad / t.length > 0.1
}

export async function readDocumentFile(file) {
  // item12：file 为空时下面 file.arrayBuffer()/file.text() 会抛「Cannot read properties of undefined」——extOf 用了 file?.name 可选链，
  //   但读取处没兜底。统一在入口判空给人话错误。
  if (!file) throw new Error('未选择文件，请重新选择要导入的文档。')
  const ext = extOf(file.name)
  if (ext === 'doc') {
    throw new Error('老式 .doc（二进制格式）无法在浏览器内可靠解析。请先用 Word / WPS 将其另存为 .docx，再重新导入。')
  }
  if (ext === 'docx') {
    const buf = await file.arrayBuffer()
    const text = await docxToText(buf)
    // item13：docx 损坏 / 正文是图片扫描件时 mammoth 抽取出空串，原样返回会让下游误报「内容太少」（用户以为文档短，实为解析失败）。
    //   给准确的解析错误，别把解析失败伪装成「太短」。
    if (!text.trim()) throw new Error('这份 .docx 解析不出正文，可能已损坏，或正文是图片/扫描件。请确认文档含可选中的文字，或另存为 .txt 后重试。')
    return text
  }
  // txt / md / 其他一律按纯文本读
  // item41/C41：原 `await file.text()` 一律按 UTF-8 解码——GBK/GB2312 编码的网文 .txt（国内下载常见）会解成整本乱码，
  //   乱码照样有字符数 → 绕过 useBooks「少于100字」检查、进 IDB 喂给 AI。改为先按 UTF-8 fatal 解码：
  //   合法 UTF-8 正常返回；含非法字节序列（fatal 抛错）= 大概率 GBK，fallback 到 gbk 解码。TextDecoder 的 'gbk' 标签浏览器原生支持、零依赖。
  // item10（第十轮）：gbk fallback 后再过 decodeLooksBroken 乱码探测——控制符占比高的非 GBK 编码（UTF-16LE/BE）据实报编码错误而非静默入库。
  //   ⚪ 已知且接受的范围外限制（非 bug）：Big5/Shift-JIS→gbk 是错位汉字、坏字占比 ~0%，拦不住、返回可见乱码——产品场景=简体中文，UTF-8+GBK 已覆盖，用户 2026-10-20 裁定不做自动识别（详见 decodeLooksBroken 注释与 docio.test）。
  const buf = await file.arrayBuffer()
  // 1) UTF-8 fatal：合法 UTF-8 直接返回（绝大多数情况）
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    /* 含非法 UTF-8 字节 → 往下走 GBK 兜底 */
  }
  // 2) GBK 兜底（覆盖 GB2312/GBK 网文）；极少数浏览器不支持 gbk 标签（构造抛 RangeError）→ text=null
  let text = null
  try {
    text = new TextDecoder('gbk').decode(buf)
  } catch {
    text = null
  }
  // 3) gbk 不可用时退回非 fatal UTF-8（非法字节替换为 U+FFFD，至少不整本抛错中断导入）
  if (text == null) text = new TextDecoder('utf-8').decode(buf)
  // item10：解码结果控制符/替换符超阈（如 UTF-16LE/BE 的错位 + \u0000）→ 明确报编码错误，不静默入库喂 AI。
  //   注：Big5/Shift-JIS 的错位汉字坏字占比低、走不到这个 throw（返回可见乱码）= 已知且接受的范围外限制（产品场景=简体中文，用户 2026-10-20 裁定不修），故错误文案不声称覆盖 Big5（避免误导）。
  if (decodeLooksBroken(text)) {
    throw new Error('无法识别文件编码：不是 UTF-8，按 GBK 解码也是乱码（可能是 UTF-16 等编码）。请用记事本或 Word 另存为 UTF-8（或 GBK）编码的 .txt 后重新导入。')
  }
  return text
}

export async function textToDocxBlob(text) {
  const { Document, Packer, Paragraph, TextRun } = await import('docx')
  const lines = String(text ?? '').split(/\r?\n/)
  const children = lines.map((line) => new Paragraph({ children: [new TextRun({ text: line })] }))
  const doc = new Document({ sections: [{ children }] })
  return await Packer.toBlob(doc)
}

export function textToDocHtml(text) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => `<p style="margin:0 0 6pt 0;line-height:1.7;">${esc(l) || '&nbsp;'}</p>`)
    .join('')
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>novel-export</title><!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]--></head><body>${body}</body></html>`
}

export async function exportDocument(base, text, format = 'txt', { suffix } = {}) {
  const f = EXPORT_FORMATS.find((x) => x.id === format) || EXPORT_FORMATS[0]
  const filename = buildExportName(base, f.id, { suffix })
  let blob
  if (f.id === 'docx') {
    blob = await textToDocxBlob(text)
  } else if (f.id === 'doc') {
    blob = new Blob(['\ufeff', textToDocHtml(text)], { type: `${f.mime};charset=utf-8` })
  } else {
    // txt / md：原文即纯文本，直接落盘（保留完整原文，不注入额外标题）
    blob = new Blob([String(text ?? '')], { type: `${f.mime};charset=utf-8` })
  }
  downloadBlob(filename, blob)
  return filename
}
