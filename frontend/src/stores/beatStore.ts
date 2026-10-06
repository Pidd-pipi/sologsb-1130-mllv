/**
 * 动作节拍 store：
 *  - 新建节拍（主机位为时间基准）、挂接/摘除从机位（同一节拍最多 6 个机位）
 *  - 挂接与重算按各自帧率换算帧位
 *  - 主机位帧数一变：未拍镜头立即采用新帧位；已拍镜头保留原值，新值进建议待复核
 *  - 有未决合并冲突的节拍冻结，确认前不动当前帧序
 *  - 重算在单事务内提交，失败回滚到动手前，并把涉及节拍降级为单机位节拍（legacy）
 */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import { toPlain } from '../db';
import { MAX_CAMERAS_PER_BEAT, createEmptyBeat, type ActionBeat, type BeatAttachment, type BeatPackage } from '../types/beat';
import { convertFramePos, recalcAttachment } from '../utils/beatMath';
import { parseBeatPackage, planMerge, resolveConflict, type ConflictChoice, type MergePlan } from '../utils/beatMerge';
import type { Shot } from '../types/shot';

interface CreateBeatInput {
  name: string;
  masterShotId: number;
  masterFrame: number;
}

interface AttachInput {
  beatId: number;
  shotId: number;
  framePos?: number;
}

/** 主机位镜头帧数变化的前后快照 */
export interface MasterFrameChange {
  oldShot: Shot;
  newShot: Shot;
}

interface BeatState {
  beats: ActionBeat[];
  ready: boolean;
  busy: boolean;
  lastError: string;
}

export class BeatLimitError extends Error {}
export class BeatConflictFrozenError extends Error {}
export class BeatRecalcError extends Error {}

/**
 * 重算批量写库函数；默认走 Dexie。
 * 抽成模块级变量是为了在自动化测试里可注入一次写库失败，验证回滚与降级。
 */
let bulkPutWriter: (beats: ActionBeat[]) => Promise<void> = (rows) => api.bulkPutBeats(rows);

/** @test-only 注入重算写库实现（如模拟失败）；传 undefined 恢复默认 */
export function __setBulkPutWriterForTest(writer?: (beats: ActionBeat[]) => Promise<void>) {
  bulkPutWriter = writer ?? ((rows) => api.bulkPutBeats(rows));
}

export const useBeatStore = defineStore('beat', {
  state: (): BeatState => ({
    beats: [],
    ready: false,
    busy: false,
    lastError: '',
  }),
  getters: {
    byId(state) {
      return (id: number) => state.beats.find((b) => b.id === id);
    },
    /** 某镜头作主机位的节拍 */
    beatsOfMaster(state) {
      return (shotId: number) => state.beats.filter((b) => b.masterShotId === shotId);
    },
    /** 某镜头挂接在哪些节拍上（含主机位自身） */
    beatsOfShot(state) {
      return (shotId: number) =>
        state.beats.filter((b) => b.masterShotId === shotId || b.attachments.some((a) => a.shotId === shotId));
    },
    /** 存在待处理合并冲突的节拍 */
    conflicted(state): ActionBeat[] {
      return state.beats.filter((b) => b.conflicts.length > 0);
    },
    pendingConflictCount(state): number {
      return state.beats.reduce((sum, b) => sum + b.conflicts.length, 0);
    },
    cameraCapacity(state) {
      return (beat: ActionBeat) => MAX_CAMERAS_PER_BEAT - (1 + beat.attachments.length);
    },
  },
  actions: {
    async load() {
      try {
        this.beats = await api.listBeats();
        this.ready = true;
      } catch (e) {
        this.beats = [];
        this.ready = true;
        throw e;
      }
    },

    async create(input: CreateBeatInput): Promise<ActionBeat> {
      const master = await api.getShot(input.masterShotId);
      if (!master || typeof master.id !== 'number') throw new Error('主机位镜头不存在');
      const count = master.endFrame - master.startFrame + 1;
      const frame = Math.min(Math.max(1, Math.floor(input.masterFrame) || 1), Math.max(1, count));
      const beat = createEmptyBeat(master.id, master.code, master.fps, frame);
      beat.name = input.name.trim() || `${master.code} 动作节拍`;
      const id = await api.addBeat(beat);
      const saved = { ...beat, id };
      this.beats = [...this.beats, saved];
      return saved;
    },

    async rename(id: number, name: string) {
      await this.mutate(id, (b) => {
        b.name = name.trim() || b.name;
      });
    },

    /** 历史升级出的单机位节拍重新纳入多机位联动（清空遗留待办后启用） */
    async enableMultiCamera(id: number) {
      await this.mutate(id, (b) => {
        b.legacy = false;
        b.conflicts = [];
        b.attachments = b.attachments.map((a) => ({
          ...a,
          previousFramePos: null,
          suggestedFramePos: null,
          reviewState: 'none' as const,
        }));
      });
    },

    async remove(id: number) {
      await api.deleteBeat(id);
      this.beats = this.beats.filter((b) => b.id !== id);
    },

    /** 挂接一个从机位；同一镜头不可重复挂、总数（含主机）≤ 6 */
    async attach(input: AttachInput): Promise<void> {
      const beat = this.beats.find((b) => b.id === input.beatId);
      const target = await api.getShot(input.shotId);
      if (!beat || typeof beat.id !== 'number') throw new Error('节拍不存在');
      if (!target || typeof target.id !== 'number') throw new Error('要挂接的镜头不存在');
      if (beat.legacy) throw new BeatLimitError('该节拍是单机位节拍，已脱离多机位联动，不能再挂接');
      if (beat.conflicts.length > 0) throw new BeatConflictFrozenError('该节拍存在待确认的合并冲突，确认前不能改动挂接');
      if (beat.masterShotId === input.shotId) throw new BeatLimitError('主机位已在节拍上，无需重复挂接');
      if (beat.attachments.some((a) => a.shotId === input.shotId)) throw new BeatLimitError('该镜头已挂接在本节拍');
      if (1 + beat.attachments.length >= MAX_CAMERAS_PER_BEAT) {
        throw new BeatLimitError(`同一节拍最多挂 ${MAX_CAMERAS_PER_BEAT} 个机位（含主机位）`);
      }
      const framePos =
        typeof input.framePos === 'number'
          ? Math.max(1, Math.floor(input.framePos))
          : convertFramePos(beat.masterFrame, beat.masterFps, target.fps);
      const att: BeatAttachment = {
        uuid: `att_${beat.uuid}_${target.id}`,
        shotId: target.id,
        shotCode: target.code,
        fps: target.fps,
        framePos,
        previousFramePos: null,
        suggestedFramePos: null,
        reviewState: 'none',
        updatedAt: Date.now(),
      };
      await this.mutate(beat.id, (b) => {
        b.attachments.push(att);
      });
    },

    async detach(beatId: number, attachmentUuid: string) {
      await this.mutate(beatId, (b) => {
        b.attachments = b.attachments.filter((a) => a.uuid !== attachmentUuid);
        // 摘除后剩主机位：仍可继续挂，不强制 legacy
      });
    },

    /** 手动调整某挂接机位帧位（动画师核对后改） */
    async setAttachmentFrame(beatId: number, attachmentUuid: string, framePos: number) {
      await this.mutate(beatId, (b) => {
        const att = b.attachments.find((a) => a.uuid === attachmentUuid);
        if (!att) return;
        att.framePos = Math.max(1, Math.floor(framePos) || 1);
        att.previousFramePos = null;
        att.suggestedFramePos = null;
        att.reviewState = 'none';
      });
    },

    /** 手动挪动主机位帧号（动作点在主机位移帧）→ 未拍立即重算，已拍待复核 */
    async setMasterFrame(beatId: number, frame: number) {
      const beat = this.beats.find((b) => b.id === beatId);
      if (!beat) throw new Error('节拍不存在');
      if (beat.conflicts.length > 0) throw new BeatConflictFrozenError('存在待确认的合并冲突，确认前不动当前帧序');
      const next = Math.max(1, Math.floor(frame) || 1);
      if (next === beat.masterFrame) return;
      const takenMap = await this.buildTakenMap();
      const draft = this.recalcDraft(beat, next, beat.masterFps, takenMap);
      await this.commitRecalc([draft]);
    },

    /**
     * 主机位镜头帧数一变（时长/帧率/帧序增删）后的联动入口。
     * 重锚主机位帧号，再按各从机位帧率换算；未拍立即采用，已拍保留待复核。
     */
    async onMasterShotFramesChanged(shotId: number, oldShot: Shot, newShot: Shot) {
      if (!oldShot || !newShot) return;
      const oldCount = Math.max(1, oldShot.endFrame - oldShot.startFrame + 1);
      const newCount = Math.max(1, newShot.endFrame - newShot.startFrame + 1);
      const affected: ActionBeat[] = [];
      const takenMap = await this.buildTakenMap();
      for (const beat of this.beats.filter((b) => b.masterShotId === shotId)) {
        if (beat.legacy || beat.conflicts.length > 0) continue; // 单机位 / 冲突冻结：不动
        const reanchored = this.reanchorMaster(beat.masterFrame, { fps: oldShot.fps, count: oldCount }, { fps: newShot.fps, count: newCount });
        const draft = this.recalcDraft(
          { ...beat, masterFps: newShot.fps },
          reanchored,
          newShot.fps,
          takenMap,
        );
        draft.masterFps = newShot.fps;
        affected.push(draft);
      }
      if (affected.length) await this.commitRecalc(affected);
    },

    /** 已拍镜头复核：采用建议帧位 */
    async acceptSuggestion(beatId: number, attachmentUuid: string) {
      await this.mutate(beatId, (b) => {
        const att = b.attachments.find((a) => a.uuid === attachmentUuid);
        if (!att || att.reviewState !== 'pending') return;
        if (att.suggestedFramePos !== null) att.framePos = att.suggestedFramePos;
        att.previousFramePos = null;
        att.suggestedFramePos = null;
        att.reviewState = 'none';
      });
    },

    /** 已拍镜头复核：保留原值，驳回建议 */
    async rejectSuggestion(beatId: number, attachmentUuid: string) {
      await this.mutate(beatId, (b) => {
        const att = b.attachments.find((a) => a.uuid === attachmentUuid);
        if (!att || att.reviewState !== 'pending') return;
        att.previousFramePos = null;
        att.suggestedFramePos = null;
        att.reviewState = 'none';
      });
    },

    /* ---------------- 离线合并 ---------------- */

    async previewImport(text: string): Promise<MergePlan> {
      const pkg = parseBeatPackage(text);
      const shots = await api.listShots();
      return planMerge(
        pkg.beats,
        this.beats,
        shots.map((s) => ({ id: s.id as number, code: s.code, fps: s.fps })),
        MAX_CAMERAS_PER_BEAT,
      );
    },

    /** 按合并计划落库：冲突项两版并列（保持本机帧序），无冲突直接并入 */
    async applyImport(plan: MergePlan): Promise<void> {
      const snapshot = this.snapshot();
      try {
        const next = new Map(this.beats.map((b) => [b.uuid, b]));
        for (const item of plan.items) {
          if (item.action === 'skip') continue;
          next.set(item.merged.uuid, item.merged);
        }
        const merged = [...next.values()];
        await api.bulkPutBeats(merged);
        this.beats = await api.listBeats();
      } catch (e) {
        this.restore(snapshot);
        this.lastError = '节拍合并失败，已恢复合并前记录';
        throw e;
      }
    },

    /** 导出本机全部节拍为离线包（JSON 字符串） */
    async exportPackage(device = 'device-local'): Promise<string> {
      const rows = await api.listBeats();
      const pkg: BeatPackage = {
        format: 'gbstopmotion-beats',
        version: 1,
        device,
        exportedAt: Date.now(),
        beats: rows,
      };
      return JSON.stringify(pkg, null, 2);
    },

    async resolveConflict(beatId: number, conflictUuid: string, choice: ConflictChoice) {
      const beat = this.beats.find((b) => b.id === beatId);
      if (!beat || typeof beat.id !== 'number') return;
      const shots = await api.listShots();
      const fpsByCode = new Map(shots.map((s) => [s.code, s.fps]));
      const idByCode = new Map(shots.map((s) => [s.code, s.id as number]));
      let next = resolveConflict(beat, conflictUuid, choice);
      // 采用并入后，按本机镜头目录补 shotId / 校准帧率快照；本机尚无该镜号则置 null 占位
      for (const att of next.attachments) {
        att.shotId = idByCode.has(att.shotCode) ? (idByCode.get(att.shotCode) as number) : null;
        if (fpsByCode.has(att.shotCode)) att.fps = fpsByCode.get(att.shotCode) as number;
      }
      if (next.masterShotId !== beat.masterShotId) {
        next.masterShotId = idByCode.has(next.masterShotCode) ? (idByCode.get(next.masterShotCode) as number) : -1;
      }
      // 主机位帧号被并入：对从机位做一次重算（未拍/已拍规则）
      const changedMaster = next.masterFrame !== beat.masterFrame || next.masterFps !== beat.masterFps;
      if (changedMaster && next.conflicts.length === 0) {
        const takenMap = await this.buildTakenMap();
        next = this.recalcDraft(next, next.masterFrame, next.masterFps, takenMap);
      }
      await api.putBeat(toPlain(next));
      this.beats = await api.listBeats();
    },

    /* ---------------- 内部工具 ---------------- */

    /** 内存改动统一落库（单条） */
    async mutate(id: number, fn: (draft: ActionBeat) => void) {
      const beat = this.beats.find((b) => b.id === id);
      if (!beat || typeof beat.id !== 'number') return;
      const draft: ActionBeat = JSON.parse(JSON.stringify(beat));
      fn(draft);
      draft.updatedAt = Date.now();
      await api.putBeat(toPlain(draft));
      this.beats = this.beats.map((b) => (b.id === id ? draft : b));
    },

    /** shotId → 累计实拍张数（>0 即已拍） */
    async buildTakenMap(): Promise<Map<number, number>> {
      const takes = await api.listTakes();
      const map = new Map<number, number>();
      for (const t of takes) {
        map.set(t.shotId, (map.get(t.shotId) ?? 0) + (t.takenFrames || 0));
      }
      return map;
    },

    /**
     * 主机位帧数变化后重锚节拍帧位（互斥，保证一次操作内多次触发幂等）：
     * 帧率改变（帧数往往随帧率变）→ 动作所处时间点不变，按 (帧-1)/帧率 换算；
     * 仅帧数（时长/增删）改变、帧率不变 → 动作相对位置不变，按比例缩放。
     */
    reanchorMaster(masterFrame: number, oldCtx: { fps: number; count: number }, newCtx: { fps: number; count: number }): number {
      const m = Math.max(1, Math.round(masterFrame));
      let pos = m;
      if (oldCtx.fps !== newCtx.fps && oldCtx.fps > 0 && newCtx.fps > 0) {
        pos = convertFramePos(m, oldCtx.fps, newCtx.fps);
      } else if (oldCtx.count !== newCtx.count) {
        if (oldCtx.count > 1) {
          const ratio = (m - 1) / (oldCtx.count - 1);
          pos = newCtx.count > 1 ? Math.round(ratio * (newCtx.count - 1)) + 1 : 1;
        } else {
          pos = 1;
        }
      }
      return Math.min(Math.max(1, pos), Math.max(1, newCtx.count));
    },

    /**
     * 生成重算草稿（不落库）：更新主机位帧号，逐挂接机位换算。
     * 未拍镜头：立即采用新帧位；已拍镜头：保留原值，建议值进 suggestedFramePos 待复核。
     */
    recalcDraft(beat: ActionBeat, nextMasterFrame: number, nextMasterFps: number, takenMap: Map<number, number>): ActionBeat {
      const draft: ActionBeat = JSON.parse(JSON.stringify(beat));
      draft.previousMasterFrame = beat.masterFrame;
      draft.masterFrame = nextMasterFrame;
      draft.masterFps = nextMasterFps;
      draft.attachments = draft.attachments.map((att) => {
        const taken = (takenMap.get(att.shotId ?? -1) ?? 0) > 0;
        const result = recalcAttachment(beat.masterFrame, nextMasterFrame, nextMasterFps, att.fps, att.framePos, taken);
        if (!result.changed) {
          return att;
        }
        if (result.needsReview) {
          // 已拍：保留原 framePos，新值待复核
          return {
            ...att,
            previousFramePos: att.framePos,
            suggestedFramePos: result.nextFramePos,
            reviewState: 'pending' as const,
          };
        }
        // 未拍：立即采用
        return {
          ...att,
          framePos: result.nextFramePos,
          previousFramePos: null,
          suggestedFramePos: null,
          reviewState: 'none' as const,
        };
      });
      draft.updatedAt = Date.now();
      return draft;
    },

    /** 事务提交重算；失败回滚动手前记录并把涉及节拍降级为单机位节拍 */
    async commitRecalc(drafts: ActionBeat[]) {
      if (!drafts.length) return;
      this.busy = true;
      const snapshot = this.snapshot();
      const ids = new Set(drafts.map((d) => d.id));
      try {
        await bulkPutWriter(drafts.map((d) => toPlain(d)));
        this.beats = await api.listBeats();
      } catch (e) {
        // 重算失败：恢复动手前记录
        this.restore(snapshot);
        this.lastError = '动作节拍重算失败，已恢复动手前记录；相关节拍降级为单机位节拍';
        // 历史/当前数据升级（降级）为单机位节拍：脱离多机位联动，数据保留待人工处理
        await this.downgradeToLegacy(ids);
        this.beats = await api.listBeats();
        throw new BeatRecalcError(this.lastError);
      } finally {
        this.busy = false;
      }
    },

    /** 降级为单机位节拍（legacy）：保留数据、清空待复核建议、不再参与联动 */
    async downgradeToLegacy(ids: Set<number | undefined>) {
      for (const id of ids) {
        if (typeof id !== 'number') continue;
        try {
          const beat = await api.getBeat(id);
          if (!beat) continue;
          const legacy: ActionBeat = {
            ...beat,
            legacy: true,
            attachments: beat.attachments.map((a) => ({
              ...a,
              previousFramePos: null,
              suggestedFramePos: null,
              reviewState: 'none' as const,
            })),
            updatedAt: Date.now(),
          };
          await api.putBeat(toPlain(legacy));
        } catch {
          // 单条降级失败不阻断其余恢复
        }
      }
    },

    snapshot(): ActionBeat[] {
      return JSON.parse(JSON.stringify(this.beats)) as ActionBeat[];
    },

    restore(snapshot: ActionBeat[]) {
      this.beats = snapshot;
    },
  },
});
