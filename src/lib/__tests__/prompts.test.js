// prompts.js 回归网（方案甲步骤2）：钉住续写删文风块、禁用词接线、sanitizeHabits 幂等、analyzeAssetsMessages 段格式。
// 只测现有代码、不改 src。
import { describe, it, expect } from 'vitest'
import {
  continueMessages, followupMessages, incorporateReviseMessages, versionMessages,
  sanitizeHabits, analyzeAssetsMessages, ASSET_TYPE_WORDS,
} from '../prompts.js'
import { typeKeyOf } from '../assets.js'

const sys = (m) => m[0].content
const FB = ['测试禁词甲', '测试禁词乙']

describe('禁用词接线（H11：续写三路径消费 forbidden，数据驱动空即 0 字）', () => {
  it('continueMessages 传 forbidden → system 含禁用词块', () => {
    expect(sys(continueMessages({ text: 'x', forbidden: FB, index: 0 }))).toContain('测试禁词甲')
  })
  it('followupMessages 传 forbidden → system 含禁用词块', () => {
    expect(sys(followupMessages({ text: 'x', forbidden: FB, index: 0 }))).toContain('测试禁词乙')
  })
  it('incorporateReviseMessages 传 forbidden → system 含禁用词块', () => {
    expect(sys(incorporateReviseMessages({ text: 'x', note: 'y', forbidden: FB }))).toContain('测试禁词甲')
  })
  it('不传/空 forbidden → 不含禁用词块（0 字，不违方案E删文风块）', () => {
    expect(sys(continueMessages({ text: 'x', index: 0 }))).not.toContain('自定义禁用词')
    expect(sys(continueMessages({ text: 'x', forbidden: [], index: 0 }))).not.toContain('自定义禁用词')
  })
})

describe('续写删文风块（方案E：styleSkinBlockOf 仅 versionMessages 消费）', () => {
  it('continueMessages 不注入文风档案块、改用「参照原文风格」', () => {
    const s = sys(continueMessages({ text: 'x', style: 'PROF档案XYZ', habits: ['习惯A'], index: 0 }))
    expect(s).not.toContain('PROF档案XYZ')
    expect(s).toContain('参照上方原文')
  })
  it('followupMessages 同样不注入文风档案块', () => {
    expect(sys(followupMessages({ text: 'x', style: 'PROF档案XYZ', index: 0 }))).not.toContain('PROF档案XYZ')
  })
  it('incorporateReviseMessages 不注入文风档案块（系统规则3已含保持原有文风）', () => {
    expect(sys(incorporateReviseMessages({ text: 'x', note: 'y', style: 'PROF档案XYZ' }))).not.toContain('PROF档案XYZ')
  })
  it('versionMessages（改写页）仍注入文风档案块', () => {
    expect(sys(versionMessages({ text: 'x', style: 'PROF档案XYZ', habits: ['h'], index: 0 }))).toContain('PROF档案XYZ')
  })
})

describe('sanitizeHabits（M9 幂等 + 否定式豁免）', () => {
  it('含「逗号」的 habit 不重补尾注（幂等判据认逗号，不只认顿号）', () => {
    expect(sanitizeHabits(['偶用以逗号分隔的同类意象罗列造势']).patched).toBe(0)
  })
  it('否定式提及（不连成无标点字串）豁免剔除', () => {
    const r = sanitizeHabits(['把句子不连成无标点字串'])
    expect(r.removed).toBe(0)
    expect(r.habits).toHaveLength(1)
  })
  it('肯定式要求省标点（写成无标点长串）被剔除', () => {
    const r = sanitizeHabits(['把句子写成无标点长串'])
    expect(r.removed).toBe(1)
    expect(r.habits).toHaveLength(0)
  })
  it('返回 removed/patched/shortened/requoted 计数 + flagged', () => {
    const r = sanitizeHabits(['正常习惯一条'])
    expect(r).toMatchObject({ removed: 0, patched: 0, shortened: 0, requoted: 0, flagged: false })
  })
})

describe('analyzeAssetsMessages（资产库分析提示词：四段+伏笔推进、口语化、状态变更不含持有）', () => {
  const s = sys(analyzeAssetsMessages({ roster: [], source: 'x', chapterNo: 1 }))
  it('产出五段标题', () => {
    for (const h of ['【已有资产更新】', '【新资产】', '【状态变更】', '【资产流转】', '【伏笔推进】']) expect(s).toContain(h)
  })
  it('【状态变更】维度不含「持有」（持有归【资产流转】，决策#1）、含心理/身份社会', () => {
    const dimLine = s.match(/【状态变更】[^\n]*/)[0]
    expect(dimLine).not.toContain('持有')
    expect(dimLine).toContain('心理')
    expect(dimLine).toContain('身份社会')
  })
  it('【资产流转】四选一（获得/失去/损坏/消耗）', () => {
    expect(s).toContain('获得/失去/损坏/消耗')
  })
  it('任务③：【资产流转】带资产类型列、【新资产】类型列同为七类词表（单一出处 ASSET_TYPE_WORDS）', () => {
    const words = ASSET_TYPE_WORDS.join('/')
    expect(ASSET_TYPE_WORDS).toEqual(['人物', '群像', '势力', '地点', '道具', '功法', '灵兽'])
    const flowLine = s.match(/^【资产流转】[^\n]*/m)[0]
    expect(flowLine).toContain('资产类型')
    expect(flowLine).toContain(words)
    expect(s.match(/^【新资产】[^\n]*/m)[0]).toContain(words)
    expect(s).toContain('每个资产都标出它属于哪一类')
  })
  it('类型词表里每个词都能被 assets.js typeKeyOf 归一到 7 个英文 key（提示词用词与落库枚举对得上）', () => {
    expect(ASSET_TYPE_WORDS.map((w) => typeKeyOf(w))).toEqual(['person', 'group', 'faction', 'place', 'item', 'skill', 'beast'])
  })
  it('roster 接受数组或字符串、user 消息含章号+原文', () => {
    const u1 = analyzeAssetsMessages({ roster: [{ name: '陆沉', type: 'person', detail: 'd' }], source: '原文XYZ', chapterNo: 45 })[1].content
    expect(u1).toContain('陆沉')
    expect(u1).toContain('原文XYZ')
    expect(u1).toContain('45')
    const u2 = analyzeAssetsMessages({ roster: '张三(person)：路人', source: 'x', chapterNo: 1 })[1].content
    expect(u2).toContain('张三')
  })
})
