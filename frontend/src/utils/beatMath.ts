/**
 * 动作节拍换算：以主机位帧号为时间基准，按各机位帧率换算帧位。
 * 定格动画里帧即离散时间点：
 *   时间（秒） = (主机位帧位次 - 1) / 主机位帧率
 *   从机位帧位 = round(时间 × 从机位帧率) + 1
 * 帧位次从 1 开始，故换算以「距首帧的步数」进行，避免把首帧算到 0 帧。
 */

/** 主机位帧位 → 从机位帧位（四舍五入，至少 1） */
export function convertFramePos(masterFrame: number, masterFps: number, targetFps: number): number {
  if (!Number.isFinite(masterFrame) || masterFrame < 1) return 1;
  if (!Number.isFinite(masterFps) || masterFps <= 0 || !Number.isFinite(targetFps) || targetFps <= 0) {
    return Math.max(1, Math.round(masterFrame));
  }
  const steps = (Math.round(masterFrame) - 1) * (targetFps / masterFps);
  return Math.max(1, Math.round(steps) + 1);
}

/** 主机位帧位 → 秒（节拍相对首帧的时间） */
export function beatAtSeconds(masterFrame: number, masterFps: number): number {
  if (!Number.isFinite(masterFrame) || masterFrame < 1 || masterFps <= 0) return 0;
  return Math.round(((Math.round(masterFrame) - 1) / masterFps) * 1000) / 1000;
}

/** 从机位帧位反推回主机位帧位（复核对照用） */
export function revertFramePos(framePos: number, targetFps: number, masterFps: number): number {
  if (!Number.isFinite(framePos) || framePos < 1) return 1;
  if (!Number.isFinite(targetFps) || targetFps <= 0 || !Number.isFinite(masterFps) || masterFps <= 0) {
    return Math.max(1, Math.round(framePos));
  }
  const steps = (Math.round(framePos) - 1) * (masterFps / targetFps);
  return Math.max(1, Math.round(steps) + 1);
}

/** 判断镜头是否已拍：有任一实拍张数即视为已拍 */
export function isShotTaken(takenFrames: number): boolean {
  return Number.isFinite(takenFrames) && takenFrames > 0;
}

/** 重算结果 */
export interface RecalculatedAttachment {
  /** 新帧位（未拍镜头直接采用；已拍镜头作为建议值） */
  nextFramePos: number;
  /** 是否与原值不同 */
  changed: boolean;
  /** 是否应进入待复核（已拍且帧位变化） */
  needsReview: boolean;
}

/**
 * 按新的主机位帧号重算一个挂接机位的帧位。
 * 未拍镜头：立即采用新值；
 * 已拍镜头：保留原 framePos，新值进 suggestedFramePos，置待复核。
 */
export function recalcAttachment(
  prevMasterFrame: number,
  nextMasterFrame: number,
  masterFps: number,
  fps: number,
  framePos: number,
  shotTaken: boolean,
): RecalculatedAttachment {
  const next = convertFramePos(nextMasterFrame, masterFps, fps);
  const changed = next !== Math.round(framePos);
  const needsReview = changed && shotTaken;
  void prevMasterFrame;
  return { nextFramePos: next, changed, needsReview };
}
