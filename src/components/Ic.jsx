// 统一图标组件：全站以 lucide 线条图标替代 emoji，
// 颜色跟随 currentColor（自动适配墨黑/朱砂主题），尺寸跟随字号。
import {
  Activity, Archive, Ban, BookOpen, Bookmark, Check, ChartColumn, CircleCheck,
  Clapperboard, ClipboardList, Download, Feather, FileInput, FileText, Globe,
  KeyRound, Library, Lightbulb, Map, Mountain, PartyPopper, Pencil, PenLine, Hourglass,
  RefreshCw, Rocket, RotateCcw, Route, Scroll, Search, Settings, Shield,
  Sparkles, Sprout, Square, Stethoscope, Target, Timer, TriangleAlert, Undo2, User, Video, Wand2, X,
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
  doc: FileText,         // 📄 文档
  globe: Globe,          // 🌍 世界观
  hook: Bookmark,        // 🪝 伏笔
  scroll: Scroll,        // 📜 卷志 / 长时记忆
  bulb: Lightbulb,       // 💡 创意 / 提示
  ok: CircleCheck,       // ✅ 完成
  check: Check,          // ✓ 对勾
  x: X,                  // ✕ 关闭 / 放弃
  wand: Wand2,           // 🔮 文风分析
  rocket: Rocket,        // 🚀 上手引导
  gear: Settings,        // ⚙️ 设定
  doctor: Stethoscope,   // 🩺 诊断
  import: FileInput,     // 📥 导入
  box: Archive,          // 📦 档案归档
  shield: Shield,        // 🛡 保护期
  target: Target,        // 🎯 节奏目标
  save: Download,        // 💾 备份 / 导出
  thread: Route,         // 🧵 故事线
  sprout: Sprout,        // 🌱 新手
  clap: PartyPopper,     // 👏 完成庆祝
  clipboard: ClipboardList, // 📋 分析结果
  chart: ChartColumn,    // 📊 档案状态
  sparkle: Sparkles,     // ✨ 续写 / 增强
  rolling: RefreshCw,    // 🌀 滚动摘要
  scene: Clapperboard,   // 🎬 场景
  film: Video,           // 🎥 视角
  rerun: RotateCcw,      // 🔄 重新建档
  undo: Undo2,           // ↩ 恢复原稿
  key: KeyRound,         // 🔑 API Key
  style: Feather,        // 🖋 文风档案
  ban: Ban,              // 🚫 禁止
  stop: Square,          // ⏹ 停止
  timer: Timer,          // ⏱ 节奏
  hourglass: Hourglass,  // ⏳ 时间线
  pulse: Activity,       // 心跳 / 状态流
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
