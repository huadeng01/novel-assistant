import { useRef, useState } from 'react'
import Ic from './Ic.jsx'
import { READ_ACCEPT } from '../lib/docio.js'
import { GENRE_OPTIONS } from '../hooks/useLibrary.js'
import { countWords } from '../lib/utils.js'

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
    loading,
    loadError,
  } = lib
  const fileRef = useRef(null)
  // 第11轮[11]：错误按归属拆两个——errImport 就近渲染在「我的书库」卡（导入/删书），errStyle 渲染在文风档案区（分析/禁用词增删），
  //   不再把禁用词的失败提示甩到隔两个 section 的书库卡顶部。wordTip 是禁用词的中性提示（如重复词），importing 防导入重入。
  const [errImport, setErrImport] = useState('')
  const [errStyle, setErrStyle] = useState('')
  const [wordTip, setWordTip] = useState('')
  const [importing, setImporting] = useState(false)
  const [newWord, setNewWord] = useState('')

  const onPick = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (importing) return // 第11轮[11]：导入进行中不重入（防连点/多次选择触发并发导入互相覆盖）
    setErrImport('')
    setImporting(true)
    try {
      const book = await importFile(file)
      select(book.id)
    } catch (ex) {
      setErrImport(ex?.message || String(ex))
    } finally {
      setImporting(false)
    }
  }

  const onAnalyze = async () => {
    if (!apiKey) {
      onNeedKey()
      return
    }
    setErrStyle('')
    try {
      await analyze(apiKey)
    } catch (ex) {
      setErrStyle(ex?.message || String(ex))
    }
  }

  const addWord = async () => {
    const w = newWord.trim()
    if (!w || !style) return
    const fb = style.forbidden || []
    if (fb.includes(w)) {
      // 第11轮[11]：重复词原来静默跳过（清了输入框却什么都不说，用户以为没加上/加了）——给一条中性提示
      setWordTip(`「${w}」已在禁用词里，未重复添加`)
      setNewWord('')
      return
    }
    setWordTip('')
    setErrStyle('')
    try {
      await updateForbidden((fb) => (fb.includes(w) ? fb : [...fb, w]))
      setNewWord('')
    } catch (ex) {
      setErrStyle(ex?.message || String(ex))
    }
  }

  const removeWord = (idx) => {
    const word = (style.forbidden || [])[idx]
    setErrStyle('')
    return updateForbidden((fb) => {
      const i = fb.indexOf(word)
      return i >= 0 ? fb.filter((_, j) => j !== i) : fb
    }).catch((ex) => {
      setErrStyle(ex?.message || String(ex))
    })
  }

  return (
    <div className="space-y-4">
      <section className="glass-card rounded-2xl bg-paper p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold"><Ic n="library" /> 我的书库</h3>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={importing}
            className="rounded-full bg-stone-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50"
          >
            {importing ? '导入中…' : '+ 导入小说'}
          </button>
          <input ref={fileRef} type="file" accept={READ_ACCEPT} className="hidden" onChange={onPick} />
        </div>
        <p className="mt-2 text-xs text-stone-400">支持 .txt / .md / .docx 文件，电脑从磁盘选择，平板从「文件」App 选择。（老式 .doc 请先用 Word / WPS 另存为 .docx）</p>

        {errImport && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{errImport}</p>}

        {loadError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">书库读取失败：{loadError}。请重试，或检查浏览器存储是否被禁用（隐私模式）。</p>}
        <ul className="mt-3 space-y-2">
          {loading && books.length === 0 && <li className="rounded-xl border border-dashed border-stone-300 p-4 text-center text-xs text-stone-400">正在载入书库…</li>}
          {!loading && !loadError && books.length === 0 && <li className="rounded-xl border border-dashed border-stone-300 p-4 text-center text-xs text-stone-400">还没有小说，点右上角导入</li>}
          {books.map((b) => (
            <li
              key={b.id}
              className={`flex cursor-pointer items-center justify-between rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                selectedId === b.id ? 'border-stone-800 bg-stone-800 text-white' : 'border-stone-200 hover:bg-stone-50'
              }`}
              onClick={() => select(selectedId === b.id ? null : b.id)}
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{b.title || b.name}</p>
                {/* wordCount 是派生数据，只在长篇页「保存本章」时回写；该修复之前落库的书存量恒为 0，
                    书库会明明有正文却显示「0 字」——缺失时就地按章节重算，不写库、不做数据迁移 */}
                <p className={`text-xs ${selectedId === b.id ? 'text-stone-300' : 'text-stone-400'}`}>
                  {b.wordCount || (b.chapters || []).reduce((n, c) => n + countWords(c?.text), 0)} 字
                </p>
              </div>
              <button
                onClick={async (e) => {
                  e.stopPropagation()
                  if (!window.confirm(`确定删除《${b.title || b.name}》吗？其文风档案也会一并删除。`)) return
                  try {
                    await removeBook(b.id)
                  } catch (ex) {
                    setErrImport(ex?.message || String(ex))
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

      {showStyle && (
        <>
      {/* 5.3：题材——影响未绑书/未分析时的主导嗓音；绑定并分析过的书会自动带出其档案里存的题材 */}
      <section className="glass-card rounded-2xl bg-paper p-4 shadow-sm">
        <h3 className="text-sm font-bold"><Ic n="notepad" /> 题材</h3>
        <p className="mt-1 text-xs text-stone-400">题材仅在【改写润色页】生效：且只在【未绑定书 / 未分析文风档案】时影响主导嗓音（一旦绑定或分析过档案，以档案为准、题材不再起作用）；只有部分题材能映射到对应语料（如恐怖 / 悬疑 / 推理无对应语料，会回落默认嗓音）。续写页直接参照原文风格、新手向导另有自己的题材输入框，都不读这个下拉。</p>
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

          {/* 第11轮[11]：文风相关错误（分析失败 / 禁用词增删失败）就近渲染在本区，不再甩到顶部书库卡 */}
          {errStyle && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{errStyle}</p>}

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
                    onChange={(e) => { setNewWord(e.target.value); setWordTip('') }}
                    //   原 `e.key==='Enter' && addWord()` 会把半成品（如「jin」）落进禁用词并注入提示词。isComposing/keyCode229 双判合成态。
                    onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && addWord()}
                    placeholder="手动添加禁用词…"
                    className="flex-1 rounded-lg border border-stone-200 px-3 py-1.5 text-xs focus:border-stone-500 focus:outline-none"
                  />
                  <button onClick={addWord} className="rounded-lg bg-stone-800 px-3 py-1.5 text-xs text-white hover:bg-stone-700">
                    添加
                  </button>
                </div>
                {wordTip && <p className="mt-1.5 text-[11px] text-stone-500">{wordTip}</p>}
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
