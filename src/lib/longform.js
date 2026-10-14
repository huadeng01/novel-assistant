// 暗箱流水线废弃处置 A：longform.js 的废弃流水线（planVolume/archiveChapter/consistencyGate/
// codeLayerAudit/splitChapters/各类 scan/gate/anchor/counter/foreshadow 等）已物理删除。
// 文风活簇抽到 ./style.js；本文件保留为 re-export 瘦壳，使页面层既有
// `import { distillStyleBand, resolveStyleRec } from '../lib/longform.js'` 不断。
export * from './style.js'
