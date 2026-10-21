import { useEffect, useState } from 'react'
import { chapterFieldOf } from '../lib/assets.js'

const inputBase = 'rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 text-xs focus:border-red-400 focus:outline-none'

// 透出章 / 传闻章的统一显示组件（设计 §3 需求4 第1、3、4步）。
// 存在的理由：AssetModal / EditAssetModal / AssetGraphModal 曾各有一套口径（value 绑原始值 vs 绑派生值 vs 显示 0），
// 用户看到「卷换算:121」却输入框空白，读成「这个字段没有内容」。这里把三件事一次说清：
//   ① 输入框 value = 原始精确章号（未指定就是空白，绝不显示 0）；
//   ② 按卷估算值放在**小字**里（不是 placeholder —— placeholder 会被当成值），并明示这是「每卷等章数」的粗映射(H5)；
//   ③ 无卷号无章号时写「未定（资产表未给透出卷）」，不写「—」（「—」会被读成字段坏了）。
// 保存语义：空 → 0（含义=回落到按卷估算）；有值 → 精确章号优先。
// 提交时机：onBlur / Enter 才回调（不用 onChange 每键写库，缓解 M29 按键级写风暴）。
export default function ChapterField({ kind = 'reveal', asset = null, value, onChange, perVol = 40, label, inline = false, width = 'w-16', disabled = false, id }) {
  const field = chapterFieldOf(asset, perVol, kind)
  // 受控优先：调用方显式给了 value 就用它（表单草稿场景），否则从资产算（卡片直改场景）
  const outer = value !== undefined && value !== null ? (Number(value) > 0 ? String(Number(value)) : '') : field.value === '' ? '' : String(field.value)
  const [text, setText] = useState(outer)
  useEffect(() => setText(outer), [outer])

  const commit = () => {
    const raw = String(text).trim()
    // M-G：只接受非负整数章号——原来 `Number(raw)||0` 会把 -5 / 1.5 原样入库（污染按卷派生 + 防剧透门），
    //   把 "12abc" 静默清零（用户以为填了却被抹成空）。非法值（负数 / 小数 / 含字母）一律不提交、回退到当前值。
    let n
    if (raw === '') n = 0 // 空 = 回落按卷估算（保存语义，见文件头 ⑫）
    else if (/^\d+$/.test(raw)) n = Number(raw)
    else {
      setText(outer) // 非法输入：回退，不回调、不入库
      return
    }
    // 只在真变化时回调，避免无意义的整本 put
    if (n === (Number(outer) || 0)) {
      setText(outer)
      return
    }
    setText(n > 0 ? String(n) : '')
    if (onChange) onChange(n)
  }

  const derived = field.derived
  const explicit = Number(outer) > 0
  const hint = explicit
    ? derived > 0 && derived !== Number(outer)
      ? `已用精确章号，按卷估算 ${derived} 章不生效`
      : '已用精确章号'
    : derived > 0
      ? `按卷估算 ${derived} 章（每卷等章数的粗映射，非精确章号）`
      : `未定（资产表未给${kind === 'rumor' ? '传闻' : '透出'}卷）`

  const input = (
    <input
      id={id}
      type="number"
      min="0"
      inputMode="numeric"
      disabled={disabled}
      value={text}
      // P2：placeholder 不再塞按卷估算值——本组件的存在理由（见文件头 ②③）就是「估算值放小字、不放 placeholder，
      //   否则空输入框里显示的数字会被读成已填的值」。估算值已由上面的 hint 小字给出，这里留空。
      placeholder=""
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
      onClick={(e) => e.stopPropagation()}
      className={`${inputBase} ${width} ${disabled ? 'opacity-50' : ''}`}
      aria-label={label || (kind === 'rumor' ? '传闻章' : '透出章')}
    />
  )

  const text_ = (
    <span className={`text-[10px] leading-tight ${explicit ? 'text-stone-400' : derived > 0 ? 'text-stone-500' : 'text-red-400'}`}>{hint}</span>
  )

  if (inline) {
    return (
      <span className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <span className="text-[11px] text-stone-500">{label || (kind === 'rumor' ? '传闻章' : '透出章')}</span>
        {input}
        {text_}
      </span>
    )
  }

  return (
    <div onClick={(e) => e.stopPropagation()}>
      {label !== null && <label className="mb-1 block text-xs font-medium text-stone-500">{label || (kind === 'rumor' ? '传闻章' : '透出章')}</label>}
      {input}
      <div className="mt-0.5">{text_}</div>
    </div>
  )
}
