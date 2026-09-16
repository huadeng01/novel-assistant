// 写作层 7 agent 测试（§15 单元验证）：
// ① 纯函数直接验证——Pacer.actContext/checkDrift/actForChapter、Logic.gate/buildFixPrompt、
//    Editor.toVerdict/buildChapterReviewInput、Polisher.refine/defaultSplitTitle、Writer.draft（注入假流不打真实 API）；
// ② Showrunner.criticChapter 用【真实】Logic/Editor/Polisher + 桩 llm（glmChatJSON/chatStream）验证编排：
//    提案暂停 / 全过不改 / 硬门不过触发定点重写并复审通过 / maxRounds 上限 / strict 两轮 / 缺 glmKey 时 Editor 跳过但 Logic 仍守门。
// mock 只覆盖 llm.js（保留 ANTI_REPETITION 等真实常量）；longform 检测器全用真实实现——零 Token 硬门必须真跑才算数。
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../llm.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, chatStream: vi.fn(), chatJSON: vi.fn(), glmChatJSON: vi.fn() }
})

import { chatStream, glmChatJSON } from '../llm.js'
import { newProject, addUserNote, applyUserNotes } from '../longform.js'
import { longFormDraftMessages } from '../prompts.js'
import { makeProgress } from '../agents/runtime.js'
import { pacerAgent, actForChapter } from '../agents/pacerAgent.js'
import { logicAgent, buildFixPrompt } from '../agents/logicAgent.js'
import { editorAgent, toVerdict, buildChapterReviewInput, buildRevisionPrompt } from '../agents/editorAgent.js'
import { polisherAgent, defaultSplitTitle } from '../agents/polisherAgent.js'
import { writerAgent } from '../agents/writerAgent.js'
import { archivistAgent } from '../agents/archivistAgent.js'
import { showrunnerAgent, planGenScope } from '../agents/showrunnerAgent.js'

beforeEach(() => vi.clearAllMocks())

// ---- 公共夹具 ----
const TRUTH = '主角的生父其实是魔教教主厉苍天本人' // 17 字 ≥15，可被 outlineLeakScan 连续重合命中
const CLEAN = '他握紧长剑，缓步走入密林深处。月色如水，静静洒在肩头。风声在耳边呼啸，惊起一群宿鸟。'
// 定点重写的返回值必须 ≥200 字（polisherAgent.rewrite 的 minWords 护栏），否则会抛「疑似异常」
const LONG_CLEAN = '他握紧长剑，缓步走入密林深处。月色如水，静静洒在肩头。风声在耳边呼啸，惊起一群宿鸟。' +
  '前方的路越来越窄，荆棘划破了衣袖。他停下脚步，屏住呼吸，仔细聆听四周的动静。远处传来一声低吼。' +
  '他深吸一口气，握剑的手更紧了。无论如何，今夜必须穿过这片林子。身后的村庄已经回不去了，只有向前。' +
  '树影斑驳间，一点微光忽明忽暗，仿佛在指引，又仿佛在警告。他咬了咬牙，迈步朝那点光走去。' +
  '林间雾气渐起，模糊了来路，也模糊了去路。他辨不清方向，只能凭着那点微光一路向前。脚下的落叶发出细碎的声响，像是有人悄悄跟在身后。他猛然回头，却什么也没有看见。'

// 带卷/幕档案的书：acts[].start/end 为「卷内坐标」，emotion/outline 供 Pacer 定位
function bookWithActs() {
  const p = newProject('测试书')
  p.outline = '第1章 【起】少年离乡\n第3章 【承】宗门试炼\n第8章 【转】风云突变'
  p.volumes = [{
    id: 'v1', volumeNo: 1, name: '卷一', startChapter: 1, length: 10, emotion: '燃',
    acts: [
      { act: '起幕', start: 1, end: 5, goal: '主角觉醒血脉，初离小镇闯荡' },
      { act: '承幕', start: 6, end: 10, goal: '拜入宗门，崭露头角结下宿敌' },
    ],
  }]
  return p
}
// 带封存真相、但无卷档案的书：reviewTruths 的 minResolveChapter=null → 恒定纳入越界比对基准
function leakyBook() {
  const p = newProject('剧本')
  p.world = '九州世界'
  p.bible = { truths: [{ kind: '身世', truth: TRUTH }] }
  return p
}

// ==================== Pacer 节奏把控师 ====================
describe('Pacer actContext：把本幕 goal 显式注入（补 chat-4 缺口）', () => {
  it('命中幕：actGoal 含幕名/卷内区间/幕级目标，position 取起承转合', () => {
    const info = pacerAgent.actContext({ project: bookWithActs(), chapterNo: 3 })
    expect(info.actLabel).toBe('起幕（卷内第1-5章）')
    expect(info.actGoal).toContain('起幕（卷内第1-5章）')
    expect(info.actGoal).toContain('主角觉醒血脉，初离小镇闯荡')
    expect(info.position).toBe('承') // 第3章【承】
    expect(info.volumeEmotion).toBe('燃')
  })
  it('全局章号→卷内坐标换算正确：第8章落承幕', () => {
    const hit = actForChapter(bookWithActs(), 8)
    expect(hit.local).toBe(8) // startChapter=1 → local=8-1+1
    expect(hit.act.act).toBe('承幕')
    expect(pacerAgent.actContext({ project: bookWithActs(), chapterNo: 8 }).actLabel).toBe('承幕（卷内第6-10章）')
  })
  it('无卷档案：优雅退化，actGoal 为空串（不注入，输出与改造前逐字节一致）', () => {
    const info = pacerAgent.actContext({ project: newProject('裸书'), chapterNo: 3 })
    expect(info.actGoal).toBe('')
    expect(actForChapter(newProject('裸书'), 3)).toBeNull()
  })
  it('有幕但 goal 为空：actGoal 空、actLabel 仍在（不硬造目标）', () => {
    const p = bookWithActs()
    p.volumes[0].acts[0].goal = '  '
    const info = pacerAgent.actContext({ project: p, chapterNo: 2 })
    expect(info.actGoal).toBe('')
    expect(info.actLabel).toBe('起幕（卷内第1-5章）')
  })
  it('checkDrift：pass 恒 true（绝不阻断），带节奏定位 finding，过短追加篇幅 finding', () => {
    const drift = pacerAgent.checkDrift({ project: bookWithActs(), chapterNo: 3, text: CLEAN, chapterWords: 2000 })
    expect(drift.pass).toBe(true)
    expect(drift.blockers).toEqual([])
    expect(drift.findings.some((f) => f.category === '节奏定位')).toBe(true)
    // CLEAN 远短于 2000*0.6 → 触发篇幅偏短软提示
    expect(drift.findings.some((f) => f.category === '篇幅偏短')).toBe(true)
  })
})

describe('longFormDraftMessages actGoal 注入（Pacer→prompt 接线，§5）', () => {
  const all = (msgs) => msgs.map((m) => m.content).join('\n')
  const base = { chapterNo: 3, world: 'W', characters: [], foreshadows: [] }
  it('给了 actGoal：prompt 出现「本幕目标」块与目标正文', () => {
    const t = all(longFormDraftMessages({ ...base, actGoal: '起幕（卷内第1-5章）：主角觉醒血脉' }))
    expect(t).toContain('本幕目标')
    expect(t).toContain('主角觉醒血脉')
  })
  it('actGoal 为空：不注入「本幕目标」块（与改造前一致）', () => {
    expect(all(longFormDraftMessages({ ...base, actGoal: '' }))).not.toContain('本幕目标')
  })
})

// ==================== Logic 逻辑审校（零 Token 硬门） ====================
describe('Logic gate：确定性硬门，只判不改', () => {
  it('干净文本 + 裸书：pass、无 blocker、fixPrompt 空', () => {
    const v = logicAgent.gate({ project: newProject('裸书'), chapterNo: 3, text: CLEAN })
    expect(v.pass).toBe(true)
    expect(v.blockers).toEqual([])
    expect(v.fixPrompt).toBe('')
  })
  it('提前剧透封存真相：越界硬阻断 → pass=false + 非空 fixPrompt', () => {
    const v = logicAgent.gate({ project: leakyBook(), chapterNo: 3, text: `开场铺垫。${TRUTH}。他继续前行。` })
    expect(v.pass).toBe(false)
    expect(v.blockers.some((b) => b.source === 'leak')).toBe(true)
    expect(v.fixPrompt.length).toBeGreaterThan(0)
  })
  it('buildFixPrompt：编号 + 类别 + 问题 + 修法；空数组返回空串', () => {
    expect(buildFixPrompt([{ category: '越界·剧透', what: '提前揭示身世', fix_hint: '删掉' }]))
      .toBe('1. [越界·剧透] 提前揭示身世（修法：删掉）')
    expect(buildFixPrompt([])).toBe('')
  })
})

// ==================== Editor 综合主编（GLM 语义） ====================
describe('Editor toVerdict / buildChapterReviewInput / review', () => {
  it('toVerdict：有 suggestions → pass=false + fixPrompt 拼接；analysis 进 finding', () => {
    const v = toVerdict({ pass: false, analysis: '时间线冲突', suggestions: [{ chapter_no: 3, problem: '前后矛盾', fix_prompt: '修正第三章时间线' }] })
    expect(v.pass).toBe(false)
    expect(v.blockers).toHaveLength(1)
    expect(v.blockers[0]).toMatchObject({ source: 'editor', what: '前后矛盾' })
    expect(v.fixPrompt).toBe('修正第三章时间线')
    expect(v.findings.some((f) => f.category === '主编分析')).toBe(true)
  })
  it('toVerdict：pass=true 无 suggestions → 放行', () => {
    expect(toVerdict({ pass: true, suggestions: [] }).pass).toBe(true)
    expect(toVerdict({}).pass).toBe(true) // 空对象兜底不炸
  })
  it('buildChapterReviewInput：只含当前草稿章，伏笔过滤未回收/已提及，时间线就近', () => {
    const p = newProject('x')
    p.events = [{ chapter: 2, text: '事件A' }, { chapter: 99, text: '遥远事件' }]
    p.chapters = [{ chapterNo: 1, summary: '第一章摘要' }, { chapterNo: 2, summary: '第二章摘要' }]
    p.foreshadows = [{ status: '未回收', content: 'f1' }, { status: '已回收', content: 'f2' }, { status: '已提及', content: 'f3' }]
    const input = buildChapterReviewInput(p, 3, '正文', '标题')
    expect(input.chapters).toEqual([{ chapterNo: 3, title: '标题', content: '正文' }])
    expect(input.foreshadows.map((f) => f.content)).toEqual(['f1', 'f3'])
    expect(input.timeline).toContain('第2章：事件A')
    expect(input.timeline).not.toContain('遥远事件')
    expect(input.beforeSummary).toContain('第二章摘要')
  })
  it('review：缺 glmKey → 优雅跳过（pass:true, skipped），不打 GLM', async () => {
    const v = await editorAgent.review({ glmKey: '', project: newProject('x'), chapterNo: 3, text: CLEAN })
    expect(v).toMatchObject({ pass: true, skipped: true })
    expect(glmChatJSON).not.toHaveBeenCalled()
  })
  it('review：有 glmKey → 走 GLM 并转 verdict', async () => {
    glmChatJSON.mockResolvedValue({ pass: false, suggestions: [{ chapter_no: 3, problem: '逻辑断裂', fix_prompt: '补齐动机' }] })
    const v = await editorAgent.review({ glmKey: 'gk', project: newProject('x'), chapterNo: 3, text: CLEAN })
    expect(v.pass).toBe(false)
    expect(v.fixPrompt).toBe('补齐动机')
  })
})

// ==================== Polisher 单章精修师 ====================
describe('Polisher refine / defaultSplitTitle / rewrite', () => {
  it('refine：干净文本 → changed=false, notes 空', () => {
    const r = polisherAgent.refine('他走进屋里，坐下。窗外的雨还在下。他取出信，慢慢读了起来。')
    expect(r.changed).toBe(false)
    expect(r.notes).toEqual([])
  })
  it('refine：中段近重复句 → changed=true，去重后只留一处', () => {
    const dup = '桌上那封信静静躺着，封口处盖着一枚朱印。'
    const text = [
      '他推开木门，屋里弥漫着陈年灰尘的气味。',
      dup,
      '窗外传来更夫的梆子声，一下一下敲在心上。',
      dup, // 与第 2 句逐字重复
      '他深吸一口气，终于伸手拆开了那封迟来的信。',
    ].join('')
    const r = polisherAgent.refine(text)
    expect(r.changed).toBe(true)
    expect(r.notes.length).toBeGreaterThan(0)
    expect(r.text.split(dup).length - 1).toBe(1) // 重复句只剩一处
  })
  it('defaultSplitTitle：剥「第X章 标题」壳；纯正文不误判标题', () => {
    expect(defaultSplitTitle('第三章 风起云涌\n正文第一行。\n正文第二行。')).toMatchObject({ title: '风起云涌' })
    expect(defaultSplitTitle('这是一段很长的正文开头，没有标题壳。第二句。').title).toBe('')
  })
  it('rewrite：无 fixPrompt → 原样返回（不调模型）', async () => {
    const r = await polisherAgent.rewrite({ apiKey: 'k', chapterNo: 3, content: CLEAN, fixPrompt: '' })
    expect(r.unchanged).toBe(true)
    expect(r.text).toBe(CLEAN)
    expect(chatStream).not.toHaveBeenCalled()
  })
  it('rewrite：有 fixPrompt → 调模型定点重写，切标题返回', async () => {
    chatStream.mockResolvedValue(LONG_CLEAN)
    const r = await polisherAgent.rewrite({ apiKey: 'k', chapterNo: 3, title: '旧题', content: '旧正文', fixPrompt: '修正时间线' })
    expect(chatStream).toHaveBeenCalledTimes(1)
    expect(r.text.length).toBeGreaterThan(0)
  })
  it('rewrite：结果过短（<minWords）→ 抛异常', async () => {
    chatStream.mockResolvedValue('太短了')
    await expect(polisherAgent.rewrite({ apiKey: 'k', chapterNo: 3, content: 'x', fixPrompt: '改' })).rejects.toThrow(/太短/)
  })
})

// ==================== Writer 执笔写手（注入假流） ====================
describe('Writer draft：逐场景扩写', () => {
  it('多场景：每场景一次请求，按序拼接，onDelta 逐场景回调', async () => {
    let n = 0
    const stream = vi.fn(async ({ onDelta }) => { n += 1; const piece = `第${n}段扩写内容`; if (onDelta) onDelta(piece); return piece })
    const deltas = []
    const text = await writerAgent.draft({
      draftArgs: { chapterNo: 1, world: 'W' }, sceneText: '场景一\n场景二\n场景三', chapterWords: 2000,
      apiKey: 'k', stream, onDelta: (t) => deltas.push(t),
    })
    expect(stream).toHaveBeenCalledTimes(3)
    expect(text).toBe('第1段扩写内容\n\n第2段扩写内容\n\n第3段扩写内容')
    expect(deltas).toHaveLength(3)
    expect(stream.mock.calls[0][0].temperature).toBe(0.9)
    expect(typeof stream.mock.calls[0][0].maxTokens).toBe('number')
  })
  it('单场景：退回单次生成（sceneCount=1）', async () => {
    const stream = vi.fn(async () => '唯一场景的正文内容')
    const text = await writerAgent.draft({ draftArgs: { chapterNo: 1 }, sceneText: '只有一个场景', chapterWords: 2000, apiKey: 'k', stream })
    expect(stream).toHaveBeenCalledTimes(1)
    expect(text).toBe('唯一场景的正文内容')
  })
})

// ==================== Archivist 归档师（薄封装，契约验证） ====================
describe('Archivist：runPostChapter 的编剧团队身份证', () => {
  it('契约元数据正确、暴露 archive/run（真实归档由 longform 测试覆盖，此处不重复打五路 LLM）', () => {
    expect(archivistAgent).toMatchObject({ id: 'archivist', name: 'Archivist', role: 'generate' })
    expect(typeof archivistAgent.archive).toBe('function')
    expect(typeof archivistAgent.run).toBe('function')
  })
})

// ==================== Showrunner 总编剧（单章 critic 循环编排） ====================
describe('Showrunner criticChapter：写-审-改循环编排', () => {
  it('提案待拍板：不进循环，paused=proposals，不打任何模型', async () => {
    const r = await showrunnerAgent.criticChapter({
      draft: { text: CLEAN, title: 't', proposals: [{ id: 1 }], sceneText: '' },
      project: newProject('x'), chapterNo: 3, apiKey: 'k', glmKey: 'gk',
    })
    expect(r.paused).toBe('proposals')
    expect(r.rounds).toBe(0)
    expect(r.passed).toBe(true)
    expect(glmChatJSON).not.toHaveBeenCalled()
    expect(chatStream).not.toHaveBeenCalled()
  })

  it('Logic+Editor 全过：不改写，rounds=1，push drafted/critiqued 事件', async () => {
    glmChatJSON.mockResolvedValue({ pass: true, suggestions: [] })
    const progress = makeProgress()
    const r = await showrunnerAgent.criticChapter({
      draft: { text: CLEAN, title: 't', proposals: [], sceneText: '' },
      project: newProject('x'), chapterNo: 3, apiKey: 'k', glmKey: 'gk', progress,
    })
    expect(r.passed).toBe(true)
    expect(r.rounds).toBe(1)
    expect(chatStream).not.toHaveBeenCalled() // 未触发定点重写
    expect(progress.snapshot().some((e) => e.phase === 'drafted')).toBe(true)
    expect(progress.snapshot().some((e) => e.phase === 'critiqued')).toBe(true)
  })

  it('硬门不过 → 触发 Polisher 定点重写 → 复审通过：rounds=2, passed=true', async () => {
    glmChatJSON.mockResolvedValue({ pass: true, suggestions: [] }) // Editor 恒放行，隔离出 Logic 硬门
    chatStream.mockResolvedValue(LONG_CLEAN) // 重写产出不含封存真相
    const r = await showrunnerAgent.criticChapter({
      draft: { text: `开场铺垫。${TRUTH}。后续描写。`, title: 't', proposals: [], sceneText: '' },
      project: leakyBook(), chapterNo: 3, apiKey: 'k', glmKey: 'gk',
    })
    expect(chatStream).toHaveBeenCalledTimes(1) // 重写一次
    expect(r.rounds).toBe(2)
    expect(r.passed).toBe(true)
    expect(r.draft.text).not.toContain(TRUTH)
  })

  it('默认档 persistent 硬伤：只重写 1 次即收口，passed=false, rounds=2', async () => {
    glmChatJSON.mockResolvedValue({ pass: true, suggestions: [] })
    chatStream.mockResolvedValue(`${LONG_CLEAN}${TRUTH}`) // 重写后仍泄漏 → 复审仍不过
    const r = await showrunnerAgent.criticChapter({
      draft: { text: `开场。${TRUTH}。`, title: 't', proposals: [], sceneText: '' },
      project: leakyBook(), chapterNo: 3, apiKey: 'k', glmKey: 'gk',
    })
    expect(chatStream).toHaveBeenCalledTimes(1)
    expect(r.passed).toBe(false)
    expect(r.rounds).toBe(2)
    expect(r.verdict.blockers.length).toBeGreaterThan(0)
  })

  it('strict 档：重写上限 2 次，rounds=3', async () => {
    glmChatJSON.mockResolvedValue({ pass: true, suggestions: [] })
    chatStream.mockResolvedValue(`${LONG_CLEAN}${TRUTH}`)
    const r = await showrunnerAgent.criticChapter({
      draft: { text: `开场。${TRUTH}。`, title: 't', proposals: [], sceneText: '' },
      project: leakyBook(), chapterNo: 3, apiKey: 'k', glmKey: 'gk', qualityPolicy: 'strict',
    })
    expect(chatStream).toHaveBeenCalledTimes(2)
    expect(r.rounds).toBe(3)
    expect(r.passed).toBe(false)
  })

  it('缺 glmKey：Editor 跳过，Logic 零 Token 硬门仍独立守门', async () => {
    const r = await showrunnerAgent.criticChapter({
      draft: { text: CLEAN, title: 't', proposals: [], sceneText: '' },
      project: newProject('x'), chapterNo: 3, apiKey: 'k', glmKey: '', // 无 GLM Key
    })
    expect(glmChatJSON).not.toHaveBeenCalled()
    expect(r.passed).toBe(true)
    expect(r.rounds).toBe(1)
  })
})

// ==================== Showrunner planGenScope：幕/卷生成粒度自然边界（§6，突破 10 章上限） ====================
describe('Showrunner planGenScope：生成粒度自然边界', () => {
  it("scope='chapter'：只写 1 章，stopAt=from", () => {
    expect(planGenScope(bookWithActs(), { scope: 'chapter', fromChapter: 3 }))
      .toMatchObject({ scope: 'chapter', stopAtChapter: 3, fromChapter: 3 })
  })
  it("scope='act'：卷内坐标→全局边界，第3章→起幕末第5章", () => {
    const p = planGenScope(bookWithActs(), { scope: 'act', fromChapter: 3 })
    expect(p.scope).toBe('act')
    expect(p.stopAtChapter).toBe(5)
    expect(p.actIndex).toBe(0)
    expect(p.label).toContain('起幕')
  })
  it("scope='act' 第8章→承幕末第10章", () => {
    expect(planGenScope(bookWithActs(), { scope: 'act', fromChapter: 8 }).stopAtChapter).toBe(10)
  })
  it("scope='volume'：边界=卷起点+length-1，第3章→第10章", () => {
    expect(planGenScope(bookWithActs(), { scope: 'volume', fromChapter: 3 }))
      .toMatchObject({ scope: 'volume', stopAtChapter: 10, volumeNo: 1 })
  })
  it('未建卷档案：优雅退回单章（fallback），绝不失控狂奔', () => {
    expect(planGenScope(newProject('裸书'), { scope: 'act', fromChapter: 2 }))
      .toMatchObject({ scope: 'chapter', stopAtChapter: 2, fallback: true })
  })
  it('有卷无幕：act 粒度退回单章（fallback）', () => {
    const b = bookWithActs(); b.volumes[0].acts = []
    expect(planGenScope(b, { scope: 'act', fromChapter: 3 }).fallback).toBe(true)
  })
  it('fromChapter 省略：从已有章数推导下一章', () => {
    const b = bookWithActs(); b.chapters = [{ chapterNo: 4 }, { chapterNo: 2 }]
    expect(planGenScope(b, { scope: 'chapter' }).fromChapter).toBe(5)
  })
})

// ==================== Editor 合成定向重写指令（§7 逐章意见 + 逻辑硬门） ====================
describe('buildRevisionPrompt：作者意见 + 逻辑硬门 fixPrompt 合成修订指令', () => {
  it('两者皆空 → 空串（调用方据此禁用重写，绝不发空指令）', () => {
    expect(buildRevisionPrompt({ userNotes: [], logicFixPrompt: '' })).toBe('')
    expect(buildRevisionPrompt()).toBe('')
  })
  it('仅作者意见：编号列出 + 最高优先级措辞，不含硬门段', () => {
    const r = buildRevisionPrompt({ userNotes: ['妹妹不该睡着', '结尾补一句环境描写'] })
    expect(r).toContain('最高优先级')
    expect(r).toContain('1. 妹妹不该睡着')
    expect(r).toContain('2. 结尾补一句环境描写')
    expect(r).not.toContain('逻辑硬门')
  })
  it('仅逻辑硬门：输出硬门段，不含作者意见段', () => {
    const r = buildRevisionPrompt({ logicFixPrompt: '1. [越界·剧透] 提前揭示身世' })
    expect(r).toContain('逻辑硬门')
    expect(r).toContain('提前揭示身世')
    expect(r).not.toContain('最高优先级')
  })
  it('意见 + 硬门：意见段在前、硬门段在后（创作意图优先于客观修法）', () => {
    const r = buildRevisionPrompt({ userNotes: ['改A'], logicFixPrompt: '1. [x] 修B' })
    expect(r.indexOf('改A')).toBeLessThan(r.indexOf('修B'))
    expect(r).toContain('最高优先级')
    expect(r).toContain('逻辑硬门')
  })
  it('userNotes 元素可为 {text} 对象或字符串，空白项被剔除', () => {
    const r = buildRevisionPrompt({ userNotes: [{ text: '对象意见' }, '字符串意见', '   ', { text: '' }] })
    expect(r).toContain('1. 对象意见')
    expect(r).toContain('2. 字符串意见')
    expect(r).not.toContain('3.')
  })
})

// ==================== 逐章用户意见数据模型（§9 userNotes 持久化） ====================
describe('addUserNote / applyUserNotes：逐章意见持久化（纯函数、不 mutate 入参）', () => {
  function bookWithChapter() {
    const p = newProject('意见书')
    p.chapters = [{ id: 'c3', chapterNo: 3, title: '第三章', content: '正文', wordCount: 2 }]
    return p
  }
  it('addUserNote：追加一条未落实意见（applied=false，带 id/at），原对象不被 mutate', () => {
    const p = bookWithChapter()
    const next = addUserNote(p, 3, '这里节奏太赶')
    const notes = next.chapters[0].userNotes
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ text: '这里节奏太赶', applied: false })
    expect(notes[0].id).toBeTruthy()
    expect(p.chapters[0].userNotes).toBeUndefined()
  })
  it('addUserNote：空白意见被忽略（原样返回，不加条目）', () => {
    const p = bookWithChapter()
    expect(addUserNote(p, 3, '   ')).toBe(p)
    expect(addUserNote(p, 3, '')).toBe(p)
  })
  it('addUserNote：只命中目标章，其余章不动', () => {
    const p = bookWithChapter()
    p.chapters.push({ id: 'c4', chapterNo: 4, content: 'x' })
    const next = addUserNote(p, 3, '只改第三章')
    expect(next.chapters.find((c) => c.chapterNo === 4).userNotes).toBeUndefined()
  })
  it('applyUserNotes(省略 ids)：把该章全部未落实意见标记为已落实', () => {
    let p = bookWithChapter()
    p = addUserNote(p, 3, '意见一')
    p = addUserNote(p, 3, '意见二')
    const next = applyUserNotes(p, 3)
    expect(next.chapters[0].userNotes.every((n) => n.applied)).toBe(true)
  })
  it('applyUserNotes(指定 ids)：只标记选中的意见', () => {
    let p = bookWithChapter()
    p = addUserNote(p, 3, '意见一')
    p = addUserNote(p, 3, '意见二')
    const firstId = p.chapters[0].userNotes[0].id
    const next = applyUserNotes(p, 3, [firstId])
    expect(next.chapters[0].userNotes[0].applied).toBe(true)
    expect(next.chapters[0].userNotes[1].applied).toBe(false)
  })
  it('已落实意见不再计入下次修订指令（与 buildRevisionPrompt 的协作约定）', () => {
    let p = bookWithChapter()
    p = addUserNote(p, 3, '待落实意见')
    const un1 = p.chapters[0].userNotes.filter((n) => !n.applied)
    expect(buildRevisionPrompt({ userNotes: un1 })).toContain('待落实意见')
    const after = applyUserNotes(p, 3)
    const un2 = after.chapters[0].userNotes.filter((n) => !n.applied)
    expect(buildRevisionPrompt({ userNotes: un2 })).toBe('')
  })
})
