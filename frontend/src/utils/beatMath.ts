/**
 * 多机位节拍换算工具。
 *
 * 核心原则：**时间点对齐**。主机位第 n 帧对应的时间
 *   t = (n - masterStartFrame) / masterFps
 * 其他机位按各自帧率把同一时间点映射回帧位：
 *   frame = shotStartFrame + round(t * linkFps)
 *
 * 这样「主机位帧数一变」时，未拍机位只需要用新的主机位
 * 帧区间重新换算；已拍机位保留原帧位，只产出待复核的新值。
 */
import type { Beat, BeatAnchor, BeatLink } from '../types/beat';
import { MAX_CAMERAS_PER_BEAT } from '../types/beat';

/** 帧位取整：四舍五入夹到 >=1 */
function clampFrame(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.round(value));
}

/**
 * 单个主机位帧位换算到某挂接机位帧位。
 * @param masterFrame 主机位帧位
 * @param masterStart  主机位起始帧号
 * @param masterFps    主机位帧率
 * @param targetStart  挂接机位起始帧号
 * @param targetFps    挂接机位帧率
 */
export function convertFramePosition(
  masterFrame: number,
  masterStart: number,
  masterFps: number,
  targetStart: number,
  targetFps: number,
): number {
  if (!(masterFps > 0) || !(targetFps > 0)) return clampFrame(targetStart);
  const seconds = (masterFrame - masterStart) / masterFps;
  return clampFrame(targetStart + seconds * targetFps);
}

/** 一组锚点整体换算，保持与 anchors 下标对齐 */
export function convertAnchors(
  anchors: BeatAnchor[],
  masterStart: number,
  masterFps: number,
  targetStart: number,
  targetFps: number,
): number[] {
  return anchors.map((a) => convertFramePosition(a.masterFrame, masterStart, masterFps, targetStart, targetFps));
}

/** 节拍挂接机位总数是否已达上限（主机位 + 挂接机位 <= 6） */
export function canAttachAnother(beat: Beat): boolean {
  return beat.links.length + 1 < MAX_CAMERAS_PER_BEAT;
}

/** 某镜头是否已挂在节拍上（含主机位判断由调用方排除） */
export function isLinked(beat: Beat, shotId: number): boolean {
  return beat.masterShotId === shotId || beat.links.some((l) => l.shotId === shotId);
}

/** 已拍判定：status === 'shot' */
export function isLinkShot(link: BeatLink): boolean {
  return link.status === 'shot';
}

/** 两版挂接机位帧位是否一致 */
export function sameFrames(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * 主机位帧数/帧区间变化后，重算单个挂接机位。
 *
 * - 未拍：frames 立即更新为换算值，清复核态。
 * - 已拍：frames 保留原值不动，换算值写入 reviewFrames，
 *   不一致时 needsReview = true，等待人工复核。
 *
 * @returns 变化后的 link（新对象）与是否需要写库
 */
export function recomputeLink(
  link: BeatLink,
  anchors: BeatAnchor[],
  masterStart: number,
  masterFps: number,
  shotStartFrame: number,
): BeatLink {
  const nextFrames = convertAnchors(anchors, masterStart, masterFps, shotStartFrame, link.fps);
  const ts = Date.now();
  if (isLinkShot(link)) {
    const needsReview = !sameFrames(link.frames, nextFrames);
    return {
      ...link,
      reviewFrames: nextFrames,
      needsReview,
      updatedAt: ts,
    };
  }
  return {
    ...link,
    frames: nextFrames,
    reviewFrames: [],
    needsReview: false,
    updatedAt: ts,
  };
}

/** 人工复核后采用重算值（已拍机位） */
export function acceptReviewFrames(link: BeatLink): BeatLink {
  return {
    ...link,
    frames: link.reviewFrames.length ? link.reviewFrames : link.frames,
    reviewFrames: [],
    needsReview: false,
    updatedAt: Date.now(),
  };
}

/** 人工复核后保留原值（驳回重算建议） */
export function keepCurrentFrames(link: BeatLink): BeatLink {
  return {
    ...link,
    reviewFrames: [],
    needsReview: false,
    updatedAt: Date.now(),
  };
}

/** 锚点是否有序（允许相等），乱序会破坏帧位对齐 */
export function anchorsSorted(anchors: BeatAnchor[]): boolean {
  return anchors.every((a, i) => i === 0 || a.masterFrame >= anchors[i - 1].masterFrame);
}

/** 生成节拍说明文本：主机位 + N 机位 + 待复核数（界面摘要用） */
export function summarizeBeat(beat: Beat): { cameras: number; review: number } {
  return {
    cameras: beat.links.length + 1,
    review: beat.links.filter((l) => l.needsReview).length,
  };
}
