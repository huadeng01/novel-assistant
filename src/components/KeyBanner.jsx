// 未配置 API Key 时显示的引导横幅
export default function KeyBanner({ onNeedKey }) {
  return (
    <div className="mb-6 flex flex-col items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm text-amber-900">
        <p className="font-semibold">还没有设置 DeepSeek API Key</p>
        <p className="mt-1 text-amber-800/80">所有 AI 功能都需要 Key 才能使用，设置只需 1 分钟。</p>
      </div>
      <button
        onClick={onNeedKey}
        className="shrink-0 rounded-full bg-amber-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-amber-700"
      >
        去设置 →
      </button>
    </div>
  )
}
