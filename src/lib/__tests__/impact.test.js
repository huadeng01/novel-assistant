// 影响分析（P0）单测：反向索引 refs 构建、受影响章节定位、设定-正文冲突检测、编辑 diff。
// 全部纯函数、零 AI、零 Token；测的是「改设定 → 精确定位受影响章节 + 命中证据 + 冲突」这条确定性回归基线。
import { describe, it, expect } from 'vitest'
import {
  buildChapterRefs,
  buildAllChapterRefs,
  buildRefsFor,
  refsCoverage,
  impactedChapters,
  detectSettingConflicts,
  scanAllConflicts,
  impactEntities,
  detectSettingDiff,
  diffImpact,
} from '../impact.js'

// 测试用书：3 人物（苏晚已死）+ 1 规则块 + 1 设定块 + 1 金手指规则 + 1 伏笔（1 埋 8 收）+ 1 事实（c1@第2章提交）
const makeBook = () => ({
  id: 'bk',
  characters: [
    { uid: 'c1', name: '林昭', aliases: '阿昭', identity: '主角', status: '', alive: 'alive', canSpeak: true, location: '', mutableInjuries: {} },
    { uid: 'c2', name: '老周', aliases: '', identity: '守夜人', status: '', alive: 'alive', canSpeak: true, location: '', mutableInjuries: {} },
    { uid: 'c3', name: '苏晚', aliases: '苏姑娘', identity: '抄书人', status: '', alive: 'dead', canSpeak: true, location: '', mutableInjuries: {} },
  ],
  worldBlocks: [
    { id: 'b1', name: '修行铁律', aliases: '', kind: '规则', content: '夺舍者遭天谴。' },
    { id: 'b2', name: '档案库', aliases: '', kind: '设定', content: '三层木楼。' },
  ],
  bible: { powerRules: [{ id: 'pr1', name: '镇钥', trigger: '镇钥见天日', consequence: '寿元折半' }] },
  foreshadows: [{ id: 'f1', content: '玉佩是通行令', plantedChapter: 1, resolveChapter: 8, status: '已回收' }],
  facts: [{ id: 'x1', uid: 'c1', subject: '林昭', predicate: 'location', value: '青阳县', validFrom: 1, validTo: null, sourceChapter: 2 }],
  chapters: [
    { id: 'h1', chapterNo: 1, title: '开局', content: '林昭走进档案库，苏晚在门口。' },
    { id: 'h2', chapterNo: 2, title: '夜访', content: '阿昭与老周碰头，镇钥见天日。' },
    { id: 'h3', chapterNo: 8, title: '回收', content: '苏晚说道：“玉佩给你。”' },
  ],
})

const refCtx = (book, chapterNo) => ({
  characters: book.characters,
  foreshadows: book.foreshadows,
  facts: book.facts,
  worldBlocks: book.worldBlocks,
  bible: book.bible,
  chapterNo,
})

describe('buildChapterRefs 单章反向索引', () => {
  it('提取出场人物 uid，含别名归一（阿昭→c1），未出场者不计', () => {
    const r = buildChapterRefs('阿昭与老周碰头。', refCtx(makeBook(), 2))
    expect(r.chars.sort()).toEqual(['c1', 'c2'])
    expect(r.chars).not.toContain('c3')
  })

  it('规则命中只认 kind=规则 的世界块与金手指 trigger，kind=设定 不计', () => {
    const r = buildChapterRefs('阿昭与老周碰头，镇钥见天日。', refCtx(makeBook(), 2))
    expect(r.rules).toContain('pr1') // 金手指 trigger 命中
    expect(r.rules).not.toContain('b2') // 档案库是「设定」块，不计入 rules
    const r1 = buildChapterRefs('林昭走进档案库，苏晚在门口。', refCtx(makeBook(), 1))
    expect(r1.rules).not.toContain('b1') // 修行铁律未出现在正文
  })

  it('伏笔命中埋设章与回收章（planted/resolve）', () => {
    expect(buildChapterRefs(makeBook().chapters[0].content, refCtx(makeBook(), 1)).foreshadows).toEqual(['f1'])
    expect(buildChapterRefs(makeBook().chapters[2].content, refCtx(makeBook(), 8)).foreshadows).toEqual(['f1'])
    expect(buildChapterRefs(makeBook().chapters[1].content, refCtx(makeBook(), 2)).foreshadows).toEqual([])
  })

  it('事实命中 sourceChapter 本章提交的事实', () => {
    expect(buildChapterRefs(makeBook().chapters[1].content, refCtx(makeBook(), 2)).facts).toEqual(['x1'])
    expect(buildChapterRefs(makeBook().chapters[0].content, refCtx(makeBook(), 1)).facts).toEqual([])
  })
})

describe('buildAllChapterRefs / buildRefsFor / refsCoverage', () => {
  it('回填所有章节 refs，覆盖率 total=indexed、missing=0', () => {
    const book = buildAllChapterRefs(makeBook())
    expect(book.chapters.every((c) => c.refs)).toBe(true)
    expect(refsCoverage(book)).toEqual({ total: 3, indexed: 3, missing: 0 })
  })

  it('幂等：已有 refs 的章默认跳过，force=true 才重建', () => {
    const book = makeBook()
    book.chapters[0].refs = { chars: ['SENTINEL'], foreshadows: [], facts: [], rules: [] }
    const once = buildAllChapterRefs(book)
    expect(once.chapters[0].refs.chars).toEqual(['SENTINEL']) // 未覆盖
    const forced = buildAllChapterRefs(book, { force: true })
    expect(forced.chapters[0].refs.chars).not.toEqual(['SENTINEL']) // 重建
    expect(forced.chapters[0].refs.chars).toContain('c1')
  })

  it('buildRefsFor 用最终态为单章建 refs；章不存在返回 null', () => {
    const book = makeBook()
    expect(buildRefsFor(book, 2).chars.sort()).toEqual(['c1', 'c2'])
    expect(buildRefsFor(book, 999)).toBeNull()
  })

  it('未回填时 missing = 全部章数', () => {
    expect(refsCoverage(makeBook())).toEqual({ total: 3, indexed: 0, missing: 3 })
  })
})

describe('impactedChapters 受影响章节定位', () => {
  it('按人物反查（走 refs），别名章也命中，按章号升序', () => {
    const book = buildAllChapterRefs(makeBook())
    const nos = impactedChapters(book, { kind: 'character', id: 'c1' }).map((x) => x.chapterNo)
    expect(nos).toEqual([1, 2]) // 第1章「林昭」、第2章「阿昭」
    const c3 = impactedChapters(book, { kind: 'character', id: 'c3' }).map((x) => x.chapterNo)
    expect(c3).toEqual([1, 8])
  })

  it('无 refs 时降级实时匹配，结果与走索引一致', () => {
    const raw = makeBook() // 未回填
    const nos = impactedChapters(raw, { kind: 'character', id: 'c1' }).map((x) => x.chapterNo)
    expect(nos).toEqual([1, 2])
    expect(impactedChapters(raw, { kind: 'character', id: 'c1' })[0].indexed).toBe(false)
  })

  it('indexedOnly=true 时跳过未建索引章（概览/徽章路径不触发正则）', () => {
    const raw = makeBook()
    expect(impactedChapters(raw, { kind: 'character', id: 'c1' }, { indexedOnly: true })).toEqual([])
    const book = buildAllChapterRefs(raw)
    expect(impactedChapters(book, { kind: 'character', id: 'c1' }, { indexedOnly: true }).map((x) => x.chapterNo)).toEqual([1, 2])
  })

  it('按事实反查：提交章 + 生效区间∩引用主体，两条路径都命中', () => {
    const book = buildAllChapterRefs(makeBook())
    const res = impactedChapters(book, { kind: 'fact', id: 'x1' })
    const nos = res.map((x) => x.chapterNo)
    expect(nos).toEqual([1, 2]) // 第1章处于生效区间且引用 c1；第2章为提交章
    expect(res.find((x) => x.chapterNo === 2).why).toContain('提交')
    expect(res.find((x) => x.chapterNo === 1).why).toContain('生效区间')
  })

  it('按伏笔反查：埋设章到回收章', () => {
    const book = buildAllChapterRefs(makeBook())
    expect(impactedChapters(book, { kind: 'foreshadow', id: 'f1' }).map((x) => x.chapterNo)).toEqual([1, 8])
  })

  it('按规则反查：命中 trigger 的章', () => {
    const book = buildAllChapterRefs(makeBook())
    expect(impactedChapters(book, { kind: 'rule', id: 'pr1' }).map((x) => x.chapterNo)).toEqual([2])
    expect(impactedChapters(book, { kind: 'rule', id: 'b1' })).toEqual([]) // 修行铁律未出现在任何章
  })

  it('命中证据给出正文片段', () => {
    const book = buildAllChapterRefs(makeBook())
    const ev = impactedChapters(book, { kind: 'character', id: 'c1' })[0].evidence
    expect(ev.length).toBeGreaterThan(0)
    expect(ev[0].snippet).toContain('林昭')
  })

  it('空变更返回空数组', () => {
    expect(impactedChapters(makeBook(), {})).toEqual([])
    expect(impactedChapters(makeBook(), { kind: 'character', id: '' })).toEqual([])
  })
})

describe('detectSettingConflicts / scanAllConflicts 设定-正文冲突', () => {
  it('死者开口 → 冲突（第8章苏晚已死却说话）', () => {
    const conflicts = detectSettingConflicts(makeBook(), { kind: 'character', id: 'c3' })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].chapterNo).toBe(8)
    expect(conflicts[0].blockers[0].what).toContain('已死亡角色')
  })

  it('残肢发力 → 冲突（左臂断茬却左手攥笔）', () => {
    const book = makeBook()
    book.characters[0].mutableInjuries = { 左臂: '齐肘断茬' }
    book.chapters.push({ id: 'h4', chapterNo: 9, title: '写状', content: '林昭左手五指攥紧了笔。' })
    const conflicts = detectSettingConflicts(book, { kind: 'character', id: 'c1' })
    expect(conflicts.some((c) => c.chapterNo === 9)).toBe(true)
    expect(conflicts.find((c) => c.chapterNo === 9).blockers[0].category).toBe('物理不可能')
  })

  it('非限制性状态人物不扫（存活且能言 → 空）', () => {
    expect(detectSettingConflicts(makeBook(), { kind: 'character', id: 'c1' })).toEqual([])
  })

  it('非人物变更返回空（P0 冲突检测只覆盖人物受控状态）', () => {
    expect(detectSettingConflicts(makeBook(), { kind: 'rule', id: 'pr1' })).toEqual([])
  })

  it('scanAllConflicts 全书总扫：只扫限制性人物 + 已建索引章', () => {
    const book = buildAllChapterRefs(makeBook())
    const all = scanAllConflicts(book)
    expect(all.some((c) => c.uid === 'c3' && c.chapterNo === 8)).toBe(true)
    // 未回填索引时（indexedOnly）不报，避免对旧书全量正则扫描
    expect(scanAllConflicts(makeBook())).toEqual([])
  })
})

describe('impactEntities 可选实体清单', () => {
  it('人物/世界规则/金手指/伏笔分组，死者标 restrictive，设定块不计入规则', () => {
    const ents = impactEntities(makeBook())
    const byKey = (k, id) => ents.find((e) => e.kind === k && String(e.id) === String(id))
    expect(byKey('character', 'c3').restrictive).toBe(true) // 苏晚已死
    expect(byKey('character', 'c1').restrictive).toBe(false)
    expect(byKey('rule', 'b1')).toBeTruthy() // 修行铁律（规则块）
    expect(byKey('rule', 'b2')).toBeFalsy() // 档案库是「设定」块，不列入
    expect(byKey('rule', 'pr1')).toBeTruthy() // 镇钥（金手指）
    expect(byKey('foreshadow', 'f1')).toBeTruthy()
    expect(ents.every((e) => e.group && e.label)).toBe(true)
  })
})

describe('detectSettingDiff / diffImpact 编辑触发提醒', () => {
  const clone = (b) => JSON.parse(JSON.stringify(b))

  it('人物生死状态变更 → diff', () => {
    const prev = makeBook()
    const next = clone(prev)
    next.characters[2].alive = 'alive' // 苏晚复活
    const diffs = detectSettingDiff(prev, next)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({ kind: 'character', id: 'c3' })
  })

  it('人物 status / 伤残变更 → diff', () => {
    const prev = makeBook()
    const next = clone(prev)
    next.characters[0].status = '灵力余量 3 成'
    expect(detectSettingDiff(prev, next)).toHaveLength(1)
    const next2 = clone(prev)
    next2.characters[0].mutableInjuries = { 左臂: '齐肘断茬' }
    expect(detectSettingDiff(prev, next2)[0].restrictive).toBe(true)
  })

  it('新增人物不算变更（尚无历史章节引用）', () => {
    const prev = makeBook()
    const next = clone(prev)
    next.characters.push({ uid: 'c4', name: '新人', aliases: '', alive: 'alive', canSpeak: true, mutableInjuries: {} })
    expect(detectSettingDiff(prev, next)).toEqual([])
  })

  it('无关字段（大纲/梗概）编辑不触发', () => {
    const prev = makeBook()
    const next = clone(prev)
    next.outline = '全新大纲'
    next.synopsis = '全新梗概'
    expect(detectSettingDiff(prev, next)).toEqual([])
  })

  it('世界规则 content 变更 / 伏笔 status 变更 → diff', () => {
    const prev = makeBook()
    const next = clone(prev)
    next.worldBlocks[0].content = '夺舍者遭天谴，寿元折半，永不超生。'
    expect(detectSettingDiff(prev, next)).toEqual([{ kind: 'rule', id: 'b1', label: '修行铁律' }])
    const next2 = clone(prev)
    next2.foreshadows[0].status = '已提及'
    expect(detectSettingDiff(prev, next2)[0]).toMatchObject({ kind: 'foreshadow', id: 'f1' })
  })

  it('diffImpact 合并多变更的受影响章号，去重升序', () => {
    const book = buildAllChapterRefs(makeBook())
    // c1 影响 [1,2]，c3 影响 [1,8] → 合并去重 [1,2,8]
    const { chapters, count } = diffImpact(book, [
      { kind: 'character', id: 'c1' },
      { kind: 'character', id: 'c3' },
    ])
    expect(chapters).toEqual([1, 2, 8])
    expect(count).toBe(3)
  })

  it('空 diff → diffImpact 空', () => {
    expect(diffImpact(makeBook(), [])).toEqual({ chapters: [], count: 0 })
  })
})
