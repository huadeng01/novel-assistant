// 灵感选题弹窗：选择题材 → 注入该题材世界模板（低权重参考，不定死世界）+ 本批发散骰（跨批拉开差异）→ 生成 5 个纯题材「写清三件事」开局选题 → 点击导入初始提问输入框（题材一同绑定）
import { useState } from 'react'
import Ic from './Ic.jsx'
import { inspirationMessages, inspirationSeed } from '../lib/prompts.js'
import { inspirationJSON } from '../lib/llm.js'
import { allGenres, getWorldview, worldviewText, isOverridden } from '../lib/worldviews/index.js'

export default function InspirationModal({ genre, apiKey, onPick, onClose }) {
  const genres = allGenres()
  const [sel, setSel] = useState(genre || genres[0])
  const [ideas, setIdeas] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [meta, setMeta] = useState(null) // { engine, seed } 本批引擎与发散骰约束

  const gen = async (g) => {
    setBusy(true)
    setErr('')
    setIdeas([])
    try {
      // 每批重新掷发散骰：相同题材连点「换一批」也能拿到不同的概念层约束，避免来回都是那几条套路
      const seed = inspirationSeed()
      const { data, engine } = await inspirationJSON({ apiKey, messages: inspirationMessages(g, worldviewText(getWorldview(g)), seed) })
      setIdeas(Array.isArray(data?.ideas) ? data.ideas.slice(0, 5) : [])
      setMeta({ engine, seed })
      if (!Array.isArray(data?.ideas) || !data.ideas.length) setErr('AI 返回的选题格式不对，请点「换一批」重试。')
    } catch (e) {
      setErr(e.message || '生成失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  // 打开弹窗不自动生成：等用户主动点击题材胶囊才生成该题材的选题

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && onClose()}>
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-[#fbf8ef] p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold">
            <Ic n="sparkle" /> 灵感：选题生成器
          </h3>
          <button onClick={onClose} disabled={busy} className="rounded-full p-1 text-stone-400 hover:bg-stone-200 hover:text-stone-700 disabled:opacity-40" title="关闭">
            <Ic n="x" />
          </button>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-stone-500">
          每批 5 个选题，全部纯题材：题材世界模板仅作低权重参考，可自由突破；点击任意一个即导入初始提问输入框。
        </p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {genres.map((g) => (
            <button
              key={g}
              onClick={() => {
                setSel(g)
                gen(g)
              }}
              disabled={busy}
              className={`rounded-full px-3 py-1 text-xs transition ${sel === g ? 'bg-stone-800 text-white' : 'bg-stone-200 text-stone-600 hover:bg-stone-300'} disabled:opacity-50`}
            >
              {g}
            </button>
          ))}
        </div>

        {meta && !busy && (
          <p className="mt-2 text-xs text-stone-400">
            引擎 {meta.engine} · 参考「{sel}」世界模板{isOverridden(sel) ? '（你改过的版本）' : '（内置）'}生成（模板仅供参考）；模板可在「世界观」里查看与修改。
            {meta.seed && <span className="mt-0.5 block">本批发散骰：{meta.seed}（每批随机，想要别的方向就「换一批」）</span>}
          </p>
        )}
        {!busy && !err && ideas.length === 0 && (
          <p className="mt-3 rounded-xl bg-stone-100 px-4 py-3 text-sm text-stone-500">点击上方题材，即为该题材生成 5 个「写清三件事」开局选题（纯题材 · 大脑洞）。</p>
        )}
        {busy && <p className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">正在基于「{sel}」世界观构思选题…</p>}
        {err && <p className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{err}</p>}

        <div className="mt-3 flex-1 space-y-2 overflow-y-auto pr-1">
          {ideas.map((it, i) => (
            <button
              key={i}
              onClick={() => onPick(it.brief, sel)}
              className="block w-full rounded-xl border border-stone-200 bg-white/60 p-3 text-left transition hover:border-stone-500 hover:bg-white"
            >
              <p className="text-sm font-semibold text-stone-800">
                {i + 1}. {it.title || '未命名选题'}
              </p>
              <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-stone-500">{it.brief}</p>
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-stone-400">点击选题 = 导入初始提问（题材一同带入）</p>
          <button onClick={() => gen(sel)} disabled={busy} className="rounded-full bg-stone-800 px-4 py-2 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50">
            <Ic n="shuffle" /> 换一批
          </button>
        </div>
      </div>
    </div>
  )
}
