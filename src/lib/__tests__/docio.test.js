import { describe, it, expect } from 'vitest'
import { baseName, extOf, buildExportName, textToDocHtml, textToDocxBlob, docxToText } from '../docio.js'

describe('docio 文件名工具', () => {
  it('剥离扩展名 / 取扩展名（大小写无关）', () => {
    expect(baseName('我的小说.docx')).toBe('我的小说')
    expect(baseName('a.b.txt')).toBe('a.b')
    expect(extOf('NOVEL.DOC')).toBe('doc')
    expect(extOf('novel.docx')).toBe('docx')
    expect(extOf('无扩展名')).toBe('')
  })

  it('导出名始终区别于导入名（追加 -续写全文 后缀）', () => {
    const exp = buildExportName('我的小说.docx', 'docx')
    expect(exp).toBe('我的小说-续写全文.docx')
    expect(exp).not.toBe('我的小说.docx')
    // 各种格式都带对应扩展名
    expect(buildExportName('x', 'txt')).toBe('x-续写全文.txt')
    expect(buildExportName('x', 'md')).toBe('x-续写全文.md')
    expect(buildExportName('x', 'doc')).toBe('x-续写全文.doc')
    // 空 base 回退
    expect(buildExportName('', 'docx')).toBe('续写原文-续写全文.docx')
  })
})

describe('docio .doc HTML 导出', () => {
  it('逐行成段并转义 HTML 特殊字符', () => {
    const html = textToDocHtml('第一行\n第二行 <b>&"引号"')
    expect(html).toContain('<p')
    expect(html).toContain('第一行')
    expect(html).toContain('&lt;b&gt;')
    expect(html).toContain('&amp;')
    // 不应出现未转义的裸 <b>
    expect(html).not.toContain('<b>')
    expect(html).toContain('xmlns:w="urn:schemas-microsoft-com:office:word"')
  })
})

describe('docio .docx 读写往返', () => {
  it('纯文本 → docx → 纯文本，正文内容零丢失（含全角空格与引号）', async () => {
    const text = '第一章 起因\n\n　　夜色如墨，风声鹤唳。\n　　他推开门，走了进去。\n\n“你是谁？”对方问道。'
    const blob = await textToDocxBlob(text)
    expect(blob.size).toBeGreaterThan(0)
    const ab = await blob.arrayBuffer()
    const back = await docxToText(ab)
    // mammoth extractRawText 以 \n\n 分段（空行数会变），但正文逐行内容必须完整、按序保留
    const lines = (s) => s.split(/\n/).map((x) => x.trim()).filter(Boolean)
    expect(lines(back)).toEqual(lines(text))
    // 关键字符不丢：全角空格缩进与中文引号
    expect(back).toContain('夜色如墨，风声鹤唳。')
    expect(back).toContain('“你是谁？”')
  })
})
