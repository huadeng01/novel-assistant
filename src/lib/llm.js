// DeepSeek API 客户端：浏览器直连（已验证官方支持 CORS），SSE 流式解析
const API_URL = 'https://api.deepseek.com/v1/chat/completions'
const MODEL = 'deepseek-chat'

// 通义千问（Qwen，第二写作引擎，可选）：阿里云百炼 DashScope OpenAI 兼容模式；
// 与 DeepSeek 同为 OpenAI 兼容协议，chatStream / chatJSON 全链复用，切换只改 url/model。
// 模型 ID 可在「我的」页自定义，默认 qwen3.8-max。
const QWEN_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
export const QWEN_DEFAULT_MODEL = 'qwen3.8-max'
export const getQwenModel = () => localStorage.getItem('qwen_model') || QWEN_DEFAULT_MODEL

// 写作引擎选择：'deepseek'（默认）或 'qwen'，存 localStorage；GLM 审核引擎独立不受影响。
// 全站所有生成请求（写作/规划/归档/重写）统一走当前选中的引擎，API Key 各自独立保存。
export const writerProvider = () => (localStorage.getItem('writer_provider') === 'qwen' ? 'qwen' : 'deepseek')
export const setWriterProvider = (p) => localStorage.setItem('writer_provider', p === 'qwen' ? 'qwen' : 'deepseek')
export const WRITER_LABELS = { deepseek: 'DeepSeek', qwen: '通义千问' }
export const writerProviderLabel = () => WRITER_LABELS[writerProvider()]

// 当前写作引擎的连接配置（url / model / 文案标签 / 本机存的 Key / 是否需要关思考模式）
export function writerConfig() {
  return writerProvider() === 'qwen'
    ? { url: QWEN_URL, model: getQwenModel(), provider: '通义千问', key: localStorage.getItem('qwen_api_key') || '', noThinking: true }
    : { url: API_URL, model: MODEL, provider: 'DeepSeek', key: localStorage.getItem('ds_api_key') || '', noThinking: false }
}

// 智谱 GLM（审核引擎）：OpenAI 兼容协议，模型 ID 可在「我的」页自定义，默认 glm-4.7-flash
const GLM_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
export const GLM_DEFAULT_MODEL = 'glm-4.7-flash'
export const getGlmModel = () => localStorage.getItem('glm_model') || GLM_DEFAULT_MODEL

// 把 API 错误翻译成人话，小白用户不需要看原始报错（provider 用于区分文案）
function friendlyError(status, data, provider = 'DeepSeek') {
  if (status === 401) return new Error(`${provider} API Key 无效或已过期，请到「我的」页面检查并重新填写。`)
  if (status === 402) return new Error(`${provider} 账户余额不足，请到对应开放平台充值后再试。`)
  if (status === 429) return new Error('请求太频繁了，请稍等几秒再试。')
  if (status >= 500) return new Error(`${provider} 服务暂时开小差了，请稍后再试。`)
  return new Error(data?.error?.message || `请求失败（${status}），请稍后重试。`)
}

async function doFetch({ apiKey, messages, stream, temperature, jsonMode, maxTokens, signal, url, model, provider, webSearch }) {
  // 未显式传 url 时（写作链路）按当前选中的写作引擎路由；显式传 url 的（GLM 审核）不受影响
  const cfg = url ? { url, model, provider } : writerConfig()
  const body = { model: cfg.model, messages, stream, temperature }
  // qwen3 系列默认开启思考模式：思考内容走 reasoning_content 字段，本站解析器只读 content，
  // 表现为长时间无响应；且官方要求思考模式只能用于流式请求，非流式（归档/诊断等 JSON 调用）会报错。
  // 写作场景不需要思考链，统一关闭，响应也更快。
  if (cfg.noThinking) body.enable_thinking = false
  if (jsonMode) body.response_format = { type: 'json_object' }
  if (maxTokens) body.max_tokens = maxTokens
  // 联网搜索（灵感选题用）：智谱走 web_search 工具、通义走 enable_search；DeepSeek 无此能力，忽略
  if (webSearch) {
    if (cfg.provider === '智谱 GLM') body.tools = [{ type: 'web_search', web_search: { enable: true } }]
    else if (cfg.provider === '通义千问') body.enable_search = true
  }
  let res
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
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

// 流式调用：边生成边回调，返回完整文本（用于打字机效果）；
// Key 始终取当前写作引擎的（页面层传入的可能是切换引擎前的旧值，避免拿错家的 Key 打错家的门）
export async function chatStream({ apiKey, messages, temperature = 0.9, onDelta, signal }) {
  const res = await doFetch({ apiKey: writerConfig().key || apiKey, messages, stream: true, temperature, signal })
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
        const delta = json.choices?.[0]?.delta?.content || ''
        if (delta) {
          full += delta
          onDelta?.(full)
        }
      } catch {
        /* 单个分片解析失败不影响整体 */
      }
    }
  }
  return full
}

// 非流式调用并要求 JSON 输出，解析失败时抛错由调用方重试
export async function chatJSON({ apiKey, messages, temperature = 0.4, signal }) {
  const res = await doFetch({ apiKey: writerConfig().key || apiKey, messages, stream: false, temperature, jsonMode: true, signal })
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content || ''
  return extractJSON(text)
}

// 从模型回复中抽取 JSON（兼容带 ```json 代码块包裹的情况）
export function extractJSON(text) {
  const cleaned = text.replace(/```json|```/g, '')
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

// 用最小的请求测试 Key 是否有效（按当前选中的写作引擎测试）
export async function testKey(apiKey) {
  await doFetch({
    apiKey,
    messages: [{ role: 'user', content: '你好' }],
    stream: false,
    temperature: 0,
    maxTokens: 1,
  })
  return true
}

// 指定引擎测试 Key（「我的」页两个写作引擎各自测试用，不依赖当前选中项）
export async function testKeyFor(provider, apiKey) {
  const cfg = provider === 'qwen' ? { url: QWEN_URL, model: getQwenModel(), provider: '通义千问' } : { url: API_URL, model: MODEL, provider: 'DeepSeek' }
  await doFetch({
    apiKey,
    messages: [{ role: 'user', content: '你好' }],
    stream: false,
    temperature: 0,
    maxTokens: 1,
    ...cfg,
  })
  return true
}

// 灵感选题生成：纯题材脑洞（不联网搜热梗），走当前写作引擎；
// 世界观底稿由调用方注入 messages（见 worldviews 库），温度偏高鼓励发散。
export async function inspirationJSON({ apiKey, messages, temperature = 0.95 }) {
  const cfg = writerConfig()
  const res = await doFetch({ apiKey: cfg.key || apiKey, messages, stream: false, temperature })
  const data = await res.json()
  return { data: extractJSON(data.choices?.[0]?.message?.content || ''), engine: cfg.provider }
}

// ============ 智谱 GLM 客户端（章节审核引擎，与写作引擎分工） ============
// 注：GLM 不强制 JSON 模式（部分版本兼容性差），靠提示词约束 + extractJSON 抽取
export async function glmChatJSON({ apiKey, messages, temperature = 0.3, signal }) {
  const res = await doFetch({
    apiKey,
    messages,
    stream: false,
    temperature,
    signal,
    url: GLM_URL,
    model: getGlmModel(),
    provider: '智谱 GLM',
  })
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content || ''
  return extractJSON(text)
}

// ---------- 智谱 Embedding-3（可选向量召回） ----------
// 与 GLM 审核共用同一把智谱 Key；0.5 元/百万 tokens，单请求最多 64 条、单条 3072 tokens。
// 默认关闭（用不花钱的关键词/扩词检索，即方案 A）；在「我的」页开关启用后用于前文语义召回。
export const embeddingEnabled = () => localStorage.getItem('glm_embedding') === '1'

export async function glmEmbed({ apiKey, texts }) {
  let res
  try {
    res = await fetch('https://open.bigmodel.cn/api/paas/v4/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'embedding-3', input: texts }),
    })
  } catch {
    throw new Error('网络连接失败，请检查网络后重试。')
  }
  if (!res.ok) {
    let data = {}
    try {
      data = await res.json()
    } catch {
      /* 忽略 */
    }
    throw friendlyError(res.status, data, '智谱向量')
  }
  const data = await res.json()
  return (data.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

// 用最小请求测试智谱 Key 是否有效
export async function testGlmKey(apiKey) {
  await doFetch({
    apiKey,
    messages: [{ role: 'user', content: '你好' }],
    stream: false,
    temperature: 0,
    maxTokens: 1,
    url: GLM_URL,
    model: getGlmModel(),
    provider: '智谱 GLM',
  })
  return true
}
