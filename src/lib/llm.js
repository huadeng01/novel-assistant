// DeepSeek API 客户端：浏览器直连（已验证官方支持 CORS），SSE 流式解析
import { safeGetItem, safeSetItem } from './utils.js'

const API_URL = 'https://api.deepseek.com/v1/chat/completions'
const MODEL = 'deepseek-chat'

// 通义千问（Qwen，第二写作引擎，可选）：阿里云百炼 DashScope OpenAI 兼容模式；
// 与 DeepSeek 同为 OpenAI 兼容协议，chatStream / chatJSON 全链复用，切换只改 url/model。
// 模型 ID 可在「我的」页自定义，默认 qwen3.8-max。
const QWEN_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
// 通义千问默认模型 id。
export const QWEN_DEFAULT_MODEL = 'qwen3.8-max'


// 读用户自定义的模型 id，没存则回默认模型。
export const getQwenModel = () => safeGetItem('qwen_model') || QWEN_DEFAULT_MODEL

// 写作引擎选择：'qwen'（默认，项目主引擎 qwen3.8-max）或 'deepseek'，存 localStorage。
// 全站所有生成请求（写作/规划/归档/重写）统一走当前选中的引擎，API Key 各自独立保存。
// 决策3(B)：默认回落值 deepseek→qwen（此前无 localStorage 记录时回落 deepseek，与项目主引擎不符；App.jsx:86 的 UI 默认那半边在 C 区、不归本次）
export const writerProvider = () => (safeGetItem('writer_provider') === 'deepseek' ? 'deepseek' : 'qwen')
// 把当前写作引擎（deepseek / qwen）写进 localStorage。
export const setWriterProvider = (p) => safeSetItem('writer_provider', p === 'qwen' ? 'qwen' : 'deepseek')
// 引擎 id 到中文名的映射。
export const WRITER_LABELS = { deepseek: 'DeepSeek', qwen: '通义千问' }
// 当前引擎的中文名。
export const writerProviderLabel = () => WRITER_LABELS[writerProvider()]

// 当前写作引擎的连接配置（url / model / 文案标签 / 本机存的 Key / 是否需要关思考模式）
// thinking=true 时 qwen 开思考模式（成文与灵感补全问题用，约束执行靠落笔前规划）；其余调用保持关（快）
export function writerConfig(thinking = false) {
  return writerProvider() === 'qwen'
    ? { url: QWEN_URL, model: getQwenModel(), provider: '通义千问', key: safeGetItem('qwen_api_key') || '', noThinking: !thinking }
    : { url: API_URL, model: MODEL, provider: 'DeepSeek', key: safeGetItem('ds_api_key') || '', noThinking: false }
}

// 把 API 错误翻译成人话，小白用户不需要看原始报错（provider 用于区分文案）
function friendlyError(status, data, provider = 'DeepSeek') {
  if (status === 401) return new Error(`${provider} API Key 无效或已过期，请到「我的」页面检查并重新填写。`)
  if (status === 402) return new Error(`${provider} 账户余额不足，请到对应开放平台充值后再试。`)
  if (status === 429) return new Error('请求太频繁了，请稍等几秒再试。')
  if (status >= 500) return new Error(`${provider} 服务暂时开小差了，请稍后再试。`)
  return new Error(data?.error?.message || `请求失败（${status}），请稍后重试。`)
}

// 防复读（温和兜底）：LLM 写长正文时易在尾部进入“复读机”循环、整段重吐前文。
// frequency/presence_penalty 是 OpenAI 兼容端点（DeepSeek/通义）标准的解码级防重复参数，取温和值只作安全网、不使文风生硬。
// 关键边界1：惩罚会降低“重复 token”的概率，而【结构化枚举输出】（章名骨架/细纲：每行都必须重复“第/章/｜/任务：”等结构 token）
// 与【JSON】（字段名必须重复）恰恰依赖重复 token——对它们加惩罚会诱发格式崩坏（把“任务：”替换成英文“task:”、断号、思维链泄漏）。
// 因此 chatStream 默认【不带】惩罚，只有【长正文散文生成】显式 opt-in（展开 ANTI_REPETITION）；chatJSON 永远不带。
// 关键边界2（Round-5 受控 A/B 实测，见 测试报告/05）：frequency_penalty 的惩罚量 = 系数 × 该 token 已出现次数，【无上限累积】。
// 逗号是中文正文最高频 token（一章 60~90 个），0.3 × 70 ≈ 21 logit，足以在生成后段把标点彻底压死：
//   freq=0.3（旧值）→ 逗号密度 2.13/百字、同一篇内前半 4.35 → 后半归 0、出现 409 字无标点串（run-on）；
//   freq=0  → 逗号密度 6.68/百字（人类《剑来》参照 7.6）、run-on 归 0、最长句 409 → 131（人类参照 158）；
//   且两种取值的【重复短语检出均为 0】——防复读并不依赖解码惩罚，而由 prompts 规则12 + dedupe* 确定性去重 + 落库前自检承担。
// 故 frequency_penalty 归零（它是 run-on 主因、代价为零）；presence_penalty 保留——它只按“是否出现过”计一次、
// 不随次数累积，不会压死高频标点，仍对“整段重吐前文”类复读保留安全网。
const DRAFT_FREQUENCY_PENALTY = 0
const DRAFT_PRESENCE_PENALTY = 0.2
// 长正文散文生成的防复读预设：仅章节正文/续写/改写等散文路径展开使用；骨架/细纲/规划/JSON 一律不用。
export const ANTI_REPETITION = { frequencyPenalty: DRAFT_FREQUENCY_PENALTY, presencePenalty: DRAFT_PRESENCE_PENALTY }

// ============ 统一超时 + 重试（全链路收口，调用方只传预算） ============
// 背景：dashscope 偶发「HTTP 连接还活着但不再吐字」的僵死流，单请求可 in-flight >10 分钟，
// 把整条自动连写静默拖停（表现为某章之后再无落库、也没有报错）。超时统一在 llm.js 实现，
// 调用方不再各自手写 AbortController + setTimeout（此前只有 LongFormPage.planJSON 有一套，其余路径全裸）。
//
// 语义区分（关键，别混）：
//   - 流式：timeoutMs 是【空闲看门狗】——只有「正文 delta 真的变长」才重置计时；SSE 心跳/空 delta 不算进展。
//     另用 totalTimeoutMs 作总时长兜底，防「每几分钟挤一个字」的病态慢流靠不断 touch 永不超时。
//     为什么不把总时长当唯一判据：一章 2000~4000 字的合法生成本身就可能要几分钟，
//     总时长硬上限会误杀正常长章 → 重试从头重写 → 更慢、且已写好的半章白扔。
//   - 非流式：没有增量概念，timeoutMs 就是总时长。
//
// 重试与 abort 的边界：
//   - 只有【看门狗触发的超时】才重试（默认 1 次）。
//   - 外部 signal 主动 abort（用户点「停止」）原样上抛 AbortError、绝不重试——用户停了还偷偷跑是不可接受的。
//   - 超时最终失败抛 name='TimeoutError'，【不复用 AbortError】：上层 consistency/editor/runtime 都把 AbortError
//     当「用户停止」直接终止整条连写；超时属于服务抖动，应走各自的降级（skipped）让连写继续跑下一章。
export const LLM_TIMEOUT = {
  STREAM_IDLE: 300_000, // 流式默认：300s 无正文进展判僵死
  STREAM_TOTAL: 1_800_000, // 流式默认总时长兜底：30min
  JSON: 120_000, // 非流式默认：120s
  // 只有以上三档默认值：原 SCENE_IDLE / SCENE_TOTAL / CHAPTER_TOTAL / REVIEW_JSON（曾宣称「单场景更快 / 整章兜底 / 审校更宽」）
  //   全库零调用方（仅测试断言其大小关系），已删——所有流式走 STREAM_IDLE/STREAM_TOTAL、所有非流式走 JSON。
}

// 结构化输出（JSON）请求使用的温度。
export const STRUCTURED_TEMP = 0.3

// 开启思考模式的请求里思考 token 的预算。
export const THINKING_BUDGET = 4000

// 合并「外部用户 signal」与「内部看门狗计时器」为单个可传给 fetch 的 signal。
// touch() 由流式解析循环在拿到正文增量时调用，用于重置空闲计时；非流式不调用即可。
function makeWatchdog({ signal, idleMs, totalMs }) {
  const ac = new AbortController()
  let idleTimer = null
  let firedBy = null
  const onExternalAbort = () => ac.abort()
  if (signal) {
    if (signal.aborted) ac.abort()
    else signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  const fire = (by) => {
    if (!firedBy) firedBy = by
    ac.abort()
  }
  const armIdle = () => {
    if (idleMs == null) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => fire('idle'), idleMs)
  }
  const totalTimer = totalMs == null ? null : setTimeout(() => fire('total'), totalMs)
  armIdle()
  return {
    signal: ac.signal,
    touch: armIdle,
    // 计时器与监听器必须清干净：否则每次调用都往外部 signal 上挂一个常驻监听，长连写会累积泄漏
    dispose: () => {
      clearTimeout(idleTimer)
      if (totalTimer) clearTimeout(totalTimer)
      signal?.removeEventListener?.('abort', onExternalAbort)
    },
    timedOut: () => Boolean(firedBy),
    firedBy: () => firedBy,
  }
}

// 超时错误：name 用 TimeoutError 而非 AbortError（上层把 AbortError 当「用户停止」终止整条连写）；
// by 区分是「长时间无新内容」还是「总时长兜底」触发，消息与 timeoutKind 都要如实反映，便于事后排查是僵死还是慢。
export function llmTimeoutError({ by = 'idle', idleMs, totalMs, attempts = 1 }) {
  const detail = by === 'total' ? `总时长超过 ${Math.round((totalMs || 0) / 1000)} 秒` : `${Math.round((idleMs || 0) / 1000)} 秒没有新内容`
  const e = new Error(`AI 响应超时（${detail}），已重试 ${Math.max(0, attempts - 1)} 次仍无响应，本次调用放弃。`)
  e.name = 'TimeoutError'
  e.timeoutKind = by
  return e
}

function userAbortError() {
  const e = new Error('已停止生成')
  e.name = 'AbortError'
  return e
}

// ============ 用量核算（token 计量）+ 并发闸（多 agent 并行的安全阀） ============
// 为什么要它：分卷多 agent 建书会一次并行跑多个卷 agent。此前全站**从不读响应里的 usage**，
// 一次建书/写书花了多少 token 完全不可知（成本无法评估）；也没有任何并发上限（并行无法安全开）。
// 口径纪律：
//   · usage 读不到就记 **null**，绝不补 0 —— 0 会被下游当成「真实用量是零」，与「没测到」无法区分。
//   · calls 记的是**真实发出的请求数**，含超时重试的每一次尝试（每次重试都是一份新 token）。
//   · 累计值只在「至少读到一次 usage」时才是数字，否则保持 null（未激活），文案见 llmUsageText。
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

// 各家 OpenAI 兼容端点（DeepSeek / dashscope）的 usage 字段名一致，但**给不给**不一致：
// 非流式都给；流式默认只在最后一个分片给，dashscope 兼容模式还要显式开 stream_options.include_usage
// （见 doFetch）。input_tokens/output_tokens 是 dashscope 原生模式的别名，一并容错读。
export function parseUsage(u) {
  if (!u || typeof u !== 'object') return null
  const promptTokens = num(u.prompt_tokens ?? u.input_tokens)
  const completionTokens = num(u.completion_tokens ?? u.output_tokens)
  const given = num(u.total_tokens)
  const totalTokens = given != null ? given : promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null
  if (promptTokens == null && completionTokens == null && totalTokens == null) return null
  return { promptTokens, completionTokens, totalTokens }
}

// 新建一份空的用量账本结构（次数与 token 计数归零）。
export function emptyUsageLedger() {
  return { calls: 0, observed: 0, promptTokens: null, completionTokens: null, totalTokens: null, byProvider: {} }
}

// 只把「真的有值」的加进去；任一侧为 null 时结果保持 null（缺测不冒充 0）
const addNullable = (a, b) => (b == null ? a : (a == null ? b : a + b))

// 5.4：用量账本持久化。原先 usageLedger 是纯内存态，刷新即清零，成本无法累积查看。
// 账本数据极小（计数 + token 累加值），存 localStorage 即可；读写都包 try/catch，隐私模式/配额满时退化为内存态、不抛错。
const store = () => (typeof localStorage === 'undefined' ? null : localStorage)
const USAGE_LEDGER_KEY = 'llm_usage_ledger'
function loadUsageLedger() {
  try {
    const raw = store()?.getItem?.(USAGE_LEDGER_KEY)
    return raw ? normalizeUsageLedger(JSON.parse(raw)) : emptyUsageLedger()
  } catch {
    return emptyUsageLedger()
  }
}
function persistUsageLedger() {
  try {
    store()?.setItem?.(USAGE_LEDGER_KEY, JSON.stringify(usageLedger))
  } catch {
    /* 隐私模式/配额满：退化为内存态，本次会话仍可见，只是刷新不保留 */
  }
}

let usageLedger = loadUsageLedger()

// 记一次真实调用。usage 传原始响应里的 usage 对象（没有就传 null）。返回记账后的快照。
export function recordLlmUsage({ provider = '', usage = null } = {}) {
  const p = provider || '未知引擎'
  const bucket = (usageLedger.byProvider[p] = usageLedger.byProvider[p] || { calls: 0, observed: 0, promptTokens: null, completionTokens: null, totalTokens: null })
  usageLedger.calls += 1
  bucket.calls += 1
  const u = parseUsage(usage)
  if (u) {
    usageLedger.observed += 1
    bucket.observed += 1
    for (const [dst, src] of [[usageLedger, u], [bucket, u]]) {
      dst.promptTokens = addNullable(dst.promptTokens, src.promptTokens)
      dst.completionTokens = addNullable(dst.completionTokens, src.completionTokens)
      dst.totalTokens = addNullable(dst.totalTokens, src.totalTokens)
    }
  }
  persistUsageLedger() // 5.4：每次记账后落盘，刷新不清零
  return llmUsage()
}

// 读本机累计的 AI 用量账本。
export function llmUsage() {
  const l = usageLedger
  return { ...l, byProvider: Object.fromEntries(Object.entries(l.byProvider).map(([k, v]) => [k, { ...v }])) }
}

// 归一外部传进来的用量对象（localStorage 老存档 / 字段缺失）：缺的就留 null，绝不补 0
export function normalizeUsageLedger(u) {
  if (!u || typeof u !== 'object') return emptyUsageLedger()
  const byProvider = {}
  const src = u.byProvider && typeof u.byProvider === 'object' ? u.byProvider : {}
  for (const [k, v] of Object.entries(src)) {
    byProvider[k] = { calls: Number(v?.calls) || 0, observed: Number(v?.observed) || 0, promptTokens: num(v?.promptTokens), completionTokens: num(v?.completionTokens), totalTokens: num(v?.totalTokens) }
  }
  return { calls: Number(u.calls) || 0, observed: Number(u.observed) || 0, promptTokens: num(u.promptTokens), completionTokens: num(u.completionTokens), totalTokens: num(u.totalTokens), byProvider }
}

// 用量 → 人话。0/0 纪律：一次都没读到 usage 时写「未激活」，不写成 0 tokens；
// 只读到一部分时把「没带的次数」说出来，否则合计值会被当成全量。
export function llmUsageText(l) {
  const s = normalizeUsageLedger(l == null ? usageLedger : l)
  const calls = Number(s.calls) || 0
  if (!calls) return 'AI 用量未激活（本次还没有任何 AI 调用）'
  const observed = Number(s.observed) || 0
  const missing = calls - observed
  const head = `AI 调用 ${calls} 次`
  if (!observed) return `${head}，token 用量未激活（${calls} 次响应都没带 usage，算不出 token，不是 0）`
  const f = (v) => (v == null ? '未测到' : String(v))
  const tail = missing > 0 ? `；另有 ${missing} 次响应没带 usage、未计入（合计是部分值，不是全量）` : ''
  return `${head}，其中 ${observed} 次带 usage：合计 ${f(s.totalTokens)} tokens（prompt ${f(s.promptTokens)} / completion ${f(s.completionTokens)}）${tail}`
}

// ---------- 并发闸 ----------
// 默认 3：写作链路本身是「一章接一章」的串行流式，正常单线跑不会撞到闸；
// 闸真正要拦的是分卷多 agent 并行 —— 6 个卷 agent 同时打出去会撞 429（dashscope 有 QPS 限制），
// 而 429 在 friendlyError 里只是「请稍等几秒再试」，会让整卷规划静默失败。
// 超限的调用**排队等**，不丢弃、不并发打出去。
export const LLM_MAX_CONCURRENT_DEFAULT = 3
// 读用户设置的并发上限，缺省回默认值。
export function llmMaxConcurrent() {
  const n = Number(safeGetItem('llm_max_concurrent'))
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : LLM_MAX_CONCURRENT_DEFAULT
}

let activeSlots = 0
const slotQueue = []

// 拿一个槽位再执行 run；槽位在整个请求生命周期（含流式读完）内占用，finally 里必定释放并唤醒下一个。
export function withLlmSlot(run) {
  return new Promise((resolve, reject) => {
    const start = () => {
      //   已排队被唤醒的 start 不能照旧放行（会超限）。超限则退回队首，等下次有槽位释放再被唤醒。
      //   退回时 activeSlots 必 ≥ max ≥ 1（否则不会走到这），故一定还有在跑的请求会触发下一次唤醒，不会饿死。
      if (activeSlots >= llmMaxConcurrent()) { slotQueue.unshift(start); return }
      activeSlots += 1
      Promise.resolve()
        .then(run)
        .then(resolve, reject)
        .finally(() => {
          activeSlots -= 1
          const next = slotQueue.shift()
          if (next) next()
        })
    }
    if (activeSlots < llmMaxConcurrent()) start()
    else slotQueue.push(start)
  })
}

// run(watchdogSignal, touch) → 结果；超时重试 retries 次（默认 1），用户 abort 立即上抛不重试。
// 并发闸包在重试外层：一次 chatStream 调用（含它的所有重试）只占一个槽位，
// 否则重试会在闸上再排一次队，6 个卷 agent 的排队深度会随重试翻倍、且看起来像并发失控。
async function callWithTimeout({ signal, idleMs, totalMs, retries = 1, run }) {
  return withLlmSlot(() => callWithTimeoutInner({ signal, idleMs, totalMs, retries, run }))
}

async function callWithTimeoutInner({ signal, idleMs, totalMs, retries = 1, run }) {
  // 前置守卫：调用前用户就已停止 → 连一次请求都不发（真实 fetch 虽会立刻拒绝，但没必要白发一次）
  if (signal?.aborted) throw userAbortError()
  let lastKind = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    // 上一轮超时后、重试前用户已点停止：不再发起新请求
    if (attempt > 0 && signal?.aborted) throw userAbortError()
    const wd = makeWatchdog({ signal, idleMs, totalMs })
    try {
      return await run(wd.signal, wd.touch)
    } catch (e) {
      // 只有看门狗自己触发的 abort 才算超时；用户停止（或其他网络/HTTP 错误）原样上抛，交给调用方既有策略
      if (!wd.timedOut()) throw e
      lastKind = wd.firedBy()
    } finally {
      wd.dispose()
    }
  }
  throw llmTimeoutError({ by: lastKind, idleMs, totalMs, attempts: retries + 1 })
}

async function doFetch({ apiKey, messages, stream, temperature, jsonMode, maxTokens, signal, url, model, provider, frequencyPenalty, presencePenalty, thinking = false }) {
  // 未显式传 url 时（写作链路）按当前选中的写作引擎路由；显式传 url/model/provider 的（如指定引擎测试 Key）不受影响
  const cfg = url ? { url, model, provider } : writerConfig(thinking)
  //   不再回落到调用方传入的 apiKey —— 那可能是另一家引擎的 Key，打到当前引擎域名会 401、且 friendlyError 会指认错引擎。
  const effectiveKey = url ? apiKey : cfg.key
  if (!effectiveKey) throw new Error(`当前写作引擎（${cfg.provider || '未知'}）未填 API Key，请到「我的」页面填写后再试。`)
  const body = { model: cfg.model, messages, stream, temperature }
  // 流式必须显式要 usage：dashscope 兼容模式（以及 DeepSeek）默认**不在流式响应里回 usage**，
  // 带上 include_usage 后最后一个分片的 choices 为空数组、usage 才有值。解析侧对空 choices 已容错。
  if (stream) body.stream_options = { include_usage: true }
  // qwen3 系列默认开启思考模式：思考内容走 reasoning_content 字段，本站解析器只读 content，
  // 表现为长时间无响应；且官方要求思考模式只能用于流式请求，非流式（归档/诊断等 JSON 调用）会报错。
  // 建书等求快的调用关思考（noThinking=true → enable_thinking=false）；成文与灵感补全问题要落笔前规划，
  //   显式 url 路径（testKeyFor）的 cfg 不带 noThinking，故这里直接按「非流式 + dashscope(qwen) 域名」兜底关闭。
  const isQwen = String(cfg.url || '').includes('dashscope')
  if (cfg.noThinking || (!stream && isQwen)) {
    body.enable_thinking = false
  } else if (isQwen && stream) {
    //   否则思考无上限（默认=模型最大思维链长度）会把 max_tokens=16000 吃光 → content 阶段无空间 → 正文全空（本轮实测 ~255s 空稿、completion +18579/正文 0）。
    //   dashscope 兼容模式把 thinking_budget 直接放进 body JSON（官方文档确认，与 enable_thinking 同法；见 THINKING_BUDGET 注释）。
    //   deepseek（!isQwen，非思考）与 qwen 非流式/建书快路（上面已 enable_thinking=false）都不进这支、不加 thinking_budget。
    body.enable_thinking = true
    body.thinking_budget = THINKING_BUDGET
  }
  if (jsonMode) body.response_format = { type: 'json_object' }
  if (maxTokens) body.max_tokens = maxTokens
  // 解码级防复读（温和兜底）：仅正文流式生成会传入，JSON 调用不传
  if (frequencyPenalty != null) body.frequency_penalty = frequencyPenalty
  if (presencePenalty != null) body.presence_penalty = presencePenalty
  let res
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${effectiveKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if (e.name === 'AbortError') throw e
    throw new Error('网络连接失败，请检查网络后重试。')
  }
  if (!res.ok) {
    let data = {}
    try {
      data = await res.json()
    } catch {
      /* 忽略 */
    }
    throw friendlyError(res.status, data, cfg.provider)
  }
  return res
}

// 非流式：读 body 的同时把 usage 记进账本（读不到就记 null，不补 0）
async function readJsonUsage(res, provider) {
  let data
  try {
    data = await res.json()
  } catch (e) {
    recordLlmUsage({ provider, usage: null })
    throw e
  }
  recordLlmUsage({ provider, usage: data?.usage })
  //   非对象一律归一成 {}，调用方 `data.choices?.[0]?.message?.content || ''` 自然得空串、走 extractJSON 的"格式不正确"友好错误而非裸崩。
  return data && typeof data === 'object' ? data : {}
}

// 流式调用：边生成边回调，返回完整文本（用于打字机效果）；
// Key 始终取当前写作引擎的（页面层传入的可能是切换引擎前的旧值，避免拿错家的 Key 打错家的门）
// 超时：timeoutMs = 无正文进展的空闲上限（每收到增量就重置），totalTimeoutMs = 单次尝试总时长兜底；
// 超时自动重试 retries 次（默认 1），用户 abort 不重试。重试会从头重生成，onDelta 收到的是新一轮的累计文本。
export async function chatStream({
  apiKey,
  messages,
  temperature = 0.9,
  onDelta,
  signal,
  frequencyPenalty = null,
  presencePenalty = null,
  maxTokens,
  timeoutMs = LLM_TIMEOUT.STREAM_IDLE,
  totalTimeoutMs = LLM_TIMEOUT.STREAM_TOTAL,
  retries = 1,
  finishInfo = null,
  thinking = false,
}) {
  return callWithTimeout({
    signal,
    idleMs: timeoutMs,
    totalMs: totalTimeoutMs,
    retries,
    run: async (wdSignal, touch) => {
      // 每次尝试都要清空：超时重试是从头重生成，上一次尝试的 finish_reason 不属于这一份文本
      if (finishInfo && typeof finishInfo === 'object') { finishInfo.finishReason = ''; finishInfo.truncated = false; finishInfo.incomplete = false }
      //   期间用户若切换写作引擎，到 finally 再读 writerConfig().provider 会把这次消耗记到错误的引擎名下。
      const provider = writerConfig(thinking).provider
      // 流式 usage 只在最后一个分片出现（且该分片 choices 为空）；逐分片覆盖即可拿到最终值。
      // 放在 finally 里记账：僵死流被看门狗 abort、或用户点停止时，这一次请求**已经真实烧了 token**，
      // 不记就会让「总调用次数」少算（重试从头再写一遍，那一份也算）。此时 usage 多半没读到 → 记 null。
      let usage = null
      try {
        const res = await doFetch({ apiKey, messages, stream: true, temperature, signal: wdSignal, frequencyPenalty, presencePenalty, maxTokens, thinking })
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let full = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            const t = line.trim()
            if (!t.startsWith('data:')) continue
            const payload = t.slice(5).trim()
            if (payload === '[DONE]') continue
            try {
              const json = JSON.parse(payload)
              if (json?.usage) usage = json.usage
              const d = json.choices?.[0]?.delta || {}
              const delta = d.content || ''
              // 思考模式下 qwen 会先流一段 reasoning_content（此时正文 content 为空）：只喂看门狗、不进正文，
              // 否则落笔前的长思考会被「空闲无正文进展」误判僵死。正文增量仍照常 touch + 回调。
              if (d.reasoning_content) touch()
              if (delta) {
                full += delta
                // 只有真拿到正文才算「有进展」：SSE 心跳/空 delta 不重置看门狗，否则僵死流靠心跳就能永远续命
                touch()
                onDelta?.(full)
              }
              // finish_reason（T-criticfix）：max_tokens 触顶时正文会停在半句上，而流式调用**不会报错** ——
              // 此前全项目没有任何一处读它，截断 100% 静默（实测一章末句「……谁调的」无标点、无右引号就这样落库了）。
              // 各家字段位置不同（choices[0] / choices[0].delta / 顶层），一律容错读；只回填、不改返回值类型，
              // 所以存量调用方（writer/页面各处长篇流式）零改动、零回归。命中 'length' 即置 truncated=true。
              if (finishInfo && typeof finishInfo === 'object') {
                const fr = json?.choices?.[0]?.finish_reason || json?.choices?.[0]?.delta?.finish_reason || json?.finish_reason || ''
                if (fr) {
                  finishInfo.finishReason = String(fr)
                  finishInfo.truncated = finishInfo.finishReason === 'length'
                }
              }
            } catch {
              /* 单个分片解析失败不影响整体 */
            }
          }
        }
        // 用独立的 incomplete 标记（不覆盖 truncated，避免与 length 截断混淆、也不把"正常收尾但 provider 不发 finish_reason"误判成坏稿）；UI 据此提示"可能不完整"。
        if (finishInfo && typeof finishInfo === 'object' && full && !finishInfo.finishReason) finishInfo.incomplete = true
        if (finishInfo && typeof finishInfo === 'object') finishInfo.empty = !full
        return full
      } finally {
        recordLlmUsage({ provider, usage })
      }
    },
  })
}

// 非流式调用并要求 JSON 输出，解析失败时抛错由调用方重试
// timeoutMs 即总时长（无增量概念）；超时自动重试 retries 次（默认 1），用户 abort 不重试。
// 注意：JSON 格式崩坏（extractJSON 抛错）不属于超时，不在此处重试——各调用方已有「降温重问一次」的既有策略。
export async function chatJSON({ apiKey, messages, temperature = 0.4, signal, timeoutMs = LLM_TIMEOUT.JSON, retries = 1 }) {
  const data = await callWithTimeout({
    signal,
    idleMs: timeoutMs,
    totalMs: null,
    retries,
    run: async (wdSignal) => {
      const provider = writerConfig().provider
      let res
      try {
        res = await doFetch({ apiKey, messages, stream: false, temperature, jsonMode: true, signal: wdSignal })
      } catch (e) {
        recordLlmUsage({ provider, usage: null })
        throw e
      }
      return readJsonUsage(res, provider)
    },
  })
  const text = data.choices?.[0]?.message?.content || ''
  if (data.choices?.[0]?.finish_reason === 'length') throw new Error('AI 回复超长被截断，请缩小任务范围或分步生成（并非格式错误）')
  return extractJSON(text)
}

// 从模型回复中抽取 JSON（兼容带 ```json 代码块包裹的情况）
export function extractJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim()
  // 顶层数组支持：补全问答等场景模型返回 [...]；旧逻辑只找 {...} 会把数组外层切坏导致 parse 失败
  if (cleaned.startsWith('[')) {
    const as = cleaned.indexOf('[')
    const ae = cleaned.lastIndexOf(']')
    if (ae > as) {
      const slice = cleaned.slice(as, ae + 1)
      try {
        return JSON.parse(slice)
      } catch {
        try {
          return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'))
        } catch (e) {
          throw new Error('数组 JSON 解析失败：' + (e && e.message ? e.message : String(e)))
        }
      }
    }
    throw new Error('数组 JSON 未闭合（缺 ]）：AI 的输出格式不正确，正在准备重试…')
  }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI 的输出格式不正确，正在准备重试…')
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    throw new Error('AI 的输出格式不正确，正在准备重试…')
  }
}

// 用量口径的边界：所有**生成**调用（流式 + JSON）都过 callWithTimeout，自动计入账本；
// 下面的 testKeyFor 探活（max_tokens=1）不计入 —— 它不属于建书/写书，计进去会污染调用次数。
// 指定引擎测试 Key（「我的」页两个写作引擎各自测试用，不依赖当前选中项）
export async function testKeyFor(provider, apiKey) {
  const cfg = provider === 'qwen' ? { url: QWEN_URL, model: getQwenModel(), provider: '通义千问' } : { url: API_URL, model: MODEL, provider: 'DeepSeek' }
  //   加 AbortController 超时兜底（探活 max_tokens=1，正常几百 ms~数秒返回，给 20s 上限）；超时 abort → 抛友好错误让 UI 显示失败而非永挂。
  //   仍直接 doFetch、不经 readJsonUsage ⟹ 不计入账本（保持上面「探活不计入」口径）。
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 20_000)
  try {
    await doFetch({
      apiKey,
      messages: [{ role: 'user', content: '你好' }],
      stream: false,
      temperature: 0,
      maxTokens: 1,
      signal: ac.signal,
      ...cfg,
    })
    return true
  } catch (e) {
    if (ac.signal.aborted) throw new Error('测试超时：引擎长时间无响应（20 秒），请稍后重试或检查网络与 API Key')
    throw e
  } finally {
    clearTimeout(timer)
  }
}
