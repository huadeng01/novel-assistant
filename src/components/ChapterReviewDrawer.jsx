// 逐章「意见 / 修订」slide-over（§7 + §16）：human-in-the-loop 控制面的单章入口。
// 一屏看全：critic 报告（一致性问题 + Logic 零 Token 硬门实时体检）→ 正文阅读态 → 逐章意见（朱砂批注区，持久化 userNotes）
// → 定向重写（Editor 把「作者意见 + 逻辑硬门 fixPrompt」合成修订指令，复用 ChapterRewriter 的预览→确认→重跑归档链路）→ 重写后重跑 Logic 硬门。
// 用 slide-over 而非 modal（§16）：正文 .novel-text 阅读态、批注区朱砂系（amber 即朱砂色阶）、审视区黛青系（sky）。
import { useMemo, useState } from 'react'
import { logicAgent, buildRevisionPrompt } from '../lib/agents/index.js'
import { addUserNote, applyUserNotes, formatNovelParagraphs } from '../lib/longform.js'
import { getById } from '../lib/db.js'
import { countWords } from '../lib/utils.js'
import ChapterRewriter from './ChapterRewriter.jsx'
import Ic from './Ic.jsx'

export default function ChapterReviewDrawer({ project, saveProject, apiKey, chapterNo, onClose, onRewriteDone, busy }) {
  const [noteText, setNoteText] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [postGate, setPostGate] = useState(null) // 定向重写落库后重跑的 Logic 硬门结果
  const [noteErr, setNoteErr] = useState('')

  const ch = (project.chapters || []).find((c) => c.chapterNo === chapterNo)
  const content = formatNovelParagraphs(ch?.content || '').text // 阅读态排版归一：旧书已入库的正文也能正常分段缩进
  const notes = ch?.userNotes || []
  const unapplied = notes.filter((n) => !n.applied)

  // Logic 零 Token 硬门实时体检（纯函数，随正文/书变化重算）：既给作者看本章客观硬伤，也为定向重写提供 fixPrompt。
  const gate = useMemo(() => logicAgent.gate({ project, chapterNo, text: content }), [project, chapterNo, content])
  // Editor 合成修订指令：作者意见（最高优先级）+ 逻辑硬门必须修掉的问题。两者皆空时 ChapterRewriter 自动禁用。
  const combined = useMemo(() => buildRevisionPrompt({ userNotes: unapplied, logicFixPrompt: gate.fixPrompt }), [unapplied, gate.fixPrompt]) // eslint-disable-line react-hooks/exhaustive-deps

  const hardIssues = (ch?.issues || []).filter((i) => i.severity !== 'soft')
  const softIssues = (ch?.issues || []).length - hardIssues.length

  const submitNote = async () => {
    const body = noteText.trim()
    if (!body) return
    setNoteErr('')
    setSavingNote(true)
    try {
      await saveProject(addUserNote(project, chapterNo, body))
      setNoteText('')
      setPostGate(null)
    } catch (e) {
      setNoteErr(e.message)
    } finally {
      setSavingNote(false)
    }
  }

  const deleteNote = async (id) => {
    setNoteErr('')
    try {
      const next = {
        ...project,
        chapters: (project.chapters || []).map((c) =>
          c.chapterNo === chapterNo ? { ...c, userNotes: (c.userNotes || []).filter((n) => n.id !== id) } : c,
        ),
      }
      await saveProject(next)
    } catch (e) {
      setNoteErr(e.message)
    }
  }

  // 定向重写落库后：把本次用到的未落实意见标记为已落实（避免重复计入下次修订指令），再对重写后的新正文重跑 Logic 硬门。
  const handleRewriteDone = async (rep) => {
    try {
      const fresh = (await getById('projects', project.id)) || project
      const ids = unapplied.map((n) => n.id)
      const updated = ids.length ? applyUserNotes(fresh, chapterNo, ids) : fresh
      if (ids.length) await saveProject(updated)
      const newCh = (updated.chapters || []).find((c) => c.chapterNo === chapterNo)
      setPostGate(logicAgent.gate({ project: updated, chapterNo, text: newCh?.content || '' }))
    } catch {
      /* 重跑硬门失败不阻断：正文已由 ChapterRewriter 安全落库 */
    }
    onRewriteDone?.(rep)
  }

  if (!ch) return null

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`第${chapterNo}章 意见与修订`}>
      <div className="glass-scrim absolute inset-0 bg-stone-900/30" onClick={onClose} />
      <aside className="glass-panel absolute right-0 top-0 flex h-full w-full max-w-2xl flex-col border-l border-stone-200 bg-paper shadow-2xl">
        {/* 头部 */}
        <header className="flex items-center justify-between gap-3 border-b border-stone-200 px-5 py-3">
          <h2 className="min-w-0 text-base font-bold">
            <Ic n="chat" /> 第{chapterNo}章 · 意见 / 修订
            <span className="ml-2 truncate text-xs font-normal text-stone-400">
              {ch.title?.replace(/^第\s*[0-9〇零一二三四五六七八九十百两]+\s*章[\s:：]*/, '') || ''}（{ch.wordCount || countWords(content)} 字）
            </span>
          </h2>
          <button onClick={onClose} className="shrink-0 rounded-full border border-stone-300 p-1.5 text-stone-500 hover:bg-stone-100" aria-label="关闭">
            <Ic n="x" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* critic 报告：一致性问题（持久化 issues） */}
          <section className="rounded-xl border border-sky-200 bg-sky-50/60 p-3">
            <h3 className="text-xs font-semibold text-sky-700"><Ic n="notepad" /> 综合主编 · 一致性报告</h3>
            {hardIssues.length === 0 && softIssues === 0 ? (
              <p className="mt-1 text-xs text-sky-600/80">本章暂无一致性存疑。</p>
            ) : (
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed">
                {hardIssues.map((it, i) => (
                  <li key={`h${i}`} className="text-red-600">【{it.type}】{it.description}</li>
                ))}
                {(ch.issues || []).filter((i) => i.severity === 'soft').map((it, i) => (
                  <li key={`s${i}`} className="text-stone-500">【{it.type}·软存疑】{it.description}</li>
                ))}
              </ul>
            )}
          </section>

          {/* Logic 零 Token 硬门实时体检 */}
          <section className={`rounded-xl border p-3 ${gate.pass ? 'border-emerald-200 bg-emerald-50/60' : 'border-red-200 bg-red-50'}`}>
            <h3 className={`text-xs font-semibold ${gate.pass ? 'text-emerald-700' : 'text-red-600'}`}>
              <Ic n="shield" /> 逻辑审校 · 硬门体检（连贯 / 剧透 / 文风红线，零 Token）
            </h3>
            {gate.pass
              ? <p className="mt-1 text-xs text-emerald-700/90">通过，无必须修掉的客观硬伤{gate.findings.length ? `（另有 ${gate.findings.length} 条软提示）` : ''}。</p>
              : (
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-red-600">
                  {gate.blockers.map((b, i) => <li key={i}>【{b.category}】{b.what}{b.fix_hint ? `（修法：${b.fix_hint}）` : ''}</li>)}
                </ul>
              )}
            {!gate.pass && gate.findings.length > 0 && (
              <p className="mt-1 text-xs text-stone-500">另有 {gate.findings.length} 条软提示（AI 味 / 破折号 / 对话动词等），可在定向重写中一并处理。</p>
            )}
          </section>

          {/* 正文阅读态 */}
          <section>
            <h3 className="text-xs font-semibold text-stone-500"><Ic n="book" /> 正文</h3>
            <div className="novel-text mt-1.5 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border border-stone-200 bg-white p-4 text-sm leading-relaxed text-stone-700">
              {content || '（本章暂无正文）'}
            </div>
          </section>

          {/* 逐章意见（朱砂批注区，持久化 userNotes） */}
          <section className="rounded-xl border border-amber-200 bg-amber-50/70 p-3">
            <h3 className="text-xs font-semibold text-amber-700"><Ic n="pen" /> 逐章意见（记下后可一键合成修订指令定向重写）</h3>
            {notes.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {notes.map((n) => (
                  <li key={n.id} className="flex items-start gap-2 rounded-lg bg-white/70 px-3 py-2 text-xs leading-relaxed">
                    <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${n.applied ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                      {n.applied ? '已落实' : '待落实'}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap text-stone-600">{n.text}</span>
                    {!n.applied && (
                      <button onClick={() => deleteNote(n.id)} disabled={busy} className="shrink-0 text-stone-300 hover:text-red-500 disabled:opacity-50" aria-label="删除这条意见">
                        <Ic n="x" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              rows={3}
              placeholder="写下你的意见：这块哪里不对、想改成什么样…例：『妹妹这里不该已经睡着，应该半清醒地问哥哥去了哪里』"
              className="mt-2 w-full resize-y rounded-lg border border-amber-200 bg-white p-2.5 text-xs leading-relaxed focus:border-amber-400 focus:outline-none"
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button
                onClick={submitNote}
                disabled={busy || savingNote || !noteText.trim()}
                className="rounded-full bg-amber-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {savingNote ? '记下中…' : <><Ic n="ok" /> 记下这条意见</>}
              </button>
              {unapplied.length > 0 && <span className="text-xs text-amber-700/80">{unapplied.length} 条待落实意见将并入修订指令</span>}
            </div>
            {noteErr && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{noteErr}</p>}
          </section>

          {/* 定向重写：Editor 合成指令 → ChapterRewriter 预览/确认/重跑归档 → 重跑 Logic 硬门 */}
          <section className="rounded-xl border border-stone-200 bg-white/60 p-3">
            <h3 className="text-xs font-semibold text-stone-600"><Ic n="wand" /> 定向重写（按意见 + 硬门合成修订指令）</h3>
            <div className="mt-1.5 rounded-lg bg-stone-50 px-3 py-2 text-xs leading-relaxed text-stone-500">
              {combined
                ? <span className="whitespace-pre-wrap">{combined}</span>
                : <span className="text-stone-400">暂无待落实意见，逻辑硬门也未检出问题——无需定向重写。可先在上方记下意见。</span>}
            </div>
            <div className="mt-2">
              <ChapterRewriter
                project={project}
                saveProject={saveProject}
                apiKey={apiKey}
                chapterNo={chapterNo}
                fixPrompt={combined}
                label="按意见定向重写"
                disabled={busy || !apiKey || !combined}
                onDone={handleRewriteDone}
              />
            </div>
            {postGate && (
              <p className={`mt-2 rounded-lg px-3 py-2 text-xs leading-relaxed ${postGate.pass ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
                <Ic n="shield" /> 重写后重跑逻辑硬门：{postGate.pass ? '通过，客观硬伤已清。' : `仍有 ${postGate.blockers.length} 处硬门提示，可再次定向重写或手动微调。`}
              </p>
            )}
          </section>
        </div>
      </aside>
    </div>
  )
}
