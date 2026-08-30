import { useRef, useState } from 'react'

// 书库侧边栏：导入设备上的小说、选择参考书、查看与编辑文风档案
// 电脑 / 平板统一走系统文件选择器（iPad 从「文件」App 选择）
export default function Library({ lib, apiKey, onNeedKey }) {
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
      setErr(ex.message)
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
      setErr(ex.message)
    }
  }

  const addWord = () => {
    const w = newWord.trim()
    if (!w || !style) return
    if (!style.forbidden.includes(w)) updateForbidden([...style.forbidden, w])
    setNewWord('')
  }

  return (
    <div className="space-y-4">
      {/* 书库 */}
      <section className="rounded-2xl bg-[#fffaf6] p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold">📚 我的书库</h3>
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-full bg-stone-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-700"
          >
            + 导入小说
          </button>
          <input ref={fileRef} type="file" accept=".txt,.md" className="hidden" onChange={onPick} />
        </div>
        <p className="mt-2 text-xs text-stone-400">支持 .txt / .md 文件，电脑从磁盘选择，平板从「文件」App 选择。</p>

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
                <p className="truncate font-medium">{b.name}</p>
                <p className={`text-xs ${selectedId === b.id ? 'text-stone-300' : 'text-stone-400'}`}>{b.wordCount} 字</p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  window.confirm(`确定删除《${b.name}》吗？其文风档案也会一并删除。`) && removeBook(b.id)
                }}
                className={`ml-2 shrink-0 rounded-full px-2 py-1 text-xs ${
                  selectedId === b.id ? 'text-stone-300 hover:bg-stone-700' : 'text-stone-400 hover:bg-stone-100'
                }`}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* 文风档案 */}
      {selectedBook && (
        <section className="rounded-2xl bg-[#fffaf6] p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold">🖋 文风档案</h3>
            {style && (
              <button onClick={onAnalyze} disabled={analyzing} className="text-xs text-stone-400 underline hover:text-stone-600 disabled:opacity-50">
                重新分析
              </button>
            )}
          </div>

          {analyzing ? (
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-stone-50 p-4 text-sm text-stone-500">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600" />
              正在分析《{selectedBook.name}》的写作习惯…约需 20 秒
            </div>
          ) : style ? (
            <div className="mt-3 space-y-3 text-sm">
              <p className="rounded-xl bg-stone-50 p-3 text-xs leading-relaxed text-stone-600">{style.profile}</p>
              {style.habits.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {style.habits.map((h) => (
                    <span key={h} className="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-600">
                      {h}
                    </span>
                  ))}
                </div>
              )}
              <div>
                <p className="text-xs font-semibold text-stone-500">自定义禁用词（可选，AI 会避免使用这些表达，点击词条可移除）</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {style.forbidden.map((w) => (
                    <button
                      key={w}
                      onClick={() => updateForbidden(style.forbidden.filter((x) => x !== w))}
                      className="rounded-full bg-red-50 px-2.5 py-1 text-xs text-red-600 hover:bg-red-100"
                      title="点击移除"
                    >
                      {w} ✕
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
                选中《{selectedBook.name}》后，AI 会参照这本书拆分出你的书写习惯，后续所有改写都会严格贴合你的文风；AI 自身也会自动去除 AI 腔表达。
              </p>
              <button onClick={onAnalyze} className="mt-3 w-full rounded-full bg-stone-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-700">
                分析文风（约 20 秒）
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
