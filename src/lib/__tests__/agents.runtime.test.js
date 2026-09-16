// agents 运行时地基测试：验证编排原语（零依赖纯逻辑）+ 名册元数据。
// 这些是阶段2/3 具体 agent 的底座，必须先保证 criticLoop / runSequence / mergeVerdicts 语义正确。
import { describe, it, expect } from 'vitest'
import {
  makeProgress,
  runAgent,
  runSequence,
  runParallel,
  mergeVerdicts,
  criticLoop,
  AGENTS,
  AGENT_MAP,
  CONCEPT_AGENTS,
  WRITING_AGENTS,
  ROLE_THEME,
  PIPELINE,
} from '../agents/index.js'

describe('makeProgress 事件流', () => {
  it('push 记录事件并带时间戳，snapshot 返回副本', () => {
    const p = makeProgress()
    p.push({ phase: 'a' })
    p.push({ phase: 'b' })
    const snap = p.snapshot()
    expect(snap.length).toBe(2)
    expect(snap[0].phase).toBe('a')
    expect(typeof snap[0].t).toBe('number')
    snap.push({ phase: 'c' }) // 改副本不影响内部
    expect(p.snapshot().length).toBe(2)
  })
  it('clear 清空', () => {
    const p = makeProgress()
    p.push({ phase: 'a' })
    p.clear()
    expect(p.snapshot().length).toBe(0)
  })
})

describe('runAgent 单 agent 执行', () => {
  it('成功返回 {ok,out} 并 push start/done', async () => {
    const p = makeProgress()
    const r = await runAgent({ id: 'a', role: 'generate', run: async () => 'out' }, { progress: p })
    expect(r).toEqual({ ok: true, agent: 'a', out: 'out' })
    expect(p.snapshot().map((e) => e.phase)).toEqual(['start', 'done'])
  })
  it('业务错误降级为 {ok:false} 不抛，push error', async () => {
    const p = makeProgress()
    const r = await runAgent({ id: 'a', role: 'generate', run: async () => { throw new Error('boom') } }, { progress: p })
    expect(r.ok).toBe(false)
    expect(r.error.message).toBe('boom')
    expect(p.snapshot().at(-1).phase).toBe('error')
  })
  it('AbortError 向上抛（用户停止需冒泡）', async () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    await expect(runAgent({ id: 'a', role: 'generate', run: async () => { throw err } }, {})).rejects.toThrow('aborted')
  })
})

describe('runSequence 串行流水线', () => {
  it('前一个 out 灌入下一个 prev，seed 起步', async () => {
    const a = { id: 'a', role: 'generate', run: async (ctx) => (ctx.prev || '') + 'A' }
    const b = { id: 'b', role: 'generate', run: async (ctx) => (ctx.prev || '') + 'B' }
    const r = await runSequence([a, b], { seed: 's' })
    expect(r.ok).toBe(true)
    expect(r.out).toBe('sAB')
  })
  it('任一失败即短路，后续不执行', async () => {
    const a = { id: 'a', role: 'generate', run: async () => { throw new Error('x') } }
    let bRan = false
    const b = { id: 'b', role: 'generate', run: async () => { bRan = true; return 'B' } }
    const r = await runSequence([a, b], {})
    expect(r.ok).toBe(false)
    expect(r.failedAt).toBe('a')
    expect(r.results.length).toBe(1)
    expect(bRan).toBe(false)
  })
})

describe('runParallel 并发', () => {
  it('全部成功 ok=true，结果按序', async () => {
    const a = { id: 'a', role: 'generate', run: async () => 1 }
    const b = { id: 'b', role: 'generate', run: async () => 2 }
    const r = await runParallel([a, b], {})
    expect(r.ok).toBe(true)
    expect(r.results.map((x) => x.out)).toEqual([1, 2])
  })
  it('单个失败 ok=false 但不中断其余', async () => {
    const a = { id: 'a', role: 'generate', run: async () => { throw new Error('x') } }
    const b = { id: 'b', role: 'generate', run: async () => 2 }
    const r = await runParallel([a, b], {})
    expect(r.ok).toBe(false)
    expect(r.results[1].out).toBe(2)
  })
})

describe('mergeVerdicts 裁决合并', () => {
  it('全过且无 blocker → pass', () => {
    expect(mergeVerdicts([{ pass: true }, { pass: true }]).pass).toBe(true)
  })
  it('有 blocker → 不过', () => {
    const m = mergeVerdicts([{ pass: true }, { pass: true, blockers: ['剧透'] }])
    expect(m.pass).toBe(false)
    expect(m.blockers).toEqual(['剧透'])
  })
  it('任一 pass===false → 不过', () => {
    expect(mergeVerdicts([{ pass: true }, { pass: false }]).pass).toBe(false)
  })
  it('拼接各 critic 的 fixPrompt', () => {
    expect(mergeVerdicts([{ fixPrompt: 'a' }, { fixPrompt: 'b' }]).fixPrompt).toBe('a\nb')
  })
  it('汇总 findings', () => {
    const m = mergeVerdicts([{ findings: [1, 2] }, { findings: [3] }])
    expect(m.findings).toEqual([1, 2, 3])
  })
})

describe('criticLoop 写-审-改循环', () => {
  it('一次通过：不改写，rounds=1', async () => {
    let revised = false
    const r = await criticLoop({
      generate: async () => 'draft1',
      critics: [async () => ({ pass: true })],
      revise: async () => { revised = true; return 'draft2' },
      maxRounds: 1,
    })
    expect(r.draft).toBe('draft1')
    expect(r.passed).toBe(true)
    expect(r.rounds).toBe(1)
    expect(revised).toBe(false)
  })
  it('不过后重写再过：draft 更新，rounds=2', async () => {
    let n = 0
    const r = await criticLoop({
      generate: async () => 'draft1',
      critics: [async () => { n += 1; return n === 1 ? { pass: false, fixPrompt: 'fix' } : { pass: true } }],
      revise: async ({ draft }) => draft + '-revised',
      maxRounds: 2,
    })
    expect(r.draft).toBe('draft1-revised')
    expect(r.passed).toBe(true)
    expect(r.rounds).toBe(2)
  })
  it('耗尽轮数仍不过：passed=false，重写次数=maxRounds', async () => {
    let reviseCount = 0
    const r = await criticLoop({
      generate: async () => 'draft1',
      critics: [async () => ({ pass: false, blockers: ['硬伤'] })],
      revise: async ({ draft }) => { reviseCount += 1; return draft + '!' },
      maxRounds: 1,
    })
    expect(r.passed).toBe(false)
    expect(r.rounds).toBe(2)
    expect(reviseCount).toBe(1)
  })
  it('maxRounds=0：只审不改（事中不停的纯检测）', async () => {
    let revised = false
    const r = await criticLoop({
      generate: async () => 'draft1',
      critics: [async () => ({ pass: false, blockers: ['x'] })],
      revise: async () => { revised = true; return 'draft2' },
      maxRounds: 0,
    })
    expect(revised).toBe(false)
    expect(r.passed).toBe(false)
    expect(r.rounds).toBe(1)
  })
  it('多 critic 合并裁决（硬门+语义）', async () => {
    const r = await criticLoop({
      generate: async () => 'draft1',
      critics: [async () => ({ pass: true }), async () => ({ pass: false, blockers: ['逻辑断裂'] })],
      revise: async ({ draft }) => draft + '-fixed',
      maxRounds: 1,
    })
    // 首轮被 editor 拦下 → 重写 → 次轮仍被拦（critic 恒定）→ 耗尽
    expect(r.passed).toBe(false)
    expect(r.draft).toBe('draft1-fixed')
  })
  it('无 revise 时不过也直接返回', async () => {
    const r = await criticLoop({
      generate: async () => 'draft1',
      critics: [async () => ({ pass: false })],
      maxRounds: 3,
    })
    expect(r.passed).toBe(false)
    expect(r.rounds).toBe(1)
  })
})

describe('registry 编剧团队名册', () => {
  it('13 个 agent：构思层 6 + 写作层 7', () => {
    expect(AGENTS.length).toBe(13)
    expect(CONCEPT_AGENTS.length).toBe(6)
    expect(WRITING_AGENTS.length).toBe(7)
  })
  it('角色三分齐全，critic 共 3 个（pacer/logic/editor）', () => {
    expect(AGENTS.filter((a) => a.role === 'orchestrator').length).toBe(1)
    expect(AGENTS.filter((a) => a.role === 'critic').map((a) => a.id).sort()).toEqual(['editor', 'logic', 'pacer'])
  })
  it('critic 只读（不改稿）', () => {
    expect(AGENT_MAP.logic.readonly).toBe(true)
    expect(AGENT_MAP.editor.readonly).toBe(true)
  })
  it('PIPELINE 8 阶段，故事线起、归档止', () => {
    expect(PIPELINE.length).toBe(8)
    expect(PIPELINE[0].id).toBe('storyline')
    expect(PIPELINE.at(-1).id).toBe('archive')
  })
  it('ROLE_THEME 覆盖三角色', () => {
    expect(Object.keys(ROLE_THEME).sort()).toEqual(['critic', 'generate', 'orchestrator'])
  })
  it('每个 agent 都有图标与职责', () => {
    expect(AGENTS.every((a) => a.icon && a.duty && a.name && a.cn)).toBe(true)
  })
})
