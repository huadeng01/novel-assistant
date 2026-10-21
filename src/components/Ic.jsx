// 统一图标组件：全站以 lucide 线条图标替代 emoji，
// 颜色跟随 currentColor（自动适配墨黑/朱砂主题），尺寸跟随字号。
// B28：删掉 12 个全站零引用的死图标键（doc/scroll/ok/gear/shield/target/chart/scene/film/rerun/stop/chat）
//   及其独占的 11 个 lucide import（FileText 保留——notepad 仍在用）。删前已核对全部动态取值：
//   App TABS(n={t.icon}) = pencil/book/mountain/sprout/flame/user；ContinuePage CollapseBlock(icon) = globe/user/map/hourglass；
//   RanksPage Chip(icon) = globe/notepad/library/ban；两处三元 = rolling/wand/sparkle——均不含这 12 个。Ic 对未知名 return null，误删即图标静默消失，故逐一核实。
import {
  Activity, Archive, Ban, BookOpen, Bookmark, Check, ChevronDown,
  ClipboardList, Download, Feather, FileInput, FileText, Flame, Globe,
  KeyRound, Library, Lightbulb, Map, Mountain, PartyPopper, Pencil, PenLine, Hourglass,
  RefreshCw, Rocket, Route, Search, Shuffle,
  Sparkles, Sprout, Stethoscope, Timer, TriangleAlert, Undo2, User, Wand2, X,
} from 'lucide-react'

const MAP = {
  pen: PenLine,          // ✍️ 撰写
  pencil: Pencil,        // ✏️ 润色 / 编辑
  book: BookOpen,        // 📖 章节 / 初稿 / 原文
  library: Library,      // 📚 书库 / 项目列表
  mountain: Mountain,    // 🏔 长篇写作
  search: Search,        // 🔍 审核 / 检索
  map: Map,              // 🗺 细纲
  alert: TriangleAlert,  // ⚠️ 警示
  user: User,            // 👤 人物
  notepad: FileText,     // 📝 记录 / 建议
  globe: Globe,          // 🌍 世界观
  hook: Bookmark,        // 🪝 伏笔
  bulb: Lightbulb,       // 💡 创意 / 提示
  check: Check,          // ✓ 对勾
  x: X,                  // ✕ 关闭 / 放弃
  wand: Wand2,           // 🔮 文风分析
  rocket: Rocket,        // 🚀 上手引导
  doctor: Stethoscope,   // 🩺 诊断
  import: FileInput,     // 📥 导入
  box: Archive,          // 📦 档案归档
  save: Download,        // 💾 备份 / 导出
  thread: Route,         // 🧵 故事线
  sprout: Sprout,        // 🌱 新手
  clap: PartyPopper,     // 👏 完成庆祝
  clipboard: ClipboardList, // 📋 分析结果
  sparkle: Sparkles,     // ✨ 续写 / 增强
  rolling: RefreshCw,    // 🌀 滚动摘要
  undo: Undo2,           // ↩ 恢复原稿
  key: KeyRound,         // 🔑 API Key
  style: Feather,        // 🖋 文风档案
  ban: Ban,              // 🚫 禁止
  timer: Timer,          // ⏱ 节奏
  hourglass: Hourglass,  // ⏳ 时间线
  pulse: Activity,       // 心跳 / 状态流
  shuffle: Shuffle,      // 🔀 引擎切换 / 交叉审核
  flame: Flame,          // 🔥 热门榜单
  chevron: ChevronDown,  // 🔽 折叠 / 展开
}

export default function Ic({ n, className = '', ...rest }) {
  const C = MAP[n]
  if (!C) return null
  return (
    <C
      size="1em"
      strokeWidth={1.8}
      className={`inline-block shrink-0 ${className}`}
      style={{ verticalAlign: '-0.125em' }}
      {...rest}
    />
  )
}
