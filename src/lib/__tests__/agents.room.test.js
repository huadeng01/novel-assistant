// 编剧团队面板的纯函数层测试（§15）：trace.js 把 progress 事件流翻译成 agent 状态灯 + 运行摘要。
// 纯逻辑、零 Token、不碰 React——面板据此渲染「实时运行轨迹」。
import { describe, it, expect } from 'vitest'
import { deriveAgentStatus, summarizeTrace } from '../agents/trace.js'

describe('deriveAgentStatus：事件流 → 每个 agent 的状态灯', () => {
  it('空事件流 → 空状态（面板全部按 idle 渲染）', () => {
    expect(deriveAgentStatus([])).toEqual({})
    expect(deriveAgentStatus()).toEqual({})
  })
  it('drafted → writer 完成', () => {
    expect(deriveAgentStatus([{ phase: 'drafted' }])).toMatchObject({ writer: 'done' })
  })
  it('critiqued 通过 → logic/editor 完成', () => {
    const s = deriveAgentStatus([{ phase: 'critiqued', pass: true, blockers: 0 }])
    expect(s).toMatchObject({ logic: 'done', editor: 'done' })
  })
  it('critiqued 未过（有硬门 blocker）→ logic/editor 标为 blocked', () => {
    const s = deriveAgentStatus([{ phase: 'critiqued', pass: false, blockers: 2 }])
    expect(s).toMatchObject({ logic: 'blocked', editor: 'blocked' })
  })
  it('revised → polisher 完成；revise-start → polisher 运行中', () => {
    expect(deriveAgentStatus([{ agent: 'polisher', phase: 'revise-start' }])).toMatchObject({ polisher: 'running' })
    expect(deriveAgentStatus([{ phase: 'revised' }])).toMatchObject({ polisher: 'done' })
  })
  it('显式 agent 起止：start→running、done→done、error→error、aborted→idle', () => {
    expect(deriveAgentStatus([{ agent: 'showrunner', phase: 'start' }])).toMatchObject({ showrunner: 'running' })
    expect(deriveAgentStatus([{ agent: 'archivist', phase: 'done' }])).toMatchObject({ archivist: 'done' })
    expect(deriveAgentStatus([{ agent: 'writer', phase: 'error' }])).toMatchObject({ writer: 'error' })
    expect(deriveAgentStatus([{ agent: 'writer', phase: 'aborted' }])).toMatchObject({ writer: 'idle' })
  })
  it('按时间顺序后发覆盖先发：一章完整跑完后各 agent 落到 done', () => {
    const trace = [
      { agent: 'showrunner', phase: 'start' },
      { agent: 'writer', phase: 'start' },
      { phase: 'drafted' },
      { agent: 'writer', phase: 'done' },
      { phase: 'critiqued', pass: false, blockers: 1 }, // 首轮未过 → blocked
      { agent: 'polisher', phase: 'revise-start' },
      { phase: 'revised' },
      { phase: 'critiqued', pass: true, blockers: 0 },  // 复审通过 → 覆盖为 done
      { agent: 'showrunner', phase: 'done' },
      { agent: 'archivist', phase: 'done' },
    ]
    expect(deriveAgentStatus(trace)).toMatchObject({
      showrunner: 'done', writer: 'done', logic: 'done', editor: 'done', polisher: 'done', archivist: 'done',
    })
  })
})

describe('summarizeTrace：本次运行摘要', () => {
  it('空流 → 全 0、lastPass=null', () => {
    expect(summarizeTrace([])).toMatchObject({ events: 0, drafts: 0, critiques: 0, revisions: 0, lastPass: null })
  })
  it('计数 drafts/critiques/revisions/errors 正确', () => {
    const trace = [
      { phase: 'drafted' }, { phase: 'critiqued', pass: false, blockers: 1 }, { phase: 'revised' },
      { phase: 'drafted' }, { phase: 'critiqued', pass: true, blockers: 0 }, { agent: 'x', phase: 'error' },
    ]
    const s = summarizeTrace(trace)
    expect(s.drafts).toBe(2)
    expect(s.critiques).toBe(2)
    expect(s.revisions).toBe(1)
    expect(s.errors).toBe(1)
    expect(s.lastPass).toBe(true) // 最近一次裁决通过
  })
  it('lastPass 取最近一次 critiqued；未过则 false + lastBlockers', () => {
    const s = summarizeTrace([{ phase: 'critiqued', pass: true }, { phase: 'critiqued', pass: false, blockers: 3 }])
    expect(s.lastPass).toBe(false)
    expect(s.lastBlockers).toBe(3)
  })
  it('chapters 去重 + 升序，忽略无章号事件', () => {
    const s = summarizeTrace([{ phase: 'drafted', chapterNo: 5 }, { phase: 'drafted' }, { phase: 'drafted', chapterNo: 3 }, { phase: 'critiqued', chapterNo: 5 }])
    expect(s.chapters).toEqual([3, 5])
  })
})
