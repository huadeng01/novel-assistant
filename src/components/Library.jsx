import { useRef, useState } from 'react'
import Ic from './Ic.jsx'
import { READ_ACCEPT } from '../lib/docio.js'
import { GENRE_OPTIONS } from '../hooks/useLibrary.js'

// 书库侧边栏：导入设备上的小说、选择参考书、查看与编辑文风档案
// 电脑 / 平板统一走系统文件选择器（iPad 从「文件」App 选择）
export default function Library({ lib, apiKey, onNeedKey, showStyle = true }) {
  const {
    books,
    importFile,
    removeBook,
    selectedId,
    selectedBook,
    select,
    style,
    analyzing,
    analyze,
    updateForbidden,
    genre,
    setGenre,
  } = lib
  const fileRef = useRef(null)
  const [err, setErr] = useState('')
  const [newWord, setNewWord] = useState('')

  const onPick = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setErr('')
    try {
      const book = await importFile(file)
      select(book.id)
    } catch (ex) {
      setErr(ex?.message || String(ex)) // M22：非 Error 抛出时 ex.message 为 undefined，界面会完全不提示
    }
  }

  const onAnalyze = async () => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    setErr('')
    try {
      await analyze(apiKey)
    } catch (ex) {
      setErr(ex?.message || String(ex)) // M22：非 Error 抛出时 ex.message 为 undefined，界面会完全不提示
    }
  }

  const addWord = async () => {
    const w = newWord.trim()
    if (!w || !style) return
    const fb = style.forbidden || [] // M21：早期档案可能缺 forbidden 字段
    if (!fb.includes(w)) {
      try {
        await updateForbidden([...fb, w]) // M-12：等待落库；失败明确提示，不静默吞掉用户输入
      } catch (ex) {
        setErr(ex?.message || String(ex))
        return
      }
    }
    setNewWord('')
  }

  // M-12：移除禁用词同样等待落库 + 失败提示（原内联 onClick 不 await/catch，put 失败则界面保持旧黑名单、用户以为已删）
  // L6：按位置删而非按值删——禁用词若有重复(历史脏数据/AI 返回重复项)，filter(x=>x!==w) 会把同名的多个一起删掉
  const removeWord = async (idx) => {
    try {
      await updateForbidden((style.forbidden || []).filter((_, j) => j !== idx))
    } catch (ex) {
      setErr(ex?.message || String(ex))
    }
  }

  return (
    <div className="space-y-4">
      {/* 书库 */}
      <section className="glass-card rounded-2xl bg-paper p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold"><Ic n="library" /> 我的书库</h3>
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-full bg-stone-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-700"
          >
            + 导入小说
          </button>
          <input ref={fileRef} type="file" accept={READ_ACCEPT} className="hidden" onChange={onPick} />
        </div>
        <p className="mt-2 text-xs text-stone-400">支持 .txt / .md / .docx 文件，电脑从磁盘选择，平板从「文件」App 选择。（老式 .doc 请先用 Word / WPS 另存为 .docx）</p>

        {err && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}

        <ul className="mt-3 space-y-2">
          {books.length === 0 && <li className="rounded-xl border border-dashed border-stone-300 p-4 text-center text-xs text-stone-400">还没有小说，点右上角导入</li>}
          {books.map((b) => (
            <li
              key={b.id}
              className={`flex cursor-pointer items-center justify-between rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                selectedId === b.id ? 'border-stone-800 bg-stone-800 text-white' : 'border-stone-200 hover:bg-stone-50'
              }`}
              onClick={() => select(b.id)}
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{b.title || b.name}</p>
                <p className={`text-xs ${selectedId === b.id ? 'text-stone-300' : 'text-stone-400'}`}>{b.wordCount || 0} 字</p>
              </div>
              <button
                onClick={async (e) => {
                  e.stopPropagation()
                  // C7：书名用 title||name，避免 title-only 记录在确认框显示《undefined》
                  if (!window.confirm(`确定删除《${b.title || b.name}》吗？其文风档案也会一并删除。`)) return
                  try {
                    await removeBook(b.id)
                  } catch (ex) {
                    setErr(ex?.message || String(ex)) // 删除失败明确提示（配合 useBooks M-11）
                  }
                }}
                className={`ml-2 shrink-0 rounded-full px-2 py-1 text-xs ${
                  selectedId === b.id ? 'text-stone-200 hover:bg-stone-700 hover:text-red-200' : 'text-stone-400 hover:bg-stone-100 hover:text-red-400'
                }`}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* H9：showStyle=false（续写页）时隐藏「题材 + 文风档案」两块——续写页已删文风块、不消费 genre/文风，显示它们是假承诺且诱导用户白烧一次文风分析 */}
      {showStyle && (
        <>
      {/* 5.3：题材——影响未绑书/未分析时的主导嗓音；绑定并分析过的书会自动带出其档案里存的题材 */}
      <section className="glass-card rounded-2xl bg-paper p-4 shadow-sm">
        <h3 className="text-sm font-bold"><Ic n="notepad" /> 题材</h3>
        <p className="mt-1 text-xs text-stone-400">选择本书题材，改写润色页会套用该题材的基准笔法（句长 / 段长 / 节奏）。（续写页已改为直接参照原文风格，不再消费此题材）</p>
        <select
          value={genre || ''}
          onChange={(e) => setGenre(e.target.value)}
          className="mt-2 w-full rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 text-sm focus:border-stone-500 focus:outline-none"
        >
          <option value="">不限（用默认嗓音）</option>
          {GENRE_OPTIONS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </section>

      {/* 文风档案 */}
      {selectedBook && (
        <section className="glass-card rounded-2xl bg-paper p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold"><Ic n="style" /> 文风档案</h3>
            {style && (
              <button onClick={onAnalyze} disabled={analyzing} className="text-xs text-stone-400 underline hover:text-stone-600 disabled:opacity-50">
                重新分析
              </button>
            )}
          </div>

          {analyzing ? (
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-stone-50 p-4 text-sm text-stone-500">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600" />
              正在抽样分析《{selectedBook.title || selectedBook.name}》的开头、中间与结尾…约需 1 分钟
            </div>
          ) : style ? (
            <div className="mt-3 space-y-3 text-sm">
              <p className="rounded-xl bg-stone-50 p-3 text-xs leading-relaxed text-stone-600">{style.profile}</p>
              {(style.habits || []).length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {(style.habits || []).map((h, i) => (
                    <span key={`${h}-${i}`} className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-600">
                      {h}
                    </span>
                  ))}
                </div>
              )}
              <div>
                <p className="text-xs font-semibold text-stone-500">自定义禁用词（可选，AI 会避免使用这些表达，点击词条可移除）</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {(style.forbidden || []).map((w, i) => (
                    <button
                      key={`${w}-${i}`}
                      onClick={() => removeWord(i)}
                      className="rounded-full bg-red-50 px-2.5 py-1 text-xs text-red-400 hover:bg-red-100"
                      title="点击移除"
                    >
                      {w} <Ic n="x" />
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={newWord}
                    onChange={(e) => setNewWord(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addWord()}
                    placeholder="手动添加禁用词…"
                    className="flex-1 rounded-lg border border-stone-200 px-3 py-1.5 text-xs focus:border-stone-500 focus:outline-none"
                  />
                  <button onClick={addWord} className="rounded-lg bg-stone-800 px-3 py-1.5 text-xs text-white hover:bg-stone-700">
                    添加
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-3">
              <p className="text-xs leading-relaxed text-stone-500">
                选中《{selectedBook.title || selectedBook.name}》后，AI 会抽取这本书的开头、中间与结尾共 7 段样本，深度拆解你的书写习惯（约 600~800 字的文风档案）；后续所有改写与成文都会严格贴合你的文风，AI 自身也会自动去除 AI 腔表达。
              </p>
              <button onClick={onAnalyze} className="mt-3 w-full rounded-full bg-stone-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-700">
                分析文风（约 1 分钟）
              </button>
            </div>
          )}
        </section>
      )}
        </>
      )}
    </div>
  )
}
