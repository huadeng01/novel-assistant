// 单章定向重写组件：按给定修改指令用写作引擎重写指定章节（流式预览），确认后替换回已保存正文。
// 审核模块的「一键修改」与章节列表的「按问题重写」共用此组件；
// editable=true 时先收集作者的修改想法（剧情讨论），再把想法作为修改指令走同一条重写链路。
// 替换前原稿会自动存进章节快照（prev），不满意可在章节列表一键恢复。
import { useRef, useState } from 'react'
import { chatStream } from '../lib/llm.js'
import { chapterRewriteMessages } from '../lib/prompts.js'
import { replaceChapter, runPostChapter, reapplyReport, activeStyleRules, aiFlavorScan, povStreak } from '../lib/longform.js'
import { getById } from '../lib/db.js'
import { countWords } from '../lib/utils.js'
import Ic from './Ic.jsx'

// 从重写输出中解析标题行（与初稿同协议：第一行为标题）
export function parseTitle(full) {
  const lines = String(full).split('\n')
  const firstIdx = lines.findIndex((l) => l.trim())
  if (firstIdx < 0) return { title: '', text: '' }
  const firstLine = lines[firstIdx].trim()
  let title = ''
  const m = firstLine.match(/^第\s*[0-9〇零一二三四五六七八九十百两]+\s*章[：:\s]*(.*)$/)
  if (m) title = m[1].trim()
  else if (firstLine.length <= 20 && !/[。！？!?…，,]$/.test(firstLine)) title = firstLine
  const text = title ? lines.slice(firstIdx + 1).join('\n').replace(/^\s+/, '') : full
  return { title, text }
}

export default function ChapterRewriter({ project, saveProject, apiKey, chapterNo, fixPrompt, label, disabled, onDone, editable }) {
  const [rewriting, setRewriting] = useState(false)
  const [preview, setPreview] = useState(null) // {title, text, streaming}
  const [flavor, setFlavor] = useState([]) // AI 味扫描命中（重写完成后验证；空 = 未命中）
  const [step, setStep] = useState('')
  const [err, setErr] = useState('')
  const [idea, setIdea] = useState('') // editable 模式：作者填写的修改想法
  const [asking, setAsking] = useState(false) // editable 模式：想法输入区是否展开
  const abortRef = useRef(null) // 停止按钮用：中止后已生成部分保留供预览

  const ch = (project.chapters || []).find((c) => c.chapterNo === chapterNo)
  const busy = rewriting || !!step

  // 流式重写：只改指令指出的问题，不动其余章节；editable 模式以作者想法为最高优先级指令
  const rewrite = async () => {
    const effectivePrompt = editable ? `作者对本章提出以下修改想法（最高优先级，必须按想法改写；想法未提及的部分尽量保持原样）：${idea.trim()}` : fixPrompt
    if (!apiKey || !ch || !effectivePrompt?.trim()) return
    const sorted = [...(project.chapters || [])].sort((a, b) => a.chapterNo - b.chapterNo)
    const idx = sorted.findIndex((c) => c.chapterNo === chapterNo)
    setErr('')
    setRewriting(true)
    setPreview(null)
    setFlavor([])
    abortRef.current = new AbortController()
    try {
      // 写法引擎：重写同样套用本书绑定的文风档案、范例与反模板规则（未绑定则不注入）
      const styleRec = project.styleBookId ? await getById('styles', project.styleBookId) : null
      const full = await chatStream({
        apiKey,
        messages: chapterRewriteMessages({
          chapterNo,
          title: ch.title,
          content: ch.content,
          fixPrompt: effectivePrompt,
          world: project.world,
          prevSummary: sorted[idx - 1]?.summary || '',
          nextSummary: sorted[idx + 1]?.summary || '',
          forbidden: styleRec?.forbidden || [],
          style: styleRec?.profile || '',
          rules: activeStyleRules(project),
          samples: styleRec?.samples || [],
          characters: project.characters,
        }),
        temperature: 0.8,
        signal: abortRef.current?.signal,
        onDelta: (f) => setPreview({ ...parseTitle(f), streaming: true }),
      })
      if (countWords(full) < 200) throw new Error('重写结果太短，可能生成异常，请重试。')
      setPreview({ ...parseTitle(full), streaming: false })
      // AI 味输出层验证：重写完成后扫描成品，命中则提醒（不阻断替换）
      setFlavor(aiFlavorScan(parseTitle(full).text, styleRec?.forbidden || []))
    } catch (e) {
      if (e.name === 'AbortError') {
        // 停止后保留已生成部分供预览，由用户决定丢弃还是继续看
        setPreview((p) => (p ? { ...p, streaming: false } : p))
      } else {
        setPreview(null)
        setErr(e.message)
      }
    } finally {
      abortRef.current = null
      setRewriting(false)
    }
  }

  // 确认替换：先把新正文落盘（替换前原稿自动存入章节快照可恢复），再对新文本重跑完整五项检测归档
  // （摘要/状态/伏笔/一致性校验/故事线 + 滚动摘要/卷志），幂等合并防重复记账；
  // 分两步保存：归档报错时正文已落盘不丢，只提示档案重建失败，避免旧版摘要/一致性问题残留假象之外的更坏情况——完全不落盘
  const confirmReplace = async () => {
    if (!preview || preview.streaming) return
    setStep('正在替换正文…')
    try {
      const replaced = replaceChapter(project, chapterNo, { title: preview.title, text: preview.text })
      await saveProject(replaced)
      setStep('正在对重写版重跑五项检测并重建档案…')
      try {
        const report = await runPostChapter({ apiKey, project: replaced, chapterNo, text: preview.text, onStep: setStep, policy: project.qualityPolicy || 'fast' })
        const { project: next, blocked } = reapplyReport(replaced, chapterNo, report)
        await saveProject(next)
        setPreview(null)
        setAsking(false)
        setIdea('')
        // 新报告上抛：父级同步「档案已更新」报告卡，避免章节列表已清零而报告卡还挂旧问题的不同步
        onDone?.({ ...report, chapterNo, blocked, povStreak: povStreak(next.chapters, project.protagonist) })
        return
      } catch (e2) {
        // 正文已落盘；归档失败只提示，不回滚重写结果（可在章节列表用重新归档补跑）
        setErr(`正文已替换，但档案重建失败：${e2.message}`)
        onDone?.()
        return
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setStep('')
    }
  }

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        {/* editable 模式：先展开想法输入区，不直接发起重写 */}
        {!editable || !asking ? (
          <button
            onClick={editable ? () => { setAsking(true); setErr('') } : rewrite}
            disabled={disabled || busy}
            className="rounded-full bg-stone-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50"
          >
            {rewriting ? '重写中…' : <>{editable && <Ic n="chat" /> } {label}</>}
          </button>
        ) : null}
        {rewriting && (
          <button
            onClick={() => abortRef.current?.abort()}
            className="rounded-full border border-red-300 px-4 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
          >
            <Ic n="stop" /> 停止
          </button>
        )}
        {preview && !preview.streaming && !step && (
          <button
            onClick={() => setPreview(null)}
            className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50"
          >
            放弃这次重写
          </button>
        )}
      </div>
      {err && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}

      {/* 想法输入区（剧情讨论）：作者写清“哪里不对、想怎么改”，提交后走一键重写同一条链路 */}
      {editable && asking && (
        <div className="mt-2">
          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            rows={3}
            placeholder="写下你的想法：这块哪里不对、想改成什么样…例：『妹妹这里不该已经睡着，应该半清醒地问哥哥去了哪里』"
            className="w-full rounded-lg border border-stone-200 bg-white p-2.5 text-xs leading-relaxed focus:border-sky-400 focus:outline-none"
          />
          <div className="mt-1 flex flex-wrap gap-2">
            <button
              onClick={rewrite}
              disabled={disabled || busy || !idea.trim()}
              className="rounded-full bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
            >
              <Ic n="pen" /> 按这个想法重写
            </button>
            {!busy && (
              <button
                onClick={() => { setAsking(false); setIdea('') }}
                className="rounded-full border border-stone-300 px-4 py-1.5 text-xs text-stone-600 hover:bg-stone-50"
              >
                收起
              </button>
            )}
          </div>
        </div>
      )}

      {preview && (
        <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50/60 p-3">
          <p className="text-xs font-semibold text-sky-700">
            {preview.streaming
              ? <><Ic n="pen" /> 正在重写第 {chapterNo} 章…</>
              : <><Ic n="notepad" /> 重写预览（{countWords(preview.text)} 字，原章 {ch?.wordCount || 0} 字）——确认后才替换，替换前原稿自动保留可恢复</>}
          </p>
          <div className={`mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white p-3 text-xs leading-relaxed ${preview.streaming ? 'text-stone-500' : 'text-stone-700'}`}>
            {preview.text}
          </div>
          {!preview.streaming && flavor.length > 0 && (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
              <Ic n="alert" /> AI 味扫描命中 {flavor.length} 类套路表达：{flavor.slice(0, 5).map((h) => (h.type === '结构' ? h.name : h.word)).join('、')}{flavor.length > 5 ? ' 等' : ''}。可再次重写或替换后手动调整。
            </p>
          )}
          {!preview.streaming && (
            <button
              onClick={confirmReplace}
              disabled={busy}
              className="mt-2 rounded-full bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-50"
            >
              {step || <><Ic n="ok" /> 确认替换进正文</>}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
