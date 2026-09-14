// 详纲链路单测：本章详纲取值降级、详纲确定性解析（含降级为 null）、细纲驱动模式的两个上下文精简选项
// 全部是纯函数，零 AI 调用、零 Token；测的是「精简分支只在显式开启时生效，关闭时逐字节等同改造前」这条回归基线。
import { describe, it, expect } from 'vitest'
import {
  newProject,
  outlineForChapter,
  detailOutlineFor,
  parseDetailScenes,
  buildWorldBlockText,
  volumeStrategyText,
} from '../longform.js'

// 一份符合 prompts.chapterOutlineDetailMessages 产出格式的详纲样本（章头行 + [标签] 行）
const DETAIL = [
  '第12章【承】夜访旧档',
  '[任务] 林昭潜入档案库，找到母亲失踪当夜的出入记录',
  '[场景1] 城西档案库/林昭、老周 → 林昭借旧身份牌混入，老周在门口望风 → 拿到编号甲七的出入册',
  '[场景2] 档案库地下室/林昭 → 册页缺了当夜那一页，撕口是新的 → 林昭意识到有人先来过',
  '[场景3] 巷口茶馆/林昭、苏晚 → 苏晚递来一份抄本 → 抄本上盖着钦天监的火漆',
  '[边界] 本章允许揭示：出入册缺页；本章严禁触及：母亲仍然活着（属第30章）',
  '[钩子] 火漆印的图案与林昭腕上的胎记一模一样',
  '[字数] 2000（场景1:700 / 场景2:700 / 场景3:600）',
].join('\n')

// 测试用书：人物 + 世界手册（一块规则、一块地点设定、一块无关设定）+ 卷档案 + 长线伏笔
const makeBook = () => {
  const p = newProject('测试书')
  p.chapterWords = 2000
  p.characters = [
    { uid: 'c1', name: '林昭', aliases: '阿昭', identity: '主角', status: '灵力余量 3 成；随身 1 枚身份牌' },
    { uid: 'c2', name: '老周', aliases: '', identity: '档案库守夜人', status: '' },
    { uid: 'c3', name: '苏晚', aliases: '苏姑娘', identity: '抄书人', status: '' },
    { uid: 'c4', name: '路人甲', aliases: '', identity: '不出场', status: '' },
  ]
  p.worldBlocks = [
    { id: 'b1', name: '修行铁律', aliases: '', kind: '规则', content: '夺舍者遭天谴，寿元折半。' },
    { id: 'b2', name: '档案库', aliases: '城西档案库', kind: '设定', content: '一座三层木楼，夜里只有守夜人。' },
    { id: 'b3', name: '钦天监', aliases: '', kind: '设定', content: '朝廷监察修士的机构，本章不该出现。' },
  ]
  p.volumes = [
    {
      id: 'v1', volumeNo: 1, name: '青阳风起', startChapter: 1, length: 20,
      strategy: '本卷写主角在县城站稳脚跟。',
      arcStory: '林昭追查母亲失踪的旧案。',
      theme: '执念', conflict: '个人与体制', gain: '得到第一枚身份牌',
      endHook: '档案库走水，出入册下落不明',
      location: '青阳县', arc: '起1-5 承6-12 转13-17 合18-20', emotion: '压抑到爆发',
      forbiddenForeshadowIds: ['f1'], unlockLayer: 1,
    },
    { id: 'v2', volumeNo: 2, name: '东玄州', startChapter: 21, length: 20, strategy: '第二卷战略。', arcStory: '闯东玄州。', endHook: '卷二钩子' },
  ]
  p.foreshadows = [
    { id: 'f1', content: '母亲的玉佩其实是钦天监的通行令', status: '未回收' },
    { id: 'f2', content: '老周欠下的人情', status: '未回收' },
  ]
  p.bible = {
    mapLayers: [
      { id: 'm1', name: '青阳县', summary: '开局之地，一座县城。', rumor: '', truth: '', unlockVolume: 1 },
      { id: 'm2', name: '东玄州', summary: '中期舞台。', rumor: '传闻中的大州', truth: '东玄州地底镇压着一条真龙', unlockVolume: 2 },
      { id: 'm3', name: '天阙', summary: '终局舞台。', rumor: '天上的城', truth: '天阙是当年屠神的战场', unlockVolume: 3 },
    ],
  }
  return p
}

describe('detailOutlineFor 本章详纲取值', () => {
  it('有详纲时返回详纲原文', () => {
    const p = makeBook()
    p.outlineDetail = { 12: DETAIL }
    expect(detailOutlineFor(p, 12)).toBe(DETAIL)
  })

  it('无详纲时降级到精简地图的本章切片（旧书行为完全不变）', () => {
    const p = makeBook()
    p.outline = ['第11章【承】旧案', '林昭翻检旧卷宗。', '', '第12章【承】夜访', '林昭夜访档案库。', '', '第13章【转】走水', '档案库起火。'].join('\n')
    p.outlineDetail = {}
    const got = detailOutlineFor(p, 12)
    expect(got).toContain('第12章【承】夜访')
    expect(got).toContain('林昭夜访档案库。')
    // windowSize=1：只给本章，不能把第 13 章带进上下文（那正是节奏提前的来源）
    expect(got).not.toContain('第13章')
    expect(got).not.toContain('档案库起火。')
  })

  it('详纲是空白串时同样降级（防止把空上下文喂给写章）', () => {
    const p = makeBook()
    p.outline = '第12章【承】夜访\n林昭夜访档案库。'
    p.outlineDetail = { 12: '   \n  ' }
    expect(detailOutlineFor(p, 12)).toContain('林昭夜访档案库。')
  })

  it('newProject 出厂就带 outlineDetail 与 outlineDriven，且驱动开关默认关闭', () => {
    const p = newProject('新书')
    expect(p.outlineDetail).toEqual({})
    expect(p.outlineDriven).toBe(false)
  })
})

describe('outlineForChapter 窗口边界（防后续章纲夹带）', () => {
  // 这段是回归护栏：outlineForChapter 原先末块右边界取 lines.length，导致 windowSize 形同虚设——
  // 写第 12 章时上下文里摊着第 12 章到全书结尾的所有章纲。detailOutlineFor 的降级路径（windowSize=1）首当其冲。
  const OUTLINE = [
    '第11章【承】旧案', '林昭翻检旧卷宗。', '',
    '第12章【承】夜访', '林昭夜访档案库。', '',
    '第13章【转】走水', '档案库起火。', '',
    '第14章【转】灰烬', '林昭在灰烬里捡到半枚玉佩。', '',
    '第15章【合】对峙', '林昭与老周对峙。',
  ].join('\n')

  it('windowSize=1 严格只给本章，后续章一个字都不带', () => {
    const got = outlineForChapter(OUTLINE, 12, 1)
    expect(got).toContain('林昭夜访档案库。')
    for (const leak of ['第11章', '第13章', '第14章', '第15章', '档案库起火。', '半枚玉佩']) {
      expect(got, 'windowSize=1 不应夹带 ' + leak).not.toContain(leak)
    }
  })

  it('windowSize=3 给本章及后两章，第三章之后仍然不带', () => {
    const got = outlineForChapter(OUTLINE, 12, 3)
    expect(got).toContain('第12章')
    expect(got).toContain('第13章')
    expect(got).toContain('第14章')
    expect(got).not.toContain('第15章')
    expect(got).not.toContain('与老周对峙')
    expect(got).not.toContain('第11章')
  })

  it('最后一章没有后继章头，右边界落到文本末尾且不抛异常', () => {
    const got = outlineForChapter(OUTLINE, 15, 1)
    expect(got).toContain('林昭与老周对峙。')
    expect(got).not.toContain('第14章')
  })

  it('细纲未覆盖本章时返回空串而不是全量（防止长细纲撞爆上下文）', () => {
    expect(outlineForChapter(OUTLINE, 99, 1)).toBe('')
  })

  it('识别不出章号时降级全量注入（短细纲场景）', () => {
    expect(outlineForChapter('一段没有章头的短细纲。', 1, 1)).toBe('一段没有章头的短细纲。')
  })

  it('空细纲返回空串', () => {
    expect(outlineForChapter('', 1, 1)).toBe('')
    expect(outlineForChapter(null, 1, 1)).toBe('')
  })

  it('detailOutlineFor 的降级路径继承同一窗口口径', () => {
    const p = makeBook()
    p.outline = OUTLINE
    const got = detailOutlineFor(p, 12)
    expect(got).toBe(outlineForChapter(OUTLINE, 12, 1))
    expect(got).not.toContain('第13章')
  })
})

describe('parseDetailScenes 详纲确定性解析', () => {
  it('结构化详纲解析出 3 个场景，与详纲切分完全对齐', () => {
    const r = parseDetailScenes(DETAIL, makeBook(), 12)
    expect(r).not.toBeNull()
    expect(r.fromDetail).toBe(true)
    expect(r.scenes).toHaveLength(3)
    // proposals 固定为空：细纲驱动模式下重大分支已在详纲生成阶段由作者确认过（该模式的设计前提）
    expect(r.proposals).toEqual([])
  })

  it('任务 / 边界 / 钩子三项按标签取出，字数行不当作场景', () => {
    const r = parseDetailScenes(DETAIL, makeBook(), 12)
    expect(r.task).toBe('林昭潜入档案库，找到母亲失踪当夜的出入记录')
    expect(r.boundary).toContain('本章严禁触及：母亲仍然活着（属第30章）')
    expect(r.hook).toBe('火漆印的图案与林昭腕上的胎记一模一样')
    expect(r.scenes.every((s) => !s.summary.includes('2000'))).toBe(true)
  })

  it('三段式场景行拆成 enter / advance / exit，summary 取中段不重复整句', () => {
    const r = parseDetailScenes(DETAIL, makeBook(), 12)
    const s1 = r.scenes[0]
    expect(s1.enter).toBe('城西档案库/林昭、老周')
    expect(s1.advance).toBe('林昭借旧身份牌混入，老周在门口望风')
    expect(s1.exit).toBe('拿到编号甲七的出入册')
    expect(s1.summary).toBe('林昭借旧身份牌混入，老周在门口望风')
    expect(s1.title).toBeTruthy()
    expect([...s1.title].length).toBeLessThanOrEqual(6)
  })

  it('出场人物按姓名与别名做包含匹配，未出场的人物不混进来', () => {
    const r = parseDetailScenes(DETAIL, makeBook(), 12)
    expect(r.participants.sort()).toEqual(['林昭', '老周', '苏晚'].sort())
    expect(r.participants).not.toContain('路人甲')
  })

  it('别名同样能命中人物（苏晚在场景里以别名出现也认得）', () => {
    const d = DETAIL.replace('[场景3] 巷口茶馆/林昭、苏晚', '[场景3] 巷口茶馆/林昭、苏姑娘')
    const r = parseDetailScenes(d, makeBook(), 12)
    expect(r.participants).toContain('苏晚')
  })

  it('地点命中世界手册块时统一用档案里的块名（保证选择性注入对得上）', () => {
    const r = parseDetailScenes(DETAIL, makeBook(), 12)
    // '城西档案库' 与 '档案库地下室' 都命中块名 b2（aliases 含城西档案库），归并为档案里的 '档案库'
    expect(r.locations).toContain('档案库')
    expect(r.locations).not.toContain('城西档案库')
    expect(r.locations).toContain('巷口茶馆') // 无档案命中的地点保留原词
  })

  it('事实台账走 deriveFactLedger（纯逻辑、零 Token），世界规则块进 constraints', () => {
    const r = parseDetailScenes(DETAIL, makeBook(), 12)
    expect(r.factLedger).not.toBeNull()
    expect(r.factLedger.constraints.join('')).toContain('夺舍者遭天谴')
    // 出场人物的受控状态位进 numbers（防数字漂移：灵力余量在章与章之间不能自己变）
    expect(r.factLedger.numbers.some((n) => n.value.includes('3'))).toBe(true)
  })

  it('不传 project 时台账为 null，其余解析照常（详纲本身已足够切场景）', () => {
    const r = parseDetailScenes(DETAIL)
    expect(r.scenes).toHaveLength(3)
    expect(r.factLedger).toBeNull()
    // 没有人物档案可匹配 → participants 为空，但地点仍按原词保留
    expect(r.participants).toEqual([])
    expect(r.locations).toContain('城西档案库')
  })

  it('全角【场景N】标签同样认（提示词偶发全角输出时不该整章降级）', () => {
    const d = DETAIL.replace(/\[场景(\d)\]/g, '【场景$1】')
    expect(parseDetailScenes(d, makeBook(), 12).scenes).toHaveLength(3)
  })

  it('箭头写法 -> 与 => 同样能拆三段', () => {
    const d = '[场景1] 城西档案库/林昭 -> 混入库房 -> 拿到出入册\n[场景2] 地下室/林昭 => 发现缺页 => 察觉有人先来过'
    const r = parseDetailScenes(d, makeBook(), 12)
    expect(r.scenes).toHaveLength(2)
    expect(r.scenes[0].advance).toBe('混入库房')
    expect(r.scenes[1].exit).toBe('察觉有人先来过')
  })

  it('两段式场景行：summary 背全文、advance 留空（一个字都不丢，交给 serializeSceneLine 降级）', () => {
    const r = parseDetailScenes('[场景1] 城西档案库/林昭 → 拿到出入册', makeBook(), 12)
    expect(r.scenes).toHaveLength(1)
    expect(r.scenes[0].enter).toBe('城西档案库/林昭')
    expect(r.scenes[0].exit).toBe('拿到出入册')
    expect(r.scenes[0].advance).toBe('')
    expect(r.scenes[0].summary).toBe('城西档案库/林昭 → 拿到出入册')
  })

  it('无箭头的一句话场景：summary 背全文，不抛异常', () => {
    const r = parseDetailScenes('[场景1] 林昭在档案库里翻找了一夜', makeBook(), 12)
    expect(r.scenes).toHaveLength(1)
    expect(r.scenes[0].summary).toContain('翻找了一夜')
    expect(r.scenes[0].enter).toBe('')
  })

  it('精简细纲（旧书 60~120 字、无 [场景N] 行）返回 null，调用方据此降级走场景清单请求', () => {
    expect(parseDetailScenes('第12章 林昭夜访档案库，找到母亲失踪当夜的线索。', makeBook(), 12)).toBeNull()
  })

  it('空文本与 null 都返回 null 而不是抛异常', () => {
    expect(parseDetailScenes('', makeBook(), 12)).toBeNull()
    expect(parseDetailScenes(null, makeBook(), 12)).toBeNull()
    expect(parseDetailScenes('   \n  \n', makeBook(), 12)).toBeNull()
  })

  it('有 [任务] 但没有 [场景N] 时仍返回 null（只有任务不足以切场景）', () => {
    expect(parseDetailScenes('[任务] 林昭夜访档案库\n[钩子] 火漆印', makeBook(), 12)).toBeNull()
  })
})

describe('buildWorldBlockText 的 rulesOnly 精简选项', () => {
  it('rulesOnly=true 时只输出规则块，地点命中也不追加设定块', () => {
    const t = buildWorldBlockText(makeBook(), { locations: ['城西档案库', '钦天监'], fallbackText: '林昭去档案库找钦天监的卷宗', rulesOnly: true })
    expect(t).toContain('修行铁律')
    expect(t).toContain('夺舍者遭天谴')
    expect(t).not.toContain('一座三层木楼')
    expect(t).not.toContain('朝廷监察修士的机构')
  })

  it('rulesOnly 默认关闭：地点命中的设定块照常注入（改造前行为）', () => {
    const t = buildWorldBlockText(makeBook(), { locations: ['城西档案库'] })
    expect(t).toContain('修行铁律')
    expect(t).toContain('一座三层木楼')
    expect(t).not.toContain('朝廷监察修士的机构') // 未命中的块仍然不注入
  })

  it('无地点清单时按 fallbackText 做包含匹配（与 rulesOnly 无关）', () => {
    const t = buildWorldBlockText(makeBook(), { fallbackText: '林昭潜入钦天监的档案房' })
    expect(t).toContain('朝廷监察修士的机构')
  })

  it('maxChars 对规则块也生效：超长时截断内容而不是整块丢弃', () => {
    const p = makeBook()
    p.worldBlocks = [{ id: 'b1', name: '修行铁律', aliases: '', kind: '规则', content: '律'.repeat(2000) }]
    const t = buildWorldBlockText(p, { rulesOnly: true, maxChars: 100 })
    expect(t).toContain('修行铁律')
    expect(t.length).toBeLessThanOrEqual(101) // 100 + 省略号
    expect(t.endsWith('…')).toBe(true)
  })

  it('世界手册为空时返回空串（不返回 undefined 污染上下文拼装）', () => {
    const p = makeBook()
    p.worldBlocks = []
    expect(buildWorldBlockText(p, { rulesOnly: true })).toBe('')
    expect(buildWorldBlockText(p, {})).toBe('')
  })
})

describe('volumeStrategyText 的 lean 精简选项', () => {
  it('lean=true 只保留卷名 + 本卷故事 + 卷末钩子 + 本卷禁回收清单', () => {
    const t = volumeStrategyText(makeBook(), 12, { lean: true })
    expect(t).toContain('第1卷《青阳风起》')
    expect(t).toContain('本卷故事（本章围绕它推进，不写跨卷主线）：林昭追查母亲失踪的旧案。')
    expect(t).toContain('卷末大悬念（仅卷末允许落在其上）：档案库走水，出入册下落不明')
    expect(t).toContain('本卷绝对不回收的长线伏笔')
    expect(t).toContain('「母亲的玉佩其实是钦天监的通行令」')
  })

  it('lean=true 砍掉卷战略、主题、冲突、收获、主舞台、起承转合、情感走向与地图分层', () => {
    const t = volumeStrategyText(makeBook(), 12, { lean: true })
    expect(t).not.toContain('本卷写主角在县城站稳脚跟。')
    expect(t).not.toContain('本卷主题：执念')
    expect(t).not.toContain('本卷核心冲突')
    expect(t).not.toContain('本卷收获')
    expect(t).not.toContain('本卷主舞台')
    expect(t).not.toContain('起承转合结构')
    expect(t).not.toContain('情感走向')
    // 地图分层是剧透源（含未解锁层名称与禁区清单），lean 档必须整块不进上下文
    expect(t).not.toContain('世界地图')
    expect(t).not.toContain('东玄州')
    expect(t).not.toContain('天阙')
  })

  it('lean=false 时地图分层与全维度战略都在（与改造前一致）', () => {
    const t = volumeStrategyText(makeBook(), 12)
    expect(t).toContain('本卷写主角在县城站稳脚跟。')
    expect(t).toContain('本卷主题：执念')
    expect(t).toContain('世界地图·已解锁区域')
    expect(t).toContain('世界地图·远方传闻')
    expect(t.length).toBeGreaterThan(volumeStrategyText(makeBook(), 12, { lean: true }).length)
  })

  it('lean 默认关闭：不传第三参时逐字节等同显式 lean=false', () => {
    expect(volumeStrategyText(makeBook(), 12)).toBe(volumeStrategyText(makeBook(), 12, { lean: false }))
    expect(volumeStrategyText(makeBook(), 12)).not.toBe(volumeStrategyText(makeBook(), 12, { lean: true }))
  })

  it('lean=true 时即使卷战略为空也照常输出（原逻辑无 strategy 直接返回空串，精简档不该被它卡死）', () => {
    const p = makeBook()
    p.volumes[0].strategy = ''
    expect(volumeStrategyText(p, 12)).toBe('')
    expect(volumeStrategyText(p, 12, { lean: true })).toContain('林昭追查母亲失踪的旧案。')
  })

  it('本卷没有禁回收伏笔时不输出该段（不留空标题）', () => {
    const p = makeBook()
    p.volumes[0].forbiddenForeshadowIds = []
    expect(volumeStrategyText(p, 12, { lean: true })).not.toContain('本卷绝对不回收的长线伏笔')
  })

  it('无卷档案时返回空串（lean 与否都一样）', () => {
    const p = makeBook()
    p.volumes = []
    expect(volumeStrategyText(p, 12)).toBe('')
    expect(volumeStrategyText(p, 12, { lean: true })).toBe('')
  })

  it('跨卷取到对应卷的战略（第 25 章落在第 2 卷）', () => {
    const t = volumeStrategyText(makeBook(), 25, { lean: true })
    expect(t).toContain('第2卷《东玄州》')
    expect(t).not.toContain('青阳风起')
  })
})
