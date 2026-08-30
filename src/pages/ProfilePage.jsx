import { useRef, useState } from 'react'
import { testKey } from '../lib/llm.js'
import { exportBackup, importBackup, wipeAll } from '../lib/backup.js'

export default function ProfilePage({ apiKey, onKeyChange }) {
  const [input, setInput] = useState(apiKey)
  const [visible, setVisible] = useState(false)
  const [testing, setTesting] = useState(false)
  const [msg, setMsg] = useState(null) // {type: 'ok'|'err', text}
  const [wiping, setWiping] = useState(false)
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
      await testKey(key)
      setMsg({ type: 'ok', text: '连接成功！Key 有效，可以开始写作了。' })
    } catch (e) {
      setMsg({ type: 'err', text: e.message })
    } finally {
      setTesting(false)
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
      <section className="rounded-2xl bg-[#fffaf6] p-6 shadow-sm">
        <h2 className="text-base font-bold">🚀 三步开始使用</h2>
        <ol className="mt-4 space-y-3 text-sm text-stone-600">
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-stone-800 text-xs text-white">1</span>
            <span>在本页填写你的 DeepSeek API Key（见下方获取方法）。</span>
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

      {/* Key 管理 */}
      <section className="rounded-2xl bg-[#fffaf6] p-6 shadow-sm">
        <h2 className="text-base font-bold">🔑 API Key</h2>
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

      {/* 数据管理 */}
      <section className="rounded-2xl bg-[#fffaf6] p-6 shadow-sm">
        <h2 className="text-base font-bold">💾 数据备份</h2>
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
