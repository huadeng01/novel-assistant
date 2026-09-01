// DeepSeek API 客户端：浏览器直连（已验证官方支持 CORS），SSE 流式解析
const API_URL = 'https://api.deepseek.com/v1/chat/completions'
const MODEL = 'deepseek-chat'

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

async function doFetch({ apiKey, messages, stream, temperature, jsonMode, maxTokens, signal, url = API_URL, model = MODEL, provider }) {
  const body = { model, messages, stream, temperature }
  if (jsonMode) body.response_format = { type: 'json_object' }
  if (maxTokens) body.max_tokens = maxTokens
  let res
  try {
    res = await fetch(url, {
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
    throw friendlyError(res.status, data, provider)
  }
  return res
}

// 流式调用：边生成边回调，返回完整文本（用于打字机效果）
export async function chatStream({ apiKey, messages, temperature = 0.9, onDelta, signal }) {
  const res = await doFetch({ apiKey, messages, stream: true, temperature, signal })
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
  const res = await doFetch({ apiKey, messages, stream: false, temperature, jsonMode: true, signal })
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

// 用最小的请求测试 Key 是否有效
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
