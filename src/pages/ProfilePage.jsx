import { useRef, useState } from 'react'
import Ic from '../components/Ic.jsx'
import { testKeyFor, QWEN_DEFAULT_MODEL, llmUsageText } from '../lib/llm.js'
import { exportBackup, importBackup, wipeAll } from '../lib/backup.js'

// M14：localStorage 读写统一包 try/catch——隐私模式/存储被禁用/配额满时，读抛错会让 useState 初始化失败→白屏，写抛错会让后续 setState/onKeyChange 不执行→"看起来成功实际没存"
const safeGet = (k, d = '') => {
  try {
    const v = localStorage.getItem(k)
    return v == null ? d : v
  } catch {
    return d
  }
}
const safeSet = (k, v) => {
  try {
    localStorage.setItem(k, v)
    return true
  } catch {
    return false
  }
}
const safeRemove = (k) => {
  try {
    localStorage.removeItem(k)
  } catch {
    /* 忽略：存储不可用时清除本就是 no-op */
  }
}

export default function ProfilePage({ apiKey, qwenKey, provider, onProviderChange, onKeyChange }) {
  const [input, setInput] = useState(apiKey)
  const [visible, setVisible] = useState(false)
  const [testing, setTesting] = useState(false)
  const [msg, setMsg] = useState(null) // {type: 'ok'|'err', text}
  const [wiping, setWiping] = useState(false)
  // 通义千问（Qwen，第二写作引擎，可选）：Key 与模型 ID 分开管理，都存 localStorage，与 DeepSeek 二选一生效
  const [qwenInput, setQwenInput] = useState(qwenKey || '')
  const [qwenModelInput, setQwenModelInput] = useState(() => safeGet('qwen_model') || QWEN_DEFAULT_MODEL)
  const [qwenVisible, setQwenVisible] = useState(false)
  const [qwenTesting, setQwenTesting] = useState(false)
  const [qwenMsg, setQwenMsg] = useState(null)
  const importRef = useRef(null)
  // 5.4：AI 用量（累计调用次数 / token）。账本已持久化到 localStorage，进本页时读一次；点「刷新用量」取最新值。
  const [usageText, setUsageText] = useState(() => llmUsageText())

  const save = () => {
    const key = input.trim()
    if (!key) return
    safeSet('ds_api_key', key)
    onKeyChange()
    setMsg({ type: 'ok', text: 'Key 已保存到本机浏览器，仅你自己可见。' })
  }

  const clear = () => {
    safeRemove('ds_api_key')
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

  // 通义千问 Key 的保存 / 清除 / 测试（与 DeepSeek 二选一作为写作引擎）
  const saveQwen = () => {
    const key = qwenInput.trim()
    const model = qwenModelInput.trim() || QWEN_DEFAULT_MODEL
    safeSet('qwen_model', model)
    if (!key) {
      setQwenMsg({ type: 'err', text: '请先填写通义千问 API Key。' })
      return
    }
    safeSet('qwen_api_key', key)
    onKeyChange()
    setQwenMsg({ type: 'ok', text: `已保存（模型：${model}）${provider === 'qwen' ? '，当前写作引擎即通义千问。' : '；如需启用请点击上方「通义千问」。'}` })
  }

  const clearQwen = () => {
    safeRemove('qwen_api_key')
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
    safeSet('qwen_model', qwenModelInput.trim() || QWEN_DEFAULT_MODEL)
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

  // M-8：导出是唯一的数据逃生口，失败必须明确告知(exportBackup 内部 Promise.all 任一 reject 即整体失败)，不能静默
  const onExport = async () => {
    try {
      await exportBackup()
      setMsg({ type: 'ok', text: '备份已导出（含小说、文风档案与草稿）。' })
    } catch (err) {
      setMsg({ type: 'err', text: '导出失败：' + (err && err.message ? err.message : String(err)) })
    }
  }

  const onImport = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      await importBackup(file)
      // L-14：本页不持有书库列表(useBooks 在改写/续写页)，导入后无法就地刷新；提示切到书库页查看(切页会重新挂载并 refresh)
      setMsg({ type: 'ok', text: '备份导入成功，小说与文风档案已恢复。请切换到「改写润色」或「续写」页，在左侧书库查看导入的书。' })
    } catch (err) {
      setMsg({ type: 'err', text: err.message || '导入失败，请确认文件是否正确。' })
    }
  }

  const wipe = async () => {
    setWiping(true)
    try {
      await wipeAll()
      setMsg({ type: 'ok', text: '已清空本地小说、文风档案、草稿与诊断缓存（API Key、AI 用量账本、题材选择未清）。' }) // M15：文案对齐 wipeAll 实际范围，不再笼统说"全部清空"
    } catch (err) {
      // M-7：wipeAll 失败(IndexedDB 被 blocked / 事务中止)也要退出 loading，否则按钮永久卡在"清空中…"
      setMsg({ type: 'err', text: '清空失败：' + (err && err.message ? err.message : String(err)) })
    } finally {
      setWiping(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* 小白上手引导 */}
      <section className="glass-card rounded-2xl bg-paper p-6 shadow-sm">
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
          <p className="font-semibold text-ink">如何获取 DeepSeek API Key？</p>
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

      {/* 写作引擎选择：全站生成请求（写作/规划/归档/重写）二选一 */}
      <section className="glass-card rounded-2xl bg-paper p-6 shadow-sm">
        <h2 className="text-base font-bold"><Ic n="shuffle" /> 写作引擎</h2>
        <p className="mt-2 text-sm text-stone-500">全站写作类请求走当前选中的引擎，两个 Key 各自独立、可随时切换。</p>
        <div className="mt-3 flex gap-3">
          {[
            { id: 'deepseek', label: 'DeepSeek', desc: apiKey ? '已配置 Key' : '未配置 Key' },
            { id: 'qwen', label: '通义千问', desc: qwenKey ? `已配置 Key · ${safeGet('qwen_model') || QWEN_DEFAULT_MODEL}` : '未配置 Key' },
          ].map((p) => (
            <button
              key={p.id}
              onClick={() => onProviderChange(p.id)}
              className={`flex-1 rounded-xl border px-4 py-3 text-left transition-colors ${
                provider === p.id ? 'border-stone-800 bg-stone-800 text-white' : 'border-stone-200 bg-paper text-stone-600 hover:bg-stone-50'
              }`}
            >
              <span className="block text-sm font-semibold">{p.label}{provider === p.id && '（当前）'}</span>
              <span className={`block text-xs ${provider === p.id ? 'text-stone-300' : 'text-stone-400'}`}>{p.desc}</span>
            </button>
          ))}
        </div>
      </section>

      {/* Key 管理：DeepSeek */}
      <section className="glass-card rounded-2xl bg-paper p-6 shadow-sm">
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
            <button onClick={clear} className="rounded-full border border-red-200 px-5 py-2.5 text-sm text-red-400 hover:bg-red-50">
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
      <section className="glass-card rounded-2xl bg-paper p-6 shadow-sm">
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
            <button onClick={clearQwen} className="rounded-full border border-red-200 px-5 py-2.5 text-sm text-red-400 hover:bg-red-50">
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

      {/* 5.4：AI 用量（账本已持久化到 localStorage，刷新不清零） */}
      <section className="glass-card rounded-2xl bg-paper p-6 shadow-sm">
        <h2 className="text-base font-bold"><Ic n="pulse" /> AI 用量</h2>
        <p className="mt-2 text-sm text-stone-500">
          本机累计的 AI 调用次数与 token 用量，保存在浏览器本地、刷新不清零（「测试连接」探活不计入）。token 仅在服务商响应带 usage 时才能统计，未带 usage 的调用只计次数、不冒充 0。
        </p>
        <p className="mt-3 rounded-lg bg-stone-50 px-3 py-2 text-sm text-stone-700">{usageText}</p>
        <button
          onClick={() => setUsageText(llmUsageText())}
          className="mt-3 rounded-full border border-stone-300 px-5 py-2.5 text-sm text-stone-700 hover:bg-stone-50"
        >
          刷新用量
        </button>
      </section>

      {/* 数据管理 */}
      <section className="glass-card rounded-2xl bg-paper p-6 shadow-sm">
        <h2 className="text-base font-bold"><Ic n="save" /> 数据备份</h2>
        <p className="mt-2 text-sm text-stone-500">
          你的小说和文风档案只存在当前设备的浏览器里。换设备或清理浏览器缓存前，请先导出备份。
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button onClick={onExport} className="rounded-full bg-stone-800 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700">
            导出备份
          </button>
          <button onClick={() => importRef.current?.click()} className="rounded-full border border-stone-300 px-5 py-2.5 text-sm text-stone-700 hover:bg-stone-50">
            导入备份
          </button>
          <input ref={importRef} type="file" accept=".json" className="hidden" onChange={onImport} />
          <button
            onClick={() => window.confirm('确定要清空本机所有小说与文风档案吗？此操作不可恢复！') && wipe()}
            disabled={wiping}
            className="rounded-full border border-red-200 px-5 py-2.5 text-sm text-red-400 hover:bg-red-50 disabled:opacity-50"
          >
            {wiping ? '清空中…' : '清空小说与档案'}
          </button>
        </div>
      </section>
    </div>
  )
}
