// 续写提示词的「锚点顺序」契约测试。
// 治的 bug：用户点「纳入原文」把新写的续写并进原文后，再点「自定义续写」/「探索后续版本」，
// 模型吐出来的还是上一次的内容 —— 非得重跑一次「分析原文」刷新 timeline/outline 才正常。
// 根因不在 state（generate/generateFollowup 确实实时读 text），而在提示词拼接顺序：
// 旧版把 ctx（世界观/人物卡/大纲/故事线）拼在 ${text} 之后，故事线还标着「原文已写到的情节，续写紧接其后」，
// 于是它成了 user 消息里最后一段实质内容，模型就近把它当成续写起点，而它停在「分析原文」那一刻。
// 修法：背景资料一律前置，原文收尾（紧邻任务行）。以下断言把这个顺序钉死，防止回退。
import { describe, it, expect } from 'vitest'
import { continueMessages, followupMessages, incorporateReviseMessages, CONTINUE_ANGLES, FOLLOWUP_ANGLES } from '../prompts.js'

const OLD_TEXT = '第一章的原文，主角刚离开村子。'
const NEW_TEXT = `${OLD_TEXT}\n\n第二章主角已经进了京城，站在城门下。`
// 分析时点的故事线：只记录到第一章，天然滞后于 NEW_TEXT
const TIMELINE = [{ stage: '起因', summary: '主角离开村子' }]

const base = {
  text: NEW_TEXT,
  summary: '前文摘要正文',
  world: '世界观正文',
  characters: '人物卡正文',
  outline: '大纲正文',
  timeline: TIMELINE,
  style: '',
  habits: [],
  forbidden: [],
  instruction: '让主角在京城遇到旧识',
}

// 所有背景资料块的标签，用来断言它们全部落在原文之前
const CTX_TAGS = ['【用户续写指令', '【前文摘要', '【世界观设定', '【人物卡', '【故事大纲', '【已有故事线']
const TEXT_HEAD = '以下是小说原文'

describe('continueMessages · 原文收尾、背景资料前置', () => {
  const [sys, user] = continueMessages({ ...base, index: 0 })
  const u = user.content

  it('user 消息里原文出现在每一个背景资料块之后', () => {
    const ti = u.indexOf(TEXT_HEAD)
    expect(ti).toBeGreaterThan(0)
    for (const tag of CTX_TAGS) {
      const bi = u.indexOf(tag)
      if (bi === -1) continue // 该块没提供时不出现，跳过
      expect(bi, `${tag} 必须在原文之前`).toBeLessThan(ti)
    }
  })

  it('原文之后只剩任务行，不再跟任何背景资料块', () => {
    const tail = u.slice(u.indexOf(TEXT_HEAD))
    expect(tail).not.toContain('【')
    expect(tail.endsWith(`请以「${CONTINUE_ANGLES[0].title}」的要求，紧接上面原文的结尾续写。`)).toBe(true)
  })

  it('原文用的是最新那份（含纳入后的第二章），不是分析时点的旧结尾', () => {
    expect(u).toContain('主角已经进了京城')
    // 最新的结尾必须比滞后的故事线更靠后，模型才会就近取它当起点
    expect(u.indexOf('主角已经进了京城')).toBeGreaterThan(u.indexOf('【已有故事线'))
  })

  it('不再出现把旧故事线抬成起点的措辞', () => {
    expect(u).not.toContain('续写紧接其后')
    expect(u).not.toContain('原文已写到的情节，续写紧接')
  })

  it('故事线/大纲被明确降级为「仅作参考、可能滞后」', () => {
    expect(u).toContain('情节进展以原文结尾为准')
    expect(u).toContain('【故事大纲（用户提供，仅作参考；可能滞后于下方原文）】')
  })

  it('system 段把「续写起点只有一个」立为规则 1，且编号 1-7 连续无跳号', () => {
    expect(sys.content).toContain('1. 续写起点只有一个：下方原文的最后一句')
    expect(sys.content).toContain('2. 背景资料')
    for (let n = 1; n <= 7; n++) expect(sys.content, `缺规则 ${n}`).toContain(`\n${n}. `)
    expect(sys.content).not.toContain('\n8. ')
  })

  it('没有任何背景资料时，user 消息直接以原文开头，不留前导空行', () => {
    const [, bare] = continueMessages({ text: NEW_TEXT, index: 1 })
    expect(bare.content.startsWith(TEXT_HEAD)).toBe(true)
    expect(bare.content).not.toContain('\n\n\n')
  })

  it('用户续写指令排在所有背景资料的最前面（最高优先级）', () => {
    expect(u.indexOf('【用户续写指令')).toBeLessThan(u.indexOf('【前文摘要'))
    expect(u.indexOf('【用户续写指令')).toBeLessThan(u.indexOf('【已有故事线'))
  })
})

describe('followupMessages · 与自定义续写同构', () => {
  const [sys, user] = followupMessages({ ...base, index: 2 })
  const u = user.content

  it('原文收尾，背景资料全部前置', () => {
    const ti = u.indexOf(TEXT_HEAD)
    for (const tag of CTX_TAGS) {
      const bi = u.indexOf(tag)
      if (bi === -1) continue
      expect(bi, `${tag} 必须在原文之前`).toBeLessThan(ti)
    }
    const tail = u.slice(ti)
    expect(tail).not.toContain('【')
    expect(tail.endsWith(`请以「${FOLLOWUP_ANGLES[2].title}」的剧情走向，紧接上面原文的结尾续写。`)).toBe(true)
  })

  it('同样不含误导措辞、同样声明故事线可能滞后', () => {
    expect(u).not.toContain('续写紧接其后')
    expect(u).toContain('情节进展以原文结尾为准')
  })

  it('system 段规则 1-7 连续，且首条即锚点约束', () => {
    expect(sys.content).toContain('1. 续写起点只有一个')
    for (let n = 1; n <= 7; n++) expect(sys.content, `缺规则 ${n}`).toContain(`\n${n}. `)
    expect(sys.content).not.toContain('\n8. ')
  })

  it('index 越界时回落到第一个版本，不抛错', () => {
    const [, fb] = followupMessages({ ...base, index: 99 })
    expect(fb.content).toContain(FOLLOWUP_ANGLES[0].title)
  })
})

// 「纳入原文」弹窗里的定向修订：不是续写而是就地改写，所以待修订正文必须收尾、修改想法必须前置且标为最高优先级。
describe('incorporateReviseMessages · 待修订正文收尾、修改想法前置', () => {
  const DRAFT = '待纳入的这段正文，结尾停在主角推门那一刻。'
  const [sys, user] = incorporateReviseMessages({
    context: '原文结尾：主角站在门外，雨还没停。',
    text: DRAFT,
    note: '把结尾那句对话改冷淡一点',
    style: '',
    habits: [],
    forbidden: [],
  })
  const u = user.content

  it('待修订正文排在所有背景块之后，且后面只剩任务行', () => {
    const ti = u.indexOf('【待修订正文】')
    expect(ti).toBeGreaterThan(u.indexOf('【上文语境'))
    expect(ti).toBeGreaterThan(u.indexOf('【修改想法'))
    expect(u.slice(u.indexOf(DRAFT) + DRAFT.length)).not.toContain('【')
  })

  it('system 段钉死「只改想法指到的地方」，防止顺手重写整段', () => {
    expect(sys.content).toContain('1. 只改想法明确指到的地方')
    expect(sys.content).toContain('严禁顺手润色')
    expect(sys.content).toContain('直接输出修订后的完整正文')
  })

  it('上文语境标明只供衔接、不得被改写', () => {
    expect(u).toContain('仅供保持连贯，不要改写它')
    expect(u).toContain('主角站在门外')
  })

  it('没给上文语境 / 没给修改想法时，对应块整块不出现，也不留多余空行', () => {
    const bare = incorporateReviseMessages({ text: DRAFT, note: '' })[1].content
    expect(bare).not.toContain('【上文语境')
    expect(bare).not.toContain('【修改想法')
    expect(bare.startsWith('【待修订正文】')).toBe(true)
    expect(bare).not.toContain('\n\n\n')
  })
})
