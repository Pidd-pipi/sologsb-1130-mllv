/**
 * 多机位动作节拍模型。
 *
 * 一个动作节拍（Beat）以主机位（master shot）的时间线为基准，
 * 节拍上的动作锚点（BeatAnchor）记录主机位帧位；其他机位（镜头）
 * 通过挂接关系（BeatLink）共享同一节拍，并按各自帧率把锚点换算到
 * 自己的帧位上。
 *
 * 同一节拍最多挂 6 个机位（1 个主机位 + 5 个挂接机位）。
 */

/** 同一节拍允许挂接的机位上限（含主机位） */
export const MAX_CAMERAS_PER_BEAT = 6;

/** 动作锚点：主机位时间线上的一个动作节点 */
export interface BeatAnchor {
  /** 节拍内唯一标识，稳定用于跨机位对齐 */
  key: string;
  /** 主机位帧位（1 起） */
  masterFrame: number;
  /** 动作名，如「抬手」「回头」 */
  label: string;
  note?: string;
}

/**
 * 挂接机位状态。
 * 已拍机位在主机位帧数变化后不自动改帧位，只把锚点差异记入
 * reviewAnchors 并置 needsReview，等人工复核。
 */
export type BeatLinkStatus = 'unshot' | 'shot';

export interface BeatLink {
  /** 挂接镜头 id */
  shotId: number;
  /** 镜号冗余，便于跨设备合并与离线阅读 */
  shotCode: string;
  /** 挂接时镜头帧率，帧位换算基准 */
  fps: number;
  /** 状态：未拍可自动重算，已拍保留原值 */
  status: BeatLinkStatus;
  /** 当前采用的锚点帧位（按本机帧率换算，或已拍时人工保留值），与 anchors 下标对齐 */
  frames: number[];
  /** 最近一次重算结果；已拍机位与现值不一致时用于复核对照 */
  reviewFrames: number[];
  /** 是否待人工复核（已拍机位主机位帧数变化后置 true） */
  needsReview: boolean;
  attachedAt: number;
  updatedAt: number;
}

/** 节拍：多机位共用的动作时间线，以主机位为基准 */
export interface Beat {
  id?: number;
  /** 节拍编号，跨设备合并的匹配键，库内唯一 */
  code: string;
  /** 动作名 */
  name: string;
  /** 主机位镜头 id */
  masterShotId: number;
  /** 主机位镜号冗余 */
  masterShotCode: string;
  /** 主机位帧率快照（重算基准） */
  masterFps: number;
  /** 主机位帧数快照，用于判断「主机位帧数一变」 */
  masterFrameCount: number;
  /** 动作锚点（主机位帧位，升序） */
  anchors: BeatAnchor[];
  /** 挂接的非主机位镜头，最多 5 个 */
  links: BeatLink[];
  /** 结构版本号，离线合并时判断哪边更新 */
  revision: number;
  /** 最近变更时间戳 */
  updatedAt: number;
  createdAt: number;
}

export const createEmptyBeat = (): Omit<Beat, 'id'> => ({
  code: '',
  name: '',
  masterShotId: 0,
  masterShotCode: '',
  masterFps: 24,
  masterFrameCount: 48,
  anchors: [],
  links: [],
  revision: 1,
  updatedAt: Date.now(),
  createdAt: Date.now(),
});

/** 生成节拍内稳定锚点 key */
export function nextAnchorKey(anchors: BeatAnchor[]): string {
  let max = 0;
  for (const a of anchors) {
    const n = Number((a.key || '').replace(/^a/, ''));
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return `a${max + 1}`;
}

/* ---------------- 离线合并 ---------------- */

/** 离线同步包：一台设备导出的节拍数据 */
export interface BeatSyncBundle {
  /** 导出设备标识（合并冲突溯源） */
  deviceId: string;
  deviceName: string;
  exportedAt: number;
  /** 应用版本，预留兼容 */
  format: 1;
  beats: Beat[];
}

/** 冲突的单个挂接机位双版本 */
export interface BeatLinkConflict {
  shotId: number;
  shotCode: string;
  local: BeatLink;
  incoming: BeatLink;
}

/** 冲突节拍：两版并列，确认前不改动当前帧序 */
export interface BeatConflict {
  id?: number;
  /** 冲突编号 = beatCode，便于幂等合并 */
  beatCode: string;
  beatName: string;
  /** 本地版本（当前帧序的来源，保持不动） */
  local: Beat;
  /** 离线带入的版本 */
  incoming: Beat;
  /** 来源设备 */
  incomingDeviceId: string;
  incomingDeviceName: string;
  /** 挂接关系冲突明细（节拍本体字段冲突由两版整体并列承载） */
  linkConflicts: BeatLinkConflict[];
  createdAt: number;
  resolved: boolean;
}

/** 离线合并结果（不落库的统计回执） */
export interface BeatMergeReport {
  added: number;
  updated: number;
  conflicted: string[];
}

/** 重算/合并动手前的快照，失败后据此恢复 */
export interface BeatSnapshot {
  beats: Beat[];
  links: { beatId: number; links: BeatLink[] }[];
  shots: { id: number; durationSec: number; startFrame: number; endFrame: number }[];
}
