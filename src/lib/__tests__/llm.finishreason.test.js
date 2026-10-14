// chatStream 回传 finish_reason（T-criticfix ②）：此前全项目没有任何一处读它，
// max_tokens 触顶造成的截断 100% 静默（正文停在半句、无右引号，照样落库）。
// 不打真实 API：stub 全局 fetch 返回假 SSE 流（harness 与 llm.timeout.test.js 同口径）。
// 修前会红：master 的 chatStream 不接 finishInfo 入参，下面的断言全部落空。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chatStream } from '../llm.js'

const enc = new TextEncoder()
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`
const content = (t) => ({ choices: [{ delta: { content: t } }] })

function fakeReader(payloads) {
  let i = 0
  return {
    read: () => Promise.resolve(i >= payloads.length
      ? { done: true, value: undefined }
      : { done: false, value: enc.encode(sse(payloads[i++])) }),
    cancel() {},
  }
}

function stubFetch(payloads) {
  const mock = vi.fn(async (_url, opts) => ({ ok: true, status: 200, body: { getReader: () => fakeReader(payloads) } }))
  vi.stubGlobal('fetch', mock)
  return mock
}

const MSGS = [{ role: 'user', content: 'x' }]

beforeEach(() => {
  const store = new Map([['writer_provider', 'deepseek'], ['ds_api_key', 'test-key']])
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('chatStream 的 finishInfo 出参', () => {
  it("finish_reason==='length' → truncated=true（正文照旧返回，由调用方决定弃稿）", async () => {
    stubFetch([content('他推开门，屋里很暗，只听见'), { choices: [{ delta: {}, finish_reason: 'length' }] }])
    const info = {}
    const text = await chatStream({ apiKey: 'k', messages: MSGS, finishInfo: info })
    expect(text).toBe('他推开门，屋里很暗，只听见')
    expect(info).toMatchObject({ finishReason: 'length', truncated: true })
  })

  it("finish_reason==='stop' → truncated=false（正常收尾不得被误判成坏稿）", async () => {
    stubFetch([content('他推开门，屋里很暗。'), { choices: [{ delta: {}, finish_reason: 'stop' }] }])
    const info = {}
    await chatStream({ apiKey: 'k', messages: MSGS, finishInfo: info })
    expect(info).toMatchObject({ finishReason: 'stop', truncated: false })
  })

  it('字段位置容错：顶层 finish_reason / delta 内 finish_reason 都认', async () => {
    stubFetch([content('半句'), { finish_reason: 'length' }])
    const a = {}
    await chatStream({ apiKey: 'k', messages: MSGS, finishInfo: a })
    expect(a.truncated).toBe(true)

    stubFetch([content('半句'), { choices: [{ delta: { finish_reason: 'length' } }] }])
    const b = {}
    await chatStream({ apiKey: 'k', messages: MSGS, finishInfo: b })
    expect(b.truncated).toBe(true)
  })

  it('provider 压根不给 finish_reason → 保持空串/false，不误判', async () => {
    stubFetch([content('他推开门。')])
    const info = {}
    await chatStream({ apiKey: 'k', messages: MSGS, finishInfo: info })
    expect(info).toMatchObject({ finishReason: '', truncated: false })
  })

  it('不传 finishInfo（存量调用方）→ 行为与改造前逐字一致，返回值仍是字符串', async () => {
    stubFetch([content('他推开门。'), { choices: [{ delta: {}, finish_reason: 'length' }] }])
    const out = await chatStream({ apiKey: 'k', messages: MSGS })
    expect(typeof out).toBe('string')
    expect(out).toBe('他推开门。')
  })
})
