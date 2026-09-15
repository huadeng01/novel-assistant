import { Document, Packer, Paragraph, TextRun } from 'docx'
import mammothMain from 'mammoth'
import mammothBrowser from 'mammoth/mammoth.browser.js'

const text = '第一章 起因\n\n　　夜色如墨，风声鹤唳。\n　　他推开门，走了进去。\n\n“你是谁？”对方问道。\nSpecial: & < > "quotes"'
const children = text.split(/\n/).map((l) => new Paragraph({ children: [new TextRun({ text: l })] }))
const doc = new Document({ sections: [{ children }] })

const buf = await Packer.toBuffer(doc)
const blob = await Packer.toBlob(doc)
console.log('BYTES=' + buf.length, 'BLOB_SIZE=' + blob.size, 'BLOB_TYPE=' + blob.type)

// 主入口读
const r1 = await mammothMain.extractRawText({ buffer: buf })
console.log('MAIN_ROUND=' + JSON.stringify(r1.value))

// 浏览器版读（用 arrayBuffer）
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
const r2 = await (mammothBrowser.default || mammothBrowser).extractRawText({ arrayBuffer: ab })
console.log('BROWSER_ROUND=' + JSON.stringify(r2.value))
console.log('MSG=' + JSON.stringify(r1.messages))
