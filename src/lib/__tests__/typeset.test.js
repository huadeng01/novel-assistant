// 成稿排版层单测：治「长篇章节写作无缩进、且无换行」。
// 两条根因分别对应两个函数：
//   ① formatNovelParagraphs —— 正文的主工作面是 <textarea>，CSS 的 text-indent 只对块级元素首行生效，
//      textarea 里每行都是首行，做不出中文小说的两字缩进；所以把排版落到字符层（段间空行 + 行首 U+3000×2）。
//   ② dedupeRepeatedClauses —— 旧实现用 kept.map(c => c.s).join('') 重组，而 clause 正则只吃单个换行，
//      段间空行不属于任何 clause，一旦删了东西就顺带把所有换行吞掉，成稿变成一整块字墙。改为按原文坐标删。
import { describe, it, expect } from 'vitest'
import { formatNovelParagraphs, dedupeRepeatedClauses } from '../longform.js'
import { countWords } from '../utils.js'

const IND = '\u3000\u3000'

describe('formatNovelParagraphs · 段间空行 + 行首两格全角缩进', () => {
  it('单换行连排的段落被拆成空行分段，且每段行首补两个全角空格', () => {
    const { text, flagged } = formatNovelParagraphs('他推开门。\n屋里没人。\n灯还亮着。')
    expect(flagged).toBe(true)
    expect(text).toBe(`${IND}他推开门。\n\n${IND}屋里没人。\n\n${IND}灯还亮着。`)
  })

  it('已经排好版的正文再跑一次结果不变（幂等，可安全放在生成/保存/展示三处）', () => {
    const once = formatNovelParagraphs('第一段。\n第二段。').text
    const twice = formatNovelParagraphs(once)
    expect(twice.text).toBe(once)
    expect(twice.flagged).toBe(false)
  })

  it('不叠加缩进：行首已有的全角/半角空白先剥掉再补两格', () => {
    const { text } = formatNovelParagraphs(`${IND}已缩进。\n    半角缩进。\n\t制表缩进。`)
    expect(text).toBe(`${IND}已缩进。\n\n${IND}半角缩进。\n\n${IND}制表缩进。`)
  })

  it('多余的连续换行收敛成一个空行，不留三行以上的大洞', () => {
    const { text } = formatNovelParagraphs('甲。\n\n\n\n乙。')
    expect(text).toBe(`${IND}甲。\n\n${IND}乙。`)
  })

  it('只动空白字符，字数口径与去重口径都不受影响', () => {
    const raw = '他握着剑站在山门口。\n雨下了整整一夜。\n没有人来。'
    expect(countWords(formatNovelParagraphs(raw).text)).toBe(countWords(raw))
  })

  it('空串与纯空白原样返回，不产出孤零零的缩进', () => {
    expect(formatNovelParagraphs('').text).toBe('')
    expect(formatNovelParagraphs('').flagged).toBe(false)
    expect(formatNovelParagraphs('   \n  ').text).toBe('   \n  ')
  })
})

describe('dedupeRepeatedClauses · 删重复时不得吞掉段间换行', () => {
  // 第二次出现的这句与首次出现完全一致，归一化后 18 字且公共子串占满整句 → 命中 dominate 判据被删
  const DUP = '他握着那柄锈剑站在山门口，久久没有说话。'
  const raw = ['第一段写点别的，把开篇的环境交代清楚。', DUP, '', '第二段开头。', DUP, '第二段结尾另起一笔。'].join('\n')

  it('命中重复并删掉后一处', () => {
    const r = dedupeRepeatedClauses(raw)
    expect(r.flagged).toBe(true)
    expect(r.removedCount).toBe(1)
    expect(r.text.split(DUP).length - 1).toBe(1) // 只保留最先出现的一处
  })

  it('段与段之间的空行原样保留（旧实现 join("") 重组会把它吃掉，成稿变字墙）', () => {
    const { text } = dedupeRepeatedClauses(raw)
    // clause 正则只吃到句末标点、不含后面的换行，所以删掉句中重复项后换行全部原位保留
    expect(text).toBe(['第一段写点别的，把开篇的环境交代清楚。', DUP, '', '第二段开头。', '', '第二段结尾另起一笔。'].join('\n'))
    expect(text).toContain('\n\n')
    // 回归护栏：旧实现重组出来的成稿一个换行都没有，整章压成一整块
    expect((text.match(/\n/g) || []).length).toBeGreaterThanOrEqual(2)
    expect(text.split('\n').filter((l) => l.trim())).toHaveLength(4) // 删的是段内的一句，不是把整章压成一块
  })

  it('没有重复时原样返回，不做任何重排', () => {
    const clean = '甲说了一句话。\n\n乙答了另一句。\n\n丙没有开口。'
    const r = dedupeRepeatedClauses(clean)
    expect(r.flagged).toBe(false)
    expect(r.text).toBe(clean)
  })
})
