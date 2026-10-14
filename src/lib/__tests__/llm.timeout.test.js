// T3：全链路 LLM 超时 + 重试的单测（llm.js 层）。
// 要验的四件事：①僵死流被空闲看门狗砍掉并自动重试成功；②用户主动 abort 原样上抛且【不】重试；
// ③慢但持续推进的合法长流不被误杀（空闲语义 ≠ 总时长语义）；④总时长兜底能砍掉「一直挤字」的病态慢流。
// 不打真实 API：stub 全局 fetch 返回假 SSE 流。假 reader 必须像真 fetch 一样在 signal abort 时 reject，
// 否则看门狗砍不断 read()、测试自己会挂死。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chatStream, chatJSON, LLM_TIMEOUT, llmTimeoutError } from '../llm.js'

const enc = new TextEncoder()
const sse = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

const HANG = { hang: true } // 永不吐字：只有 abort 能结束它（复现 dashscope 僵死流）
const chunk = (text, delay = 0) => ({ text, delay })

function fakeReader(chunks, signal) {
  let i = 0
  return {
    read: () =>
      new Promise((resolve, reject) => {
        const onAbort = () => reject(abortErr())
        if (signal?.aborted) return onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })
        if (i >= chunks.length) {
          signal?.removeEventListener('abort', onAbort)
          return resolve({ done: true, value: undefined })
        }
        const item = chunks[i++]
        if (item.hang) return // 不 settle，等 abort
        setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve({ done: false, value: enc.encode(sse(item.text)) })
        }, item.delay)
      }),
    cancel() {},
  }
}

// responses: 按调用次序取用（超出则复用最后一个）。元素可为
//   { chunks }            → 流式响应
//   { content }           → 非流式 JSON 响应
//   { status, message }   → HTTP 错误
//   (opts) => response    → 自定义（拿得到本次的 signal）
function stubFetch(responses) {
  let n = 0
  const mock = vi.fn(async (_url, opts) => {
    const r = responses[Math.min(n++, responses.length - 1)]
    const spec = typeof r === 'function' ? await r(opts) : r
    if (spec.status) return { ok: false, status: spec.status, json: async () => ({ error: { message: spec.message } }) }
    if (spec.content != null) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: spec.content } }] }) }
    return { ok: true, status: 200, body: { getReader: () => fakeReader(spec.chunks, opts.signal) } }
  })
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

describe('chatStream 超时 + 重试', () => {
  it('僵死流：空闲看门狗砍掉 → 自动重试一次 → 第二次成功返回全文', async () => {
    const fetchMock = stubFetch([{ chunks: [HANG] }, { chunks: [chunk('第一段'), chunk('第二段')] }])
    const seen = []
    const full = await chatStream({ apiKey: 'k', messages: MSGS, timeoutMs: 20, totalTimeoutMs: 5000, onDelta: (t) => seen.push(t) })
    expect(full).toBe('第一段第二段')
    expect(fetchMock).toHaveBeenCalledTimes(2) // 首次超时 + 重试一次
    expect(seen[seen.length - 1]).toBe('第一段第二段')
  })

  it('用户主动 abort：原样上抛 AbortError，且不重试（绝不偷偷续跑）', async () => {
    const fetchMock = stubFetch([{ chunks: [HANG] }])
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 15)
    await expect(chatStream({ apiKey: 'k', messages: MSGS, signal: ac.signal, timeoutMs: 5000, totalTimeoutMs: 9000 }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('调用前 signal 已 abort：一次请求都不发', async () => {
    const fetchMock = stubFetch([{ chunks: [chunk('x')] }])
    const ac = new AbortController()
    ac.abort()
    await expect(chatStream({ apiKey: 'k', messages: MSGS, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  it('重试仍僵死：抛 TimeoutError（不是 AbortError），共 2 次请求', async () => {
    const fetchMock = stubFetch([{ chunks: [HANG] }])
    const err = await chatStream({ apiKey: 'k', messages: MSGS, timeoutMs: 15, totalTimeoutMs: 5000 }).catch((e) => e)
    expect(err.name).toBe('TimeoutError')
    expect(err.timeoutKind).toBe('idle')
    expect(err.message).toMatch(/已重试 1 次/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries: 0 → 超时后不重试，只发一次请求', async () => {
    const fetchMock = stubFetch([{ chunks: [HANG] }])
    await expect(chatStream({ apiKey: 'k', messages: MSGS, timeoutMs: 15, retries: 0 })).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('慢但持续推进的合法长流不被误杀：总耗时远超 timeoutMs 仍成功（空闲语义）', async () => {
    // 每 12ms 吐一个字、共 8 个 ≈ 96ms；timeoutMs 只有 30ms。
    // 若按「总时长」判超时，这条合法慢流会被砍掉——这正是不能拿总时长当唯一判据的原因。
    const fetchMock = stubFetch([{ chunks: Array.from({ length: 8 }, (_, i) => chunk(`字${i}`, 12)) }])
    const full = await chatStream({ apiKey: 'k', messages: MSGS, timeoutMs: 30, totalTimeoutMs: 5000 })
    expect(full).toBe('字0字1字2字3字4字5字6字7')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('总时长兜底：一直挤字的病态慢流被 totalTimeoutMs 砍掉，timeoutKind=total', async () => {
    const fetchMock = stubFetch([{ chunks: Array.from({ length: 40 }, () => chunk('滴', 5)) }])
    const err = await chatStream({ apiKey: 'k', messages: MSGS, timeoutMs: 5000, totalTimeoutMs: 40, retries: 0 }).catch((e) => e)
    expect(err.name).toBe('TimeoutError')
    expect(err.timeoutKind).toBe('total')
    expect(err.message).toMatch(/总时长超过/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('HTTP 错误（429）原样上抛、不当超时重试：换调用方的既有降级策略处理', async () => {
    const fetchMock = stubFetch([{ status: 429, message: 'slow down' }])
    await expect(chatStream({ apiKey: 'k', messages: MSGS, timeoutMs: 5000 })).rejects.toThrow('请求太频繁')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('重试期间用户点停止：归类为用户停止上抛 AbortError，不会拿超时顶替、也不发第三次', async () => {
    // 时序确定性做法：第二次请求一发出就同步 abort（模拟「重试刚起飞用户就点了停止」），
    // 此时内部看门狗尚未触发，必须归类为用户停止（AbortError）而不是超时（TimeoutError）。
    const ac = new AbortController()
    const fetchMock = stubFetch([{ chunks: [HANG] }, () => { ac.abort(); return { chunks: [HANG] } }])
    await expect(chatStream({ apiKey: 'k', messages: MSGS, signal: ac.signal, timeoutMs: 10, totalTimeoutMs: 5000 }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(2) // 首次 + 一次重试，停止后不再发第三次
  })
})

describe('chatJSON 超时 + 重试', () => {
  it('挂起请求超时 → 重试一次 → 第二次拿到 JSON', async () => {
    const fetchMock = stubFetch([
      (opts) => new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(abortErr()), { once: true })),
      { content: '{"ok":true}' },
    ])
    await expect(chatJSON({ apiKey: 'k', messages: MSGS, timeoutMs: 20 })).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('用户 abort 不重试', async () => {
    const fetchMock = stubFetch([(opts) => new Promise((_r, reject) => opts.signal.addEventListener('abort', () => reject(abortErr()), { once: true }))])
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 10)
    await expect(chatJSON({ apiKey: 'k', messages: MSGS, signal: ac.signal, timeoutMs: 5000 })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('JSON 格式崩坏不算超时：不在 llm 层重试（交给调用方的降温重问策略）', async () => {
    const fetchMock = stubFetch([{ content: '这不是 JSON' }])
    await expect(chatJSON({ apiKey: 'k', messages: MSGS, timeoutMs: 5000 })).rejects.toThrow('格式')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('超时预算与错误构造（纯函数）', () => {
  it('llmTimeoutError：区分 idle / total 两种成因，重试次数按总尝试数算', () => {
    const idle = llmTimeoutError({ by: 'idle', idleMs: 300000, totalMs: 1800000, attempts: 2 })
    expect(idle.name).toBe('TimeoutError')
    expect(idle.timeoutKind).toBe('idle')
    expect(idle.message).toContain('300 秒没有新内容')
    expect(idle.message).toContain('已重试 1 次')
    const total = llmTimeoutError({ by: 'total', idleMs: 300000, totalMs: 1800000, attempts: 3 })
    expect(total.timeoutKind).toBe('total')
    expect(total.message).toContain('总时长超过 1800 秒')
    expect(total.message).toContain('已重试 2 次')
  })

  it('TimeoutError 不等于 AbortError：上层不会把服务超时误判成用户停止而终止整条连写', () => {
    expect(llmTimeoutError({ by: 'idle', idleMs: 1000, attempts: 1 }).name).not.toBe('AbortError')
  })

  it('LLM_TIMEOUT 预设自洽：空闲阈值 < 总时长兜底，场景级比整章级更紧', () => {
    expect(LLM_TIMEOUT.STREAM_IDLE).toBe(300_000)
    expect(LLM_TIMEOUT.JSON).toBe(120_000)
    expect(LLM_TIMEOUT.STREAM_IDLE).toBeLessThan(LLM_TIMEOUT.STREAM_TOTAL)
    expect(LLM_TIMEOUT.SCENE_IDLE).toBeLessThanOrEqual(LLM_TIMEOUT.STREAM_IDLE)
    expect(LLM_TIMEOUT.SCENE_TOTAL).toBeLessThan(LLM_TIMEOUT.CHAPTER_TOTAL)
    expect(LLM_TIMEOUT.CHAPTER_TOTAL).toBeLessThan(LLM_TIMEOUT.STREAM_TOTAL)
    expect(LLM_TIMEOUT.REVIEW_JSON).toBeGreaterThan(LLM_TIMEOUT.JSON)
  })
})
