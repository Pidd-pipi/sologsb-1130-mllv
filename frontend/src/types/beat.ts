/**
 * 动作节拍（ActionBeat）：多机位定格镜头共用的动作时间点。
 * 一个节拍以「主机位」为时间基准（主机位帧号 masterFrame），
 * 其余镜头挂接后按各自帧率换算本镜头帧位；同一节拍最多挂 6 个机位（含主机位）。
 */

/** 同一节拍允许挂接的机位上限（含主机位） */
export const MAX_CAMERAS_PER_BEAT = 6;

/** 节拍来源：本机新建 / 离线合并并入 */
export type BeatSource = 'local' | 'imported';

/** 挂接机位的复核状态：已拍镜头重算后保留原值，待人工复核 */
export type BeatReviewState = 'none' | 'pending';

/** 节拍上的一个挂接机位（主机位之外的从机位） */
export interface BeatAttachment {
  /** 挂接关系稳定 id（离线合并按它判重），不使用 IndexedDB 自增 id */
  uuid: string;
  /** 镜头 id；离线并入且本机尚无同镜号镜头时为 null（镜号到位后补挂） */
  shotId: number | null;
  /** 镜号（跨设备合并的匹配键，自增 id 各机不同） */
  shotCode: string;
  /** 挂接时快照的镜头帧率，用于按各自帧率换算帧位 */
  fps: number;
  /** 本镜头帧位（1 起，为该镜头帧序列中的位次） */
  framePos: number;
  /** 重算前的帧位；已拍镜头重算不改原值，新值进 suggestedFramePos 待复核 */
  previousFramePos: number | null;
  /** 重算给出的新帧位建议（仅待复核时有值） */
  suggestedFramePos: number | null;
  /** 复核状态 */
  reviewState: BeatReviewState;
  updatedAt: number;
}

/** 动作节拍本体 */
export interface ActionBeat {
  id?: number;
  /** 跨设备稳定 id */
  uuid: string;
  /** 节拍名称，如「开门 / 抬手」 */
  name: string;
  /** 基准主机位镜头 id；历史单机位节拍升级后即镜头自身 */
  masterShotId: number;
  /** 基准主机位镜号（跨设备匹配键） */
  masterShotCode: string;
  /** 主机位帧率快照 */
  masterFps: number;
  /** 主机位帧号（节拍在主机位帧序列中的位次，1 起） */
  masterFrame: number;
  /** 最近一次重算前的主机位帧号（留痕/复核用） */
  previousMasterFrame: number | null;
  /** 从机位挂接列表（不含主机位） */
  attachments: BeatAttachment[];
  /** 历史数据升级或手动降级出的单机位节拍：不再触发联动重算 */
  legacy: boolean;
  /** 来源 */
  source: BeatSource;
  /** 待处理的离线合并冲突项；非空期间当前帧序不动 */
  conflicts: BeatConflict[];
  createdAt: number;
  updatedAt: number;
}

/* ---------------- 离线合并 ---------------- */

/** 冲突类型：节拍字段冲突 / 挂接关系冲突 / 挂接数量超限 / 关联镜头缺失 */
export type BeatConflictKind =
  | 'beat-field'
  | 'attachment-frame'
  | 'attachment-add'
  | 'attachment-remove'
  | 'attachment-cap'
  | 'missing-shot';

/** 冲突项：本机版与并入版两版并列，确认前不动当前帧序 */
export interface BeatConflict {
  /** 冲突稳定 id，解决时按它定位 */
  uuid: string;
  kind: BeatConflictKind;
  /** 涉及字段（beat-field 时）/ 涉及镜头镜号 */
  field?: 'name' | 'masterFrame';
  shotCode?: string;
  attachmentUuid?: string;
  /** 本机当前值的可读文本（当前帧序原值） */
  localLabel: string;
  /** 并入设备值的可读文本 */
  incomingLabel: string;
  /** 并入版原始数据（确认并入时直接落用；具体结构随 kind 而定） */
  incoming: unknown;
  /** 并入时的提示说明 */
  note: string;
  createdAt: number;
}

/** 离线节拍包：两台设备之间导出/导入的 JSON 载体 */
export interface BeatPackage {
  format: 'gbstopmotion-beats';
  version: 1;
  device: string;
  exportedAt: number;
  beats: ActionBeat[];
}

/** 合并结果统计（页面提示用） */
export interface BeatMergeStats {
  added: number;
  updated: number;
  conflicts: number;
  beatCount: number;
}

/** 生成跨设备稳定 id（优先原生 randomUUID） */
export function beatUuid(prefix = 'beat'): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return `${prefix}_${cryptoObj.randomUUID()}`;
  }
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand()}${rand()}`;
}

/** 空挂接机位 */
export function createEmptyAttachment(shotCode: string, shotId: number | null, fps: number, framePos: number): BeatAttachment {
  return {
    uuid: beatUuid('att'),
    shotId,
    shotCode,
    fps,
    framePos,
    previousFramePos: null,
    suggestedFramePos: null,
    reviewState: 'none',
    updatedAt: Date.now(),
  };
}

/** 空节拍 */
export function createEmptyBeat(masterShotId: number, masterShotCode: string, masterFps: number, masterFrame: number): ActionBeat {
  const now = Date.now();
  return {
    uuid: beatUuid('beat'),
    name: '',
    masterShotId,
    masterShotCode,
    masterFps,
    masterFrame,
    previousMasterFrame: null,
    attachments: [],
    legacy: false,
    source: 'local',
    conflicts: [],
    createdAt: now,
    updatedAt: now,
  };
}
