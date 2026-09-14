import { useRef, useState } from 'react'
import Ic from '../components/Ic.jsx'
import { testKeyFor, testGlmKey, GLM_DEFAULT_MODEL, QWEN_DEFAULT_MODEL } from '../lib/llm.js'
import { exportBackup, importBackup, wipeAll } from '../lib/backup.js'

export default function ProfilePage({ apiKey, qwenKey, provider, onProviderChange, onKeyChange, glmKey, onGlmKeyChange }) {
  const [input, setInput] = useState(apiKey)
  const [visible, setVisible] = useState(false)
  const [testing, setTesting] = useState(false)
  const [msg, setMsg] = useState(null) // {type: 'ok'|'err', text}
  const [wiping, setWiping] = useState(false)
  // 通义千问（Qwen，第二写作引擎，可选）：Key 与模型 ID 分开管理，都存 localStorage，与 DeepSeek 二选一生效
  const [qwenInput, setQwenInput] = useState(qwenKey || '')
  const [qwenModelInput, setQwenModelInput] = useState(localStorage.getItem('qwen_model') || QWEN_DEFAULT_MODEL)
  const [qwenVisible, setQwenVisible] = useState(false)
  const [qwenTesting, setQwenTesting] = useState(false)
  const [qwenMsg, setQwenMsg] = useState(null)
  // 智谱 GLM（章节审核引擎，可选）：Key 与模型 ID 分开管理，都存 localStorage
  const [glmInput, setGlmInput] = useState(glmKey || '')
  const [glmModelInput, setGlmModelInput] = useState(localStorage.getItem('glm_model') || GLM_DEFAULT_MODEL)
  const [glmVisible, setGlmVisible] = useState(false)
  const [glmTesting, setGlmTesting] = useState(false)
  const [glmMsg, setGlmMsg] = useState(null)
  // 智谱 Embedding-3 可选开关：默认关闭（前文召回用零费用的关键词检索）；启用后长篇写作前文召回改走语义向量。
  const [embedOn, setEmbedOn] = useState(localStorage.getItem('glm_embedding') === '1')
  const importRef = useRef(null)

  const save = () => {
    const key = input.trim()
    if (!key) return
    localStorage.setItem('ds_api_key', key)
    onKeyChange()
    setMsg({ type: 'ok', text: 'Key 已保存到本机浏览器，仅你自己可见。' })
  }

  const clear = () => {
    localStorage.removeItem('ds_api_key')
    setInput('')
    onKeyChange()
    setMsg({ type: 'ok', text: 'Key 已清除。' })
  }

  const test = async () => {
    const key = input.trim() || apiKey
    if (!key) {
      setMsg({ type: 'err', text: '请先填写 API Key。' })
      return
    }
    setTesting(true)
    setMsg(null)
    try {
      await testKeyFor('deepseek', key)
      setMsg({ type: 'ok', text: '连接成功！DeepSeek Key 有效。' })
    } catch (e) {
      setMsg({ type: 'err', text: e.message })
    } finally {
      setTesting(false)
    }
  }

  // 通义千问 Key 的保存 / 清除 / 测试（与 DeepSeek 二选一作为写作引擎，审核引擎仍用智谱）
  const saveQwen = () => {
    const key = qwenInput.trim()
    const model = qwenModelInput.trim() || QWEN_DEFAULT_MODEL
    localStorage.setItem('qwen_model', model)
    if (!key) {
      setQwenMsg({ type: 'err', text: '请先填写通义千问 API Key。' })
      return
    }
    localStorage.setItem('qwen_api_key', key)
    onKeyChange()
    setQwenMsg({ type: 'ok', text: `已保存（模型：${model}）${provider === 'qwen' ? '，当前写作引擎即通义千问。' : '；如需启用请点击上方「通义千问」。'}` })
  }

  const clearQwen = () => {
    localStorage.removeItem('qwen_api_key')
    setQwenInput('')
    onKeyChange()
    setQwenMsg({ type: 'ok', text: '通义千问 Key 已清除。' })
  }

  const testQwen = async () => {
    const key = qwenInput.trim() || qwenKey
    if (!key) {
      setQwenMsg({ type: 'err', text: '请先填写通义千问 API Key。' })
      return
    }
    // 测试前先落盘模型 ID，确保测试用的就是用户配置的模型
    localStorage.setItem('qwen_model', qwenModelInput.trim() || QWEN_DEFAULT_MODEL)
    setQwenTesting(true)
    setQwenMsg(null)
    try {
      await testKeyFor('qwen', key)
      setQwenMsg({ type: 'ok', text: '连接成功！通义千问 Key 有效。' })
    } catch (e) {
      setQwenMsg({ type: 'err', text: e.message })
    } finally {
      setQwenTesting(false)
    }
  }

  // 智谱 GLM Key 的保存 / 清除 / 测试（审核引擎专用，不影响写作引擎）
  const saveGlm = () => {
    const key = glmInput.trim()
    const model = glmModelInput.trim() || GLM_DEFAULT_MODEL
    localStorage.setItem('glm_model', model)
    if (!key) {
      setGlmMsg({ type: 'err', text: '请先填写智谱 API Key。' })
      return
    }
    localStorage.setItem('glm_api_key', key)
    onGlmKeyChange()
    setGlmMsg({ type: 'ok', text: `已保存（模型：${model}），可在长篇写作的「章节审核」中使用。` })
  }

  const clearGlm = () => {
    localStorage.removeItem('glm_api_key')
    setGlmInput('')
    onGlmKeyChange()
    setGlmMsg({ type: 'ok', text: '智谱 Key 已清除。' })
  }

  const testGlm = async () => {
    const key = glmInput.trim() || glmKey
    if (!key) {
      setGlmMsg({ type: 'err', text: '请先填写智谱 API Key。' })
      return
    }
    // 测试前先落盘模型 ID，确保测试用的就是用户配置的模型
    localStorage.setItem('glm_model', glmModelInput.trim() || GLM_DEFAULT_MODEL)
    setGlmTesting(true)
    setGlmMsg(null)
    try {
      await testGlmKey(key)
      setGlmMsg({ type: 'ok', text: '连接成功！智谱 Key 有效，可以开始审核了。' })
    } catch (e) {
      setGlmMsg({ type: 'err', text: e.message })
    } finally {
      setGlmTesting(false)
    }
  }

  const onImport = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      await importBackup(file)
      setMsg({ type: 'ok', text: '备份导入成功，小说与文风档案已恢复。' })
    } catch (err) {
      setMsg({ type: 'err', text: err.message || '导入失败，请确认文件是否正确。' })
    }
  }

  const wipe = async () => {
    setWiping(true)
    await wipeAll()
    setWiping(false)
    setMsg({ type: 'ok', text: '本地数据已全部清空（Key 未受影响）。' })
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* 小白上手引导 */}
      <section className="rounded-2xl bg-[#fbf8ef] p-6 shadow-sm">
        <h2 className="text-base font-bold"><Ic n="rocket" /> 三步开始使用</h2>
        <ol className="mt-4 space-y-3 text-sm text-stone-600">
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-stone-800 text-xs text-white">1</span>
            <span>在本页选择写作引擎（DeepSeek 或通义千问）并填写对应的 API Key（见下方获取方法）。</span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-stone-800 text-xs text-white">2</span>
            <span>到「改写润色」或「新手写作」页，导入你存在设备上的小说文件（.txt / .md）。平板用户从「文件」App 选择即可。</span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-stone-800 text-xs text-white">3</span>
            <span>粘贴想修改的片段，或跟着向导一步步生成你的新小说。</span>
          </li>
        </ol>

        <div className="mt-5 rounded-xl bg-stone-50 p-4 text-sm text-stone-600">
          <p className="font-semibold text-stone-800">如何获取 DeepSeek API Key？</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>
              打开{' '}
              <a href="https://platform.deepseek.com" target="_blank" rel="noreferrer" className="text-stone-500 underline hover:text-stone-700">
                DeepSeek 开放平台
              </a>{' '}
              并注册登录。
            </li>
            <li>充值少量余额（几元即可体验很久，按使用量计费，不用不花钱）。</li>
            <li>进入「API Keys」页面，点击创建，把生成的 Key 粘贴到下方输入框。</li>
          </ol>
          <p className="mt-3 text-xs text-stone-400">
            安全说明：Key 只保存在你自己的浏览器中，请求由你的浏览器直接发给 DeepSeek，本站服务器不会接触你的 Key 与小说内容。
          </p>
        </div>
      </section>

      {/* 写作引擎选择：全站生成请求（写作/规划/归档/重写）二选一，GLM 审核引擎独立不受影响 */}
      <section className="rounded-2xl bg-[#fbf8ef] p-6 shadow-sm">
        <h2 className="text-base font-bold"><Ic n="shuffle" /> 写作引擎</h2>
        <p className="mt-2 text-sm text-stone-500">全站写作类请求走当前选中的引擎，两个 Key 各自独立、可随时切换；章节审核始终用下方的智谱 GLM（可选）。</p>
        <div className="mt-3 flex gap-3">
          {[
            { id: 'deepseek', label: 'DeepSeek', desc: apiKey ? '已配置 Key' : '未配置 Key' },
            { id: 'qwen', label: '通义千问', desc: qwenKey ? `已配置 Key · ${localStorage.getItem('qwen_model') || QWEN_DEFAULT_MODEL}` : '未配置 Key' },
          ].map((p) => (
            <button
              key={p.id}
              onClick={() => onProviderChange(p.id)}
              className={`flex-1 rounded-xl border px-4 py-3 text-left transition-colors ${
                provider === p.id ? 'border-stone-800 bg-stone-800 text-white' : 'border-stone-200 bg-white text-stone-600 hover:bg-stone-50'
              }`}
            >
              <span className="block text-sm font-semibold">{p.label}{provider === p.id && '（当前）'}</span>
              <span className={`block text-xs ${provider === p.id ? 'text-stone-300' : 'text-stone-400'}`}>{p.desc}</span>
            </button>
          ))}
        </div>
      </section>

      {/* Key 管理：DeepSeek */}
      <section className="rounded-2xl bg-[#fbf8ef] p-6 shadow-sm">
        <h2 className="text-base font-bold"><Ic n="key" /> DeepSeek API Key</h2>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type={visible ? 'text' : 'password'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="sk-..."
            className="flex-1 rounded-xl border border-stone-300 px-4 py-2.5 text-sm focus:border-stone-500 focus:outline-none"
          />
          <button onClick={() => setVisible(!visible)} className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm text-stone-600 hover:bg-stone-50">
            {visible ? '隐藏' : '显示'}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          <button onClick={save} className="rounded-full bg-stone-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700">
            保存
          </button>
          <button onClick={test} disabled={testing} className="rounded-full border border-stone-300 px-5 py-2.5 text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50">
            {testing ? '测试中…' : '测试连接'}
          </button>
          {apiKey && (
            <button onClick={clear} className="rounded-full border border-red-200 px-5 py-2.5 text-sm text-red-600 hover:bg-red-50">
              清除 Key
            </button>
          )}
        </div>
        {msg && (
          <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${msg.type === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
            {msg.text}
          </p>
        )}
      </section>

      {/* Key 管理：通义千问（Qwen，阿里云百炼，与 DeepSeek 二选一作为写作引擎） */}
      <section className="rounded-2xl bg-[#fbf8ef] p-6 shadow-sm">
        <h2 className="text-base font-bold"><Ic n="key" /> 通义千问 API Key（可选，与 DeepSeek 二选一）</h2>
        <p className="mt-2 text-sm text-stone-500">
          走阿里云百炼（DashScope）OpenAI 兼容接口。在上方「写作引擎」选中通义千问后，全站写作类请求改用此 Key；模型 ID 可自定义，默认 {QWEN_DEFAULT_MODEL}。
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type={qwenVisible ? 'text' : 'password'}
            value={qwenInput}
            onChange={(e) => setQwenInput(e.target.value)}
            placeholder="sk-...（百炼控制台获取）"
            className="flex-1 rounded-xl border border-stone-300 px-4 py-2.5 text-sm focus:border-stone-500 focus:outline-none"
          />
          <input
            value={qwenModelInput}
            onChange={(e) => setQwenModelInput(e.target.value)}
            placeholder={`模型 ID（默认 ${QWEN_DEFAULT_MODEL}）`}
            className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm focus:border-stone-500 focus:outline-none sm:w-56"
          />
          <button onClick={() => setQwenVisible(!qwenVisible)} className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm text-stone-600 hover:bg-stone-50">
            {qwenVisible ? '隐藏' : '显示'}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          <button onClick={saveQwen} className="rounded-full bg-stone-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700">
            保存
          </button>
          <button onClick={testQwen} disabled={qwenTesting} className="rounded-full border border-stone-300 px-5 py-2.5 text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50">
            {qwenTesting ? '测试中…' : '测试连接'}
          </button>
          {qwenKey && (
            <button onClick={clearQwen} className="rounded-full border border-red-200 px-5 py-2.5 text-sm text-red-600 hover:bg-red-50">
              清除 Key
            </button>
          )}
        </div>
        {qwenMsg && (
          <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${qwenMsg.type === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
            {qwenMsg.text}
          </p>
        )}
        <p className="mt-3 text-xs text-stone-400">
          获取方法：登录{' '}
          <a href="https://bailian.console.aliyun.com" target="_blank" rel="noreferrer" className="underline hover:text-stone-600">
            阿里云百炼控制台（bailian.console.aliyun.com）
          </a>
          ，在「API-KEY 管理」中创建；新用户有免费额度。不填也不影响使用 DeepSeek 写作。
        </p>
      </section>

      {/* 智谱 GLM Key（审核引擎，可选） */}
      <section className="rounded-2xl bg-[#fbf8ef] p-6 shadow-sm">
        <h2 className="text-base font-bold"><Ic n="search" /> 智谱 GLM API Key（章节审核用，可选）</h2>
        <p className="mt-2 text-sm text-stone-500">
          长篇写作中每写满 5 章可解锁一次剧情连贯性审核，由 GLM-4.7-Flash 执行（只查硬性矛盾，不挑刺）；写作本身仍用 DeepSeek，两个 Key 互不影响。
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type={glmVisible ? 'text' : 'password'}
            value={glmInput}
            onChange={(e) => setGlmInput(e.target.value)}
            placeholder="智谱 API Key（bigmodel.cn 获取，有免费额度）"
            className="flex-1 rounded-xl border border-stone-300 px-4 py-2.5 text-sm focus:border-stone-500 focus:outline-none"
          />
          <input
            value={glmModelInput}
            onChange={(e) => setGlmModelInput(e.target.value)}
            placeholder={`模型 ID（默认 ${GLM_DEFAULT_MODEL}）`}
            className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm focus:border-stone-500 focus:outline-none sm:w-56"
          />
          <button onClick={() => setGlmVisible(!glmVisible)} className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm text-stone-600 hover:bg-stone-50">
            {glmVisible ? '隐藏' : '显示'}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          <button onClick={saveGlm} className="rounded-full bg-stone-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700">
            保存
          </button>
          <button onClick={testGlm} disabled={glmTesting} className="rounded-full border border-stone-300 px-5 py-2.5 text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50">
            {glmTesting ? '测试中…' : '测试连接'}
          </button>
          {glmKey && (
            <button onClick={clearGlm} className="rounded-full border border-red-200 px-5 py-2.5 text-sm text-red-600 hover:bg-red-50">
              清除 Key
            </button>
          )}
        </div>
        {glmMsg && (
          <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${glmMsg.type === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
            {glmMsg.text}
          </p>
        )}
        <p className="mt-3 text-xs text-stone-400">
          获取方法：登录{' '}
          <a href="https://bigmodel.cn" target="_blank" rel="noreferrer" className="underline hover:text-stone-600">
            智谱开放平台（bigmodel.cn）
          </a>
          ，在「API Keys」中创建，新用户有免费额度；不填也不影响写作功能。
        </p>
      </section>

      {/* 智谱 Embedding-3 可选开关：与上方审核共用同一把智谱 Key，按量计费极便宜；不启用则前文召回用免费关键词检索 */}
      <section className="rounded-2xl bg-[#fbf8ef] p-6 shadow-sm">
        <h2 className="text-base font-bold"><Ic n="pulse" /> 语义向量召回（可选，智谱 Embedding-3）</h2>
        <p className="mt-2 text-sm text-stone-500">
          长篇写作生成初稿时，前文片段召回默认用不花钱的关键词检索。开启后改用语义向量召回（同一把智谱 Key，Embedding-3 约 0.5 元/百万 tokens，一本书全部章节向量化通常不到一毛钱，向量会缓存不重复计费），对语义相近但用词不同的前文召回更准。服务异常时自动降级回关键词检索，不影响写作。
        </p>
        <label className="mt-3 flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={embedOn}
            onChange={(e) => {
              localStorage.setItem('glm_embedding', e.target.checked ? '1' : '0')
              setEmbedOn(e.target.checked)
            }}
            className="h-4 w-4 accent-stone-700"
          />
          <span className="text-sm text-stone-700">{embedOn ? '已启用：前文召回优先走语义向量' : '未启用：用免费关键词检索（推荐先用这个）'}</span>
        </label>
        {!glmKey && embedOn && <p className="mt-2 text-xs text-amber-700">注意：还没填智谱 Key，开启后会自动降级回关键词检索；要真正生效请先在上方填写智谱 Key。</p>}
      </section>

      {/* 数据管理 */}
      <section className="rounded-2xl bg-[#fbf8ef] p-6 shadow-sm">
        <h2 className="text-base font-bold"><Ic n="save" /> 数据备份</h2>
        <p className="mt-2 text-sm text-stone-500">
          你的小说和文风档案只存在当前设备的浏览器里。换设备或清理浏览器缓存前，请先导出备份。
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button onClick={exportBackup} className="rounded-full bg-stone-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700">
            导出备份
          </button>
          <button onClick={() => importRef.current?.click()} className="rounded-full border border-stone-300 px-5 py-2.5 text-sm text-stone-700 hover:bg-stone-50">
            导入备份
          </button>
          <input ref={importRef} type="file" accept=".json" className="hidden" onChange={onImport} />
          <button
            onClick={() => window.confirm('确定要清空本机所有小说与文风档案吗？此操作不可恢复！') && wipe()}
            disabled={wiping}
            className="rounded-full border border-red-200 px-5 py-2.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            {wiping ? '清空中…' : '清空全部数据'}
          </button>
        </div>
      </section>
    </div>
  )
}
