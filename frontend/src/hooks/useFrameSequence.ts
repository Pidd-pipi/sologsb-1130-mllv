/**
 * 帧序编排：插入 / 删除 / 移动帧并重排帧序号，联动镜头帧区间。
 * 被 /frames 与 /shots/:id 消费。
 *
 * 多机位节拍联动：主机位镜头帧数/帧率一变（插删帧、改时长、改帧率），
 * 在每次操作的「动手前快照 → 落库后快照」之间触发一次节拍重算，
 * 未拍从机位立即重算，已拍从机位保留原值待复核。
 */
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useFrameStore } from '../stores/frameStore';
import { useShotStore } from '../stores/shotStore';
import { useBeatStore } from '../stores/beatStore';
import { durationToFrames, framesToDuration } from '../utils/frameMath';
import type { FrameEntry } from '../types/frame';
import type { Shot as ShotModel } from '../types/shot';

export function useFrameSequence() {
  const frameStore = useFrameStore();
  const shotStore = useShotStore();
  const beatStore = useBeatStore();
  const { frames, selectedFrameNo } = storeToRefs(frameStore);

  const shotId = computed(() => frameStore.shotId);
  const shot = computed(() => (shotId.value === null ? undefined : shotStore.byId(shotId.value)));
  const fps = computed(() => shot.value?.fps ?? 24);
  const frameCount = computed(() => frames.value.length);
  const totalDuration = computed(() => framesToDuration(frameCount.value, fps.value));
  const plannedFrames = computed(() => durationToFrames(shot.value?.durationSec ?? 0, fps.value));

  /** 动手前镜头快照（深拷贝，供节拍重算的「旧帧序数/帧率」对照） */
  function snapshotShot(): ShotModel | undefined {
    const current = shotId.value === null ? undefined : shotStore.byId(shotId.value);
    return current ? JSON.parse(JSON.stringify(current)) as ShotModel : undefined;
  }

  /**
   * 帧序/参数变化后重算镜头的帧区间与时长，并触发动作节拍联动。
   * 帧区间与条带上的帧条目一一对应（结束帧号 = 起始帧号 + 帧条目数 - 1），
   * 时长 = 帧条目数 ÷ 帧率；新增帧即延长本段，删除帧即缩短本段。
   */
  async function syncShotRange(before?: ShotModel) {
    if (shotId.value === null) return;
    const current = shotStore.byId(shotId.value);
    if (!current) return;
    const fpsValue = current.fps || 24;
    const count = Math.max(1, frames.value.length);
    const seconds = Math.round((count / fpsValue) * 1000) / 1000;
    await shotStore.update(shotId.value, {
      durationSec: seconds,
      startFrame: current.startFrame,
      endFrame: current.startFrame + count - 1,
    });
    await propagateBeats(before);
  }

  /** 主机位帧数/帧率一变 → 联动重算挂接机位（动手前 before → 落库后当前） */
  async function propagateBeats(before?: ShotModel) {
    if (shotId.value === null || !before) return;
    if (!beatStore.ready) return;
    if (!beatStore.beatsOfShot(shotId.value).some((b) => b.masterShotId === shotId.value && !b.legacy)) return;
    const after = shotStore.byId(shotId.value);
    if (!after) return;
    if (before.fps === after.fps && before.endFrame - before.startFrame === after.endFrame - after.startFrame) return;
    try {
      await beatStore.onMasterShotFramesChanged(shotId.value, before, after);
    } catch (e) {
      // 重算失败 store 已回滚并降级为单机位节拍，这里不阻断帧序主流程
      console.error('[beat] 主机位帧变联动失败', e);
    }
  }

  async function insertAfter(frameNo: number | null) {
    const before = snapshotShot();
    const index = frameNo === null ? frames.value.length : frames.value.findIndex((f) => f.frameNo === frameNo) + 1;
    await frameStore.insertAt(Math.max(0, index));
    await syncShotRange(before);
  }

  async function removeAt(frameNo: number) {
    const before = snapshotShot();
    const index = frames.value.findIndex((f) => f.frameNo === frameNo);
    if (index < 0) return;
    await frameStore.removeAt(index);
    await syncShotRange(before);
  }

  async function move(fromIndex: number, toIndex: number) {
    // 移动不改变帧条目数与时长，帧序区间不变，节拍帧位也不变，故无需联动
    await frameStore.move(fromIndex, toIndex);
  }

  /** 修改时长：按新时长重排帧区间（帧数变化），再联动节拍 */
  async function changeDuration(seconds: number) {
    const before = snapshotShot();
    if (shotId.value === null) return;
    await shotStore.update(shotId.value, { durationSec: seconds });
    await propagateBeats(before);
  }

  /** 改帧率：保持帧条目数（拍摄动作节拍以张数为序），仅改帧率与时长，再联动节拍 */
  async function changeFps(nextFps: number) {
    const before = snapshotShot();
    if (shotId.value === null) return;
    const current = shotStore.byId(shotId.value);
    if (!current) return;
    const count = Math.max(1, frames.value.length || current.endFrame - current.startFrame + 1);
    await shotStore.update(shotId.value, {
      fps: nextFps,
      durationSec: Math.round((count / nextFps) * 1000) / 1000,
      startFrame: current.startFrame,
      endFrame: current.startFrame + count - 1,
    });
    await propagateBeats(before);
  }

  /** 条带上的单帧曝光/位移改动 */
  async function patch(frameNo: number, patchValue: Partial<FrameEntry>) {
    await frameStore.patchFrame(frameNo, patchValue);
  }

  function select(frameNo: number | null) {
    frameStore.select(frameNo);
  }

  return {
    frames,
    selectedFrameNo,
    shot,
    fps,
    frameCount,
    totalDuration,
    plannedFrames,
    insertAfter,
    removeAt,
    move,
    changeDuration,
    changeFps,
    patch,
    select,
    syncShotRange,
    reload: (id: number) => frameStore.loadForShot(id),
  };
}
