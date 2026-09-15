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

export const READ_ACCEPT = '.txt,.md,.doc,.docx'

export const EXPORT_FORMATS = [
  { id: 'txt', label: 'TXT 纯文本', ext: 'txt', mime: 'text/plain' },
  { id: 'md', label: 'Markdown', ext: 'md', mime: 'text/markdown' },
  { id: 'doc', label: 'DOC（Word 兼容）', ext: 'doc', mime: 'application/msword' },
  { id: 'docx', label: 'DOCX（Word）', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
]

// 取小写扩展名（不含点）；无扩展名返回 ''
export function extOf(filename = '') {
  const m = String(filename).toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

// 剥离末尾扩展名，得到基础名（用于展示 / 拼导出名）
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

// .docx（ArrayBuffer）→ 纯文本
export async function docxToText(arrayBuffer) {
  const mammoth = await loadMammoth()
  const res = await mammoth.extractRawText({ arrayBuffer })
  return String(res?.value ?? '').replace(/\r\n/g, '\n')
}

// 读取用户选择的文档文件 → 纯文本。支持 txt/md/docx；doc 抛错提示转存。
export async function readDocumentFile(file) {
  const ext = extOf(file?.name)
  if (ext === 'doc') {
    throw new Error('老式 .doc（二进制格式）无法在浏览器内可靠解析。请先用 Word / WPS 将其另存为 .docx，再重新导入。')
  }
  if (ext === 'docx') {
    const buf = await file.arrayBuffer()
    return await docxToText(buf)
  }
  // txt / md / 其他一律按纯文本读
  return await file.text()
}

// 纯文本 → .docx（Blob）。逐行成段，保留空行；docx 库产出标准 OOXML。
export async function textToDocxBlob(text) {
  const { Document, Packer, Paragraph, TextRun } = await import('docx')
  const lines = String(text ?? '').split(/\r?\n/)
  const children = lines.map((line) => new Paragraph({ children: [new TextRun({ text: line })] }))
  const doc = new Document({ sections: [{ children }] })
  return await Packer.toBlob(doc)
}

// 纯文本 → Word 兼容 HTML 字符串（存成 .doc，Word / WPS 可直接打开）。零依赖。
export function textToDocHtml(text) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => `<p style="margin:0 0 6pt 0;line-height:1.7;">${esc(l) || '&nbsp;'}</p>`)
    .join('')
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>novel-export</title><!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]--></head><body>${body}</body></html>`
}

function triggerDownload(filename, blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// 统一导出入口：按 format 组装 Blob 并触发下载，返回实际使用的文件名。
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
  triggerDownload(filename, blob)
  return filename
}
