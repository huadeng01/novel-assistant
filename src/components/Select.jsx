// 自绘下拉选择器：原生 <select> 展开后的选项弹层由操作系统绘制、CSS 无法美化（灰底 + 系统蓝高亮），
// 故用 div 自绘触发器与选项面板，让收起 / 展开两态都贴合宣纸墨韵主题（墨色描边、朱砂选中）。
// 受控组件：value / onChange(value)；options: [{ value, label, title? }]；无匹配项时显示 placeholder。
import { useEffect, useRef, useState } from 'react'
import Ic from './Ic.jsx'

export default function Select({ value, onChange, options, placeholder = '请选择', disabled, className = '' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  // 点击外部或按 Esc 收起面板
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = options.find((o) => o.value === value)
  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-left text-sm text-stone-700 shadow-sm transition hover:border-stone-400 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/15 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={`truncate ${current ? 'text-stone-700' : 'text-stone-400'}`}>{current ? current.label : placeholder}</span>
        <Ic n="chevron" className={`text-stone-400 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 max-h-60 overflow-y-auto rounded-xl border border-stone-200 bg-white py-1 shadow-lg">
          {options.map((o) => {
            const active = o.value === value
            return (
              <button
                key={o.value}
                type="button"
                title={o.title}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
                className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition ${
                  active ? 'bg-amber-50 font-medium text-amber-700' : 'text-stone-600 hover:bg-stone-100 hover:text-stone-800'
                }`}
              >
                <span className="truncate">{o.label}</span>
                {active && <Ic n="check" className="text-amber-600" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
