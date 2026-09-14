// 细纲越界监管单测：outlineLeakScan 的两级判定（blocked 拒绝入库 / warnings 只提示）、
// 比对基准组装 outlineLeakContextFor、以及从源头堵剧透的两个裁剪函数 laterMilestonesFor / mainlineSliceFor。
// 改造前细纲侧只有格式类校验（parseSkeleton / skeletonMissing / dedupeSkeletonBatch），零剧情越界检查——这组测试就是那道新监管的护栏。
import { describe, it, expect } from 'vitest'
import {
  newProject,
  outlineLeakScan,
  outlineLeakContextFor,
  laterMilestonesFor,
  mainlineSliceFor,
  reviewTruths,
} from '../longform.js'

const TRUTH = '母亲当年并未死于火灾，而是被钦天监秘密囚禁在东玄州地牢'
const LAYER_TRUTH = '东玄州地底镇压着一条真龙，真龙死前留下屠神的证据'

// 三卷书：卷一 1~20、卷二 21~40、卷三 41~60；势力与地图层按卷解锁，长线伏笔在卷一禁回收
const makeBook = () => {
  const p = newProject('测试书')
  p.volumes = [
    { id: 'v1', volumeNo: 1, name: '青阳风起', startChapter: 1, length: 20, forbiddenForeshadowIds: ['f1'] },
    { id: 'v2', volumeNo: 2, name: '东玄州', startChapter: 21, length: 20, forbiddenForeshadowIds: [] },
    { id: 'v3', volumeNo: 3, name: '天阙', startChapter: 41, length: 20 },
  ]
  p.chapterSkeleton = [
    { chapterNo: 12, title: '夜访', task: '林昭潜入档案库找到出入记录' },
    { chapterNo: 13, title: '走水', task: '档案库起火，出入册失踪' },
    { chapterNo: 14, title: '灰烬', task: '林昭在灰烬里捡到半枚玉佩' },
  ]
  p.foreshadows = [
    { id: 'f1', content: '母亲的玉佩其实是钦天监的通行令', status: '未回收' },
    { id: 'f2', content: '老周欠下的人情', status: '未回收' },
  ]
  p.bible = {
    truths: [{ id: 't1', kind: '终极真相', truth: TRUTH }],
    factions: [
      { name: '青阳剑派', unlockVolume: 1 },
      { name: '钦天监', unlockVolume: 2 },
      { name: '屠神遗族', unlockVolume: 3 },
    ],
    mapLayers: [
      { id: 'm1', name: '青阳县', unlockVolume: 1, summary: '开局之地', rumor: '', truth: '' },
      { id: 'm2', name: '东玄州', unlockVolume: 2, summary: '中期舞台', rumor: '传闻中的大州', truth: LAYER_TRUTH },
      { id: 'm3', name: '天阙', unlockVolume: 3, summary: '终局舞台', rumor: '天上的城', truth: '天阙是当年屠神之战的战场' },
    ],
  }
  p.synopsis = '第5章林昭拜入青阳剑派。第25章林昭闯东玄州救出母亲。第45章林昭登上天阙，揭开屠神之战的真相。'
  return p
}

// 一份干净的详纲：不碰任何封存真相、不让未登场势力出场、不抢收伏笔、不消耗后续章任务
const CLEAN_DETAIL = [
  '第12章【承】夜访旧档',
  '[任务] 林昭潜入档案库查阅旧卷宗',
  '[场景1] 城西档案库/林昭、老周 → 林昭借旧身份牌混入库房 → 拿到编号甲七的出入册',
  '[场景2] 档案库地下室/林昭 → 册页缺了当夜那一页，撕口是新的 → 林昭察觉有人先来过',
  '[边界] 本章允许揭示：出入册缺页；本章严禁触及：母亲的下落',
  '[钩子] 缺页的撕口还带着新茬',
  '[字数] 2000（场景1:1000 / 场景2:1000）',
].join('\n')

describe('outlineLeakScan · blocked 红线（拒绝入库）', () => {
  it('详纲写出封存真相 → blocked，kind 带上真相分类', () => {
    const text = `第12章【承】夜访\n[场景1] 档案库/林昭 → 他终于得知${TRUTH} → 林昭当场崩溃`
    const r = outlineLeakScan(text, { lockedTruths: [{ kind: '终极真相', truth: TRUTH }] })
    expect(r.blocked).toHaveLength(1)
    expect(r.blocked[0].kind).toBe('真相泄漏·终极真相')
    expect(r.blocked[0].hit).toBeTruthy()
    // evidence 要能让作者直接看出是哪一句越界（带命中串前后各 10 字）
    expect(r.blocked[0].evidence).toContain('连续重合')
  })

  it('lockedTruths 传纯字符串数组时 kind 落到通用的「终极真相泄漏」', () => {
    const text = `[场景1] 档案库/林昭 → 得知${TRUTH} → 崩溃`
    const r = outlineLeakScan(text, { lockedTruths: [TRUTH] })
    expect(r.blocked).toHaveLength(1)
    expect(r.blocked[0].kind).toBe('终极真相泄漏')
  })

  it('地图分层真相同样算红线', () => {
    const text = `[场景1] 旷野/林昭 → 他看见${LAYER_TRUTH} → 震惊`
    const r = outlineLeakScan(text, { lockedTruths: [{ kind: '地图分层真相·东玄州', truth: LAYER_TRUTH }] })
    expect(r.blocked).toHaveLength(1)
    expect(r.blocked[0].kind).toBe('真相泄漏·地图分层真相·东玄州')
  })

  it('重合不足 15 字不拦（只是提了个话头，不是把真相写出来）', () => {
    const r = outlineLeakScan('[场景1] 档案库/林昭 → 他隐约觉得母亲当年并未死于火灾 → 决定继续查', { lockedTruths: [{ kind: '终极真相', truth: TRUTH }] })
    expect(r.blocked).toEqual([])
  })

  it('短于 15 字的真相整条跳过（短串包含匹配误报率太高，宁可漏判不可错杀）', () => {
    const r = outlineLeakScan('[场景1] 档案库/林昭 → 主角会死 → 全章收束', { lockedTruths: [{ kind: '终极真相', truth: '主角会死' }] })
    expect(r.blocked).toEqual([])
  })
})

describe('outlineLeakScan · warnings 黄条（只提示不阻断）', () => {
  it('未到登场卷的势力实质出场', () => {
    const r = outlineLeakScan('[场景1] 长街/林昭 → 钦天监的人马封了街口 → 林昭退走', { laterFactions: ['钦天监', '屠神遗族'] })
    const hit = r.warnings.filter((w) => w.kind === '未登场势力实质出场')
    expect(hit).toHaveLength(1)
    expect(hit[0].hit).toBe('钦天监')
    expect(r.blocked).toEqual([]) // warning 级别绝不拦入库
  })

  it('未解锁的地图层被写成实地场景', () => {
    const r = outlineLeakScan('[场景1] 东玄州城门口/林昭 → 林昭入城 → 见到州牧', { laterMapLayers: ['东玄州', '天阙'] })
    expect(r.warnings.some((w) => w.kind === '未解锁地图层' && w.hit === '东玄州')).toBe(true)
  })

  it('抢收本卷禁回收的长线伏笔（连续重合 ≥12 字）', () => {
    const r = outlineLeakScan('[场景1] 老宅/林昭 → 原来母亲的玉佩其实是钦天监的通行令 → 林昭愣住', { bannedForeshadows: ['母亲的玉佩其实是钦天监的通行令'] })
    expect(r.warnings.some((w) => w.kind === '抢收本卷禁回收伏笔')).toBe(true)
  })

  it('越界消耗后续章的任务（连续重合 ≥6 字）', () => {
    const r = outlineLeakScan('[场景1] 废墟/林昭 → 林昭在灰烬里捡到半枚玉佩 → 收束', { laterTasks: ['林昭在灰烬里捡到半枚玉佩'] })
    const hit = r.warnings.filter((w) => w.kind === '越界消耗后续章任务')
    expect(hit).toHaveLength(1)
    expect(hit[0].evidence).toContain('连续重合')
  })

  it('提前引爆属后续卷的跨卷里程碑', () => {
    const r = outlineLeakScan('[场景1] 山头/林昭 → 林昭闯东玄州救出母亲 → 全章收束', { laterMilestones: ['第25章林昭闯东玄州救出母亲'] })
    expect(r.warnings.some((w) => w.kind === '提前引爆跨卷里程碑')).toBe(true)
  })

  it('纯虚词组成的重合不算命中（叙事套话不该报警）', () => {
    // isGeneric 是「命中串每一个字都落在 GENERIC_CHARS 里」才跳过——它只降噪声，不是语义分类器
    const r = outlineLeakScan('[场景1] 老宅/林昭 → 他们自己都要来了 → 收束', { laterTasks: ['他们自己都要来了以后再说'] })
    expect(r.warnings.filter((w) => w.kind === '越界消耗后续章任务')).toEqual([])
  })

  it('重合串里混进一个实词字就照报（别把 isGeneric 当语义过滤器用）', () => {
    // '他第一次意识到' 里的「次」不在 GENERIC_CHARS 中 → 整串不算虚词 → 仍然报警。
    // 这条是刻意留下的行为记录：过滤器偏保守，宁可多报一条黄条（只提示不阻断），也不放过真越界。
    const r = outlineLeakScan('[场景1] 老宅/林昭 → 他第一次意识到自己错了 → 收束', { laterTasks: ['他第一次意识到一切都晚了'] })
    expect(r.warnings.filter((w) => w.kind === '越界消耗后续章任务')).toHaveLength(1)
  })

  it('专名短于 2 字或长于 20 字的势力名整条跳过（防误报）', () => {
    const r = outlineLeakScan('[场景1] 长街/林昭 → 林昭退走 → 收束', { laterFactions: ['林', '这是一个长得离谱根本不可能作为势力名出现的字符串用来验证长度上限'] })
    expect(r.warnings).toEqual([])
  })
})

describe('outlineLeakScan · 全清与边界输入', () => {
  it('干净的详纲：blocked 与 warnings 都为空', () => {
    const r = outlineLeakScan(CLEAN_DETAIL, outlineLeakContextFor(makeBook(), 12))
    expect(r.blocked, JSON.stringify(r.blocked)).toEqual([])
    expect(r.warnings, JSON.stringify(r.warnings)).toEqual([])
  })

  it('空文本直接返回空结果，不抛异常', () => {
    expect(outlineLeakScan('', outlineLeakContextFor(makeBook(), 12))).toEqual({ blocked: [], warnings: [] })
    expect(outlineLeakScan('   \n ', {})).toEqual({ blocked: [], warnings: [] })
  })

  it('不传比对基准时不抛异常（挂接点漏传 ctx 不该让整个生成流程崩掉）', () => {
    expect(outlineLeakScan(CLEAN_DETAIL)).toEqual({ blocked: [], warnings: [] })
    expect(outlineLeakScan(CLEAN_DETAIL, { lockedTruths: null, laterFactions: undefined })).toEqual({ blocked: [], warnings: [] })
  })

  it('同一段文本可同时命中红线与多条黄条，两级互不吞并', () => {
    const text = `[场景1] 东玄州地牢/林昭 → 他看见${TRUTH} → 钦天监的人围上来`
    const r = outlineLeakScan(text, outlineLeakContextFor(makeBook(), 12))
    expect(r.blocked.length).toBeGreaterThan(0)
    expect(r.warnings.some((w) => w.kind === '未解锁地图层')).toBe(true)
    expect(r.warnings.some((w) => w.kind === '未登场势力实质出场')).toBe(true)
  })
})

describe('outlineLeakContextFor 比对基准组装', () => {
  it('第 12 章（卷一）：laterTasks 只取本章之后的骨架任务', () => {
    const ctx = outlineLeakContextFor(makeBook(), 12)
    expect(ctx.laterTasks).toEqual(['档案库起火，出入册失踪', '林昭在灰烬里捡到半枚玉佩'])
    expect(ctx.laterTasks).not.toContain('林昭潜入档案库找到出入记录') // 本章任务不是「后续」
  })

  it('taskWindow 限制后续任务窗口长度', () => {
    expect(outlineLeakContextFor(makeBook(), 12, { taskWindow: 1 }).laterTasks).toEqual(['档案库起火，出入册失踪'])
    expect(outlineLeakContextFor(makeBook(), 12, { taskWindow: 0 }).laterTasks).toEqual([])
  })

  it('封存真相全部收录（揭示红线都在第 12 章之后）', () => {
    const ctx = outlineLeakContextFor(makeBook(), 12)
    expect(ctx.lockedTruths).toHaveLength(3)
    expect(ctx.lockedTruths.map((t) => t.kind)).toContain('终极真相')
    expect(ctx.lockedTruths.map((t) => t.kind)).toContain('地图分层真相·东玄州')
  })

  it('已过揭示红线的真相不再比对（终卷该揭示时不该拦）', () => {
    // 第 45 章落在卷三：truths 的 minResolveChapter=41、东玄州=21、天阙=41 全部 ≤45 → 一条都不比
    expect(outlineLeakContextFor(makeBook(), 45).lockedTruths).toEqual([])
    // 第 25 章落在卷二：只有东玄州（21）已过线，终极真相（41）与天阙（41）仍要比对
    const kinds = outlineLeakContextFor(makeBook(), 25).lockedTruths.map((t) => t.kind)
    expect(kinds).not.toContain('地图分层真相·东玄州')
    expect(kinds).toContain('终极真相')
  })

  it('未登场势力 / 未解锁地图层按「unlockVolume 大于本卷」筛', () => {
    const v1 = outlineLeakContextFor(makeBook(), 12)
    expect(v1.laterFactions).toEqual(['钦天监', '屠神遗族'])
    expect(v1.laterMapLayers).toEqual(['东玄州', '天阙'])
    const v2 = outlineLeakContextFor(makeBook(), 25)
    expect(v2.laterFactions).toEqual(['屠神遗族'])
    expect(v2.laterMapLayers).toEqual(['天阙'])
    expect(outlineLeakContextFor(makeBook(), 45).laterFactions).toEqual([])
  })

  it('本卷禁回收伏笔按 forbiddenForeshadowIds 取内容', () => {
    expect(outlineLeakContextFor(makeBook(), 12).bannedForeshadows).toEqual(['母亲的玉佩其实是钦天监的通行令'])
    expect(outlineLeakContextFor(makeBook(), 25).bannedForeshadows).toEqual([]) // 卷二没有禁回收清单
  })

  it('无卷档案时不抛异常：卷号按 1 处理、卷末视为无穷', () => {
    const p = makeBook()
    p.volumes = []
    const ctx = outlineLeakContextFor(p, 12)
    // 卷号取不到时按 1 处理，所以 unlockVolume 2、3 的势力与地图层仍然算「后续」
    expect(ctx.laterFactions).toEqual(['钦天监', '屠神遗族'])
    expect(ctx.laterMapLayers).toEqual(['东玄州', '天阙'])
    expect(ctx.laterMilestones).toEqual([]) // volEnd=Infinity → 无法判定「本卷之后」，一律不收（宁缺勿剧透）
  })

  it('空书对象也能安全组装', () => {
    const ctx = outlineLeakContextFor(null, 1)
    expect(ctx).toEqual({ laterTasks: [], lockedTruths: [], bannedForeshadows: [], laterFactions: [], laterMapLayers: [], laterMilestones: [] })
  })
})

describe('reviewTruths 真相清单（仅供审核与越界比对，永不进写作上下文）', () => {
  it('收录圣经 truths 与地图层 truth，并带上揭示红线章号', () => {
    const t = reviewTruths(makeBook())
    expect(t).toHaveLength(3)
    expect(t[0]).toEqual({ kind: '终极真相', truth: TRUTH, minResolveChapter: 41 })
    expect(t.find((x) => x.kind === '地图分层真相·东玄州').minResolveChapter).toBe(21)
  })

  it('没有 truth 的地图层不进清单（只有 summary/rumor 的层不是秘密）', () => {
    const t = reviewTruths(makeBook())
    expect(t.some((x) => x.kind.includes('青阳县'))).toBe(false)
  })
})

describe('laterMilestonesFor · 跨卷里程碑句', () => {
  it('只收章号锚点落在本卷之后的句子', () => {
    const m = laterMilestonesFor(makeBook(), 12, 20)
    expect(m).toEqual(['第25章林昭闯东玄州救出母亲', '第45章林昭登上天阙，揭开屠神之战的真相'])
  })

  it('volEnd 为无穷时一律不收（无法判定归属就不比对，避免误报淹没真命中）', () => {
    expect(laterMilestonesFor(makeBook(), 12)).toEqual([])
    expect(laterMilestonesFor(makeBook(), 12, Infinity)).toEqual([])
  })

  it('无章号锚点的句子永不收录——「大结局形态」那类句子往往正好无锚点，收进来就是剧透到终局', () => {
    const p = makeBook()
    p.synopsis = '大结局时林昭成为新的神，天下重归寂静。这是一句没有任何章号的话。'
    expect(laterMilestonesFor(p, 12, 20)).toEqual([])
  })

  it('空梗概与空书安全返回空数组', () => {
    expect(laterMilestonesFor(makeBook(), 12, 20)).not.toEqual([])
    const p = makeBook()
    p.synopsis = ''
    expect(laterMilestonesFor(p, 12, 20)).toEqual([])
    expect(laterMilestonesFor(null, 12, 20)).toEqual([])
  })
})

describe('mainlineSliceFor · 逐章详纲只喂本卷主线', () => {
  it('第 12 章（卷一）只拿到锚点落在 1~20 的那一句', () => {
    const s = mainlineSliceFor(makeBook(), 12, 600)
    expect(s).toBe('第5章林昭拜入青阳剑派')
    // 全书梗概里的后续卷里程碑与大结局形态一个字都不能进详纲生成上下文
    expect(s).not.toContain('东玄州')
    expect(s).not.toContain('天阙')
    expect(s).not.toContain('屠神')
  })

  it('第 25 章（卷二）只拿到卷二锚点句，卷三里程碑仍然不进', () => {
    const s = mainlineSliceFor(makeBook(), 25, 600)
    expect(s).toContain('第25章林昭闯东玄州救出母亲')
    expect(s).not.toContain('第45章')
    expect(s).not.toContain('第5章')
  })

  it('本卷没有锚定里程碑时返回空串（详纲仍有本卷故事与卷战略可依，宁缺勿剧透）', () => {
    const p = makeBook()
    p.synopsis = '第25章林昭闯东玄州救出母亲。第45章林昭登上天阙。'
    expect(mainlineSliceFor(p, 12, 600)).toBe('')
  })

  it('未建卷档案时降级取开头 maxChars（开局状态不是剧透），超长加省略号', () => {
    const p = makeBook()
    p.volumes = []
    expect(mainlineSliceFor(p, 12, 8)).toBe('第5章林昭拜入青…')
    expect(mainlineSliceFor(p, 12, 600)).toBe(p.synopsis)
  })

  it('超长时按 maxChars 截断并加省略号', () => {
    const s = mainlineSliceFor(makeBook(), 12, 6)
    expect(s).toBe('第5章林昭拜…')
  })

  it('空梗概返回空串', () => {
    const p = makeBook()
    p.synopsis = ''
    expect(mainlineSliceFor(p, 12, 600)).toBe('')
    expect(mainlineSliceFor(null, 12, 600)).toBe('')
  })
})
