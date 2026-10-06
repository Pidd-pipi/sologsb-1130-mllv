/**
 * 多机位动作节拍 store。
 *
 * 职责：
 * - 节拍 / 锚点 / 挂接机位的增删改查（同一节拍最多 6 机位）；
 * - 主机位帧数变化（或锚点调整）后按各机位帧率换算帧位：
 *   未拍机位立即重算，已拍机位保留原值、产出待复核版本；
 * - 两设备离线合并：新增直接入库，冲突两版并列进 beatConflicts，
 *   确认前不动当前帧序；
 * - 重算在单个 Dexie 事务内完成，失败整体回滚，并把 store 状态
 *   恢复到动手前快照。
 */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import { db, toPlain } from '../db';
import type {
  Beat,
  BeatAnchor,
  BeatConflict,
  BeatLink,
  BeatMergeReport,
  BeatSyncBundle,
} from '../types/beat';
import { MAX_CAMERAS_PER_BEAT } from '../types/beat';
import {
  acceptReviewFrames,
  anchorsSorted,
  canAttachAnother,
  isLinkShot,
  keepCurrentFrames,
  recomputeLink,
  sameFrames,
} from '../utils/beatMath';
import type { Shot } from '../types/shot';

const DEVICE_KEY = 'gbstopmotion:device';

/** 挂接关系比较摘要（忽略时间戳，只看帧位/状态/帧率） */
function linkDigest(l: BeatLink) {
  return { shotCode: l.shotCode, fps: l.fps, status: l.status, frames: l.frames };
}

interface BeatState {
  beats: Beat[];
  conflicts: BeatConflict[];
  ready: boolean;
}

/** 本机设备标识（离线合并溯源），首次使用时生成并持久化 */
export function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export const useBeatStore = defineStore('beat', {
  state: (): BeatState => ({
    beats: [],
    conflicts: [],
    ready: false,
  }),
  getters: {
    byId(state) {
      return (id: number) => state.beats.find((b) => b.id === id);
    },
    byCode(state) {
      return (code: string) => state.beats.find((b) => b.code === code);
    },
    /** 某镜头参与的全部节拍（主机位或挂接机位） */
    beatsOfShot(state) {
      return (shotId: number) =>
        state.beats.filter((b) => b.masterShotId === shotId || b.links.some((l) => l.shotId === shotId));
    },
    unresolvedConflictCount(state): number {
      return state.conflicts.length;
    },
  },
  actions: {
    async load() {
      const [beats, conflicts] = await Promise.all([api.listBeats(), api.listConflicts()]);
      this.beats = beats;
      this.conflicts = conflicts;
      this.ready = true;
    },

    async reload() {
      await this.load();
    },

    /* ---------------- 节拍 ---------------- */

    /** 新建节拍：以主机位为基准，编号库内唯一 */
    async create(payload: {
      code: string;
      name: string;
      master: Shot;
      anchors?: Omit<BeatAnchor, 'key'>[];
    }): Promise<Beat> {
      const code = payload.code.trim();
      if (!code) throw new Error('节拍编号不能为空');
      if (!payload.master.id) throw new Error('主机位镜头尚未保存');
      if (this.beats.some((b) => b.code === code)) throw new Error(`节拍编号 ${code} 已存在`);
      const count = payload.master.endFrame - payload.master.startFrame + 1;
      const anchors: BeatAnchor[] = (payload.anchors ?? []).map((a, i) => ({
        key: `a${i + 1}`,
        masterFrame: a.masterFrame,
        label: a.label,
        note: a.note,
      }));
      if (!anchorsSorted(anchors)) throw new Error('锚点帧位必须按顺序排列');
      const beat: Beat = toPlain({
        code,
        name: payload.name.trim() || `${payload.master.code} 动作节拍`,
        masterShotId: payload.master.id,
        masterShotCode: payload.master.code,
        masterFps: payload.master.fps,
        masterFrameCount: count,
        anchors,
        links: [],
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const id = await api.addBeat(beat);
      const saved = { ...beat, id };
      this.beats = [...this.beats, saved].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
      return saved;
    },

    async rename(id: number, patch: { code?: string; name?: string }) {
      const beat = this.beats.find((b) => b.id === id);
      if (!beat) return;
      if (patch.code && patch.code !== beat.code && this.beats.some((b) => b.code === patch.code)) {
        throw new Error(`节拍编号 ${patch.code} 已存在`);
      }
      const next = { ...beat, ...patch, revision: beat.revision + 1 };
      await api.updateBeat(id, next);
      this._replace(next);
    },

    async remove(id: number) {
      await api.deleteBeat(id);
      this.beats = this.beats.filter((b) => b.id !== id);
      this.conflicts = this.conflicts.filter((c) => c.local.id !== id);
    },

    /* ---------------- 锚点 ---------------- */

    /** 新增锚点并重算全部挂接机位帧位 */
    async addAnchor(beatId: number, anchor: { masterFrame: number; label: string; note?: string }) {
      const beat = this.beats.find((b) => b.id === beatId);
      if (!beat) return;
      const key = `a${Date.now().toString(36)}${this.beats.length}`;
      const anchors = [...beat.anchors, { key, masterFrame: anchor.masterFrame, label: anchor.label, note: anchor.note }]
        .sort((a, b) => a.masterFrame - b.masterFrame);
      await this._saveAnchorsAndRecompute(beat, anchors);
    },

    /** 修改锚点（帧位 / 文案）并重算 */
    async updateAnchor(beatId: number, key: string, patch: Partial<Omit<BeatAnchor, 'key'>>) {
      const beat = this.beats.find((b) => b.id === beatId);
      if (!beat) return;
      const anchors = beat.anchors.map((a) => (a.key === key ? { ...a, ...patch } : a));
      if (!anchorsSorted(anchors)) throw new Error('锚点帧位必须按顺序排列');
      await this._saveAnchorsAndRecompute(beat, anchors);
    },

    async removeAnchor(beatId: number, key: string) {
      const beat = this.beats.find((b) => b.id === beatId);
      if (!beat) return;
      const anchors = beat.anchors.filter((a) => a.key !== key);
      await this._saveAnchorsAndRecompute(beat, anchors);
    },

    /* ---------------- 挂接机位 ---------------- */

    /** 挂接机位：同一节拍最多 6 机位，主机位不能重复挂接，帧位按各自帧率换算 */
    async attach(beatId: number, shot: Shot): Promise<BeatLink> {
      const beat = this.beats.find((b) => b.id === beatId);
      if (!beat) throw new Error('节拍不存在');
      if (!canAttachAnother(beat)) throw new Error(`同一节拍最多挂 ${MAX_CAMERAS_PER_BEAT} 个机位`);
      if (beat.masterShotId === shot.id) throw new Error('主机位镜头无需挂接');
      if (beat.links.some((l) => l.shotId === shot.id)) throw new Error('该机位已挂接此节拍');
      const master = await api.getShot(beat.masterShotId);
      if (!master) throw new Error('主机位镜头不存在，无法换算帧位');
      const frames = beat.anchors.map((a) => {
        const seconds = (a.masterFrame - master.startFrame) / (beat.masterFps || master.fps);
        return Math.max(1, Math.round(shot.startFrame + seconds * shot.fps));
      });
      const link: BeatLink = toPlain({
        shotId: shot.id as number,
        shotCode: shot.code,
        fps: shot.fps,
        status: shot.status === '已完成' ? 'shot' : 'unshot',
        frames,
        reviewFrames: [],
        needsReview: false,
        attachedAt: Date.now(),
        updatedAt: Date.now(),
      });
      const next = { ...beat, links: [...beat.links, link], revision: beat.revision + 1 };
      await api.updateBeat(beatId, next);
      this._replace(next);
      return link;
    },

    async detach(beatId: number, shotId: number) {
      const beat = this.beats.find((b) => b.id === beatId);
      if (!beat) return;
      const next = {
        ...beat,
        links: beat.links.filter((l) => l.shotId !== shotId),
        revision: beat.revision + 1,
      };
      await api.updateBeat(beatId, next);
      this._replace(next);
    },

    /** 标记机位已拍/未拍（已拍后主机位再变帧数将不再自动覆盖帧位）；
     *  切回未拍时立即按当前主机位时间线换算一次，保持与节拍同步。 */
    async setLinkStatus(beatId: number, shotId: number, status: BeatLink['status']) {
      const beat = this.beats.find((b) => b.id === beatId);
      if (!beat) return;
      let links = beat.links.map((l) =>
        l.shotId === shotId ? { ...l, status, ...(status === 'unshot' ? { reviewFrames: [], needsReview: false } : {}) } : l,
      );
      if (status === 'unshot') {
        const master = await api.getShot(beat.masterShotId);
        const shot = await api.getShot(shotId);
        if (master && shot) {
          links = links.map((l) =>
            l.shotId === shotId
              ? recomputeLink(
                  { ...l, fps: l.fps || shot.fps },
                  beat.anchors,
                  master.startFrame,
                  master.fps,
                  shot.startFrame,
                )
              : l,
          );
        }
      }
      const next = { ...beat, links, revision: beat.revision + 1 };
      await api.updateBeat(beatId, next);
      this._replace(next);
    },

    /** 复核：采用重算后的帧位（已拍机位） */
    async acceptReview(beatId: number, shotId: number) {
      const beat = this.beats.find((b) => b.id === beatId);
      if (!beat) return;
      const links = beat.links.map((l) => (l.shotId === shotId ? acceptReviewFrames(l) : l));
      const next = { ...beat, links, revision: beat.revision + 1 };
      await api.updateBeat(beatId, next);
      this._replace(next);
    },

    /** 复核：保留当前帧位，驳回重算建议 */
    async keepCurrent(beatId: number, shotId: number) {
      const beat = this.beats.find((b) => b.id === beatId);
      if (!beat) return;
      const links = beat.links.map((l) => (l.shotId === shotId ? keepCurrentFrames(l) : l));
      const next = { ...beat, links, revision: beat.revision + 1 };
      await api.updateBeat(beatId, next);
      this._replace(next);
    },

    /* ---------------- 主机位帧数变化联动 ---------------- */

    /**
     * 主机位帧数一变时的入口：以该镜头为主机位的全部节拍立即重算。
     * - 未拍挂接机位：换算帧位立即生效，并把镜头帧区间按其帧率对齐；
     * - 已拍挂接机位：帧位保留原值，换算值进 reviewFrames 待复核。
     * 整个过程一个 Dexie 事务，失败整体回滚 DB 并恢复 store 内存态。
     */
    async recomputeForMaster(masterShotId: number): Promise<{ recomputed: number; review: number }> {
      const affected = this.beats.filter((b) => b.masterShotId === masterShotId);
      if (!affected.length) return { recomputed: 0, review: 0 };
      // 动手前快照（事务回滚 DB，内存态靠这份快照恢复）
      const beatsSnap = JSON.parse(JSON.stringify(affected)) as Beat[];

      try {
        const master = await api.getShot(masterShotId);
        if (!master) throw new Error('主机位镜头不存在');
        const masterStart = master.startFrame;
        const masterFps = master.fps;
        const newCount = master.endFrame - master.startFrame + 1;

        const beatWrites: Beat[] = [];

        for (const beat of affected) {
          const links: BeatLink[] = [];
          for (const link of beat.links) {
            const shot = await api.getShot(link.shotId);
            if (!shot) throw new Error(`挂接机位镜头 ${link.shotCode} 不存在，重算中止`);
            // 各镜头各排各的：节拍只换算动作锚点帧位，不改挂接镜头自身的帧区间/时长
            links.push(
              recomputeLink(
                { ...link, fps: link.fps || shot.fps },
                beat.anchors,
                masterStart,
                masterFps,
                shot.startFrame,
              ),
            );
          }
          beatWrites.push({
            ...beat,
            masterFps,
            masterFrameCount: newCount,
            links,
            revision: beat.revision + 1,
            updatedAt: Date.now(),
          });
        }

        await db.transaction('rw', db.beats, async () => {
          for (const b of beatWrites) {
            if (typeof b.id !== 'number') throw new Error('节拍缺少 id');
            const { id, ...rest } = b;
            await db.beats.update(id, toPlain(rest));
          }
        });

        // 事务提交成功后才更新节拍内存态
        this.beats = this.beats.map((b) => beatWrites.find((w) => w.id === b.id) ?? b);
        return {
          recomputed: beatWrites.reduce((n, b) => n + b.links.filter((l) => !l.needsReview).length, 0),
          review: beatWrites.reduce((n, b) => n + b.links.filter((l) => l.needsReview).length, 0),
        };
      } catch (e) {
        // 重算失败：恢复动手前记录（事务已自动回滚 DB，这里还原节拍内存态）
        this.beats = this.beats.map((b) => beatsSnap.find((s) => s.id === b.id) ?? b);
        throw e instanceof Error ? e : new Error('节拍重算失败，已恢复动手前记录');
      }
    },

    /* ---------------- 离线合并 ---------------- */

    /** 导出本机节拍同步包（JSON，供另一台设备离线导入） */
    exportBundle(deviceName = ''): string {
      const bundle: BeatSyncBundle = {
        deviceId: deviceId(),
        deviceName: deviceName || `设备 ${deviceId().slice(-4)}`,
        exportedAt: Date.now(),
        format: 1,
        beats: JSON.parse(JSON.stringify(this.beats)) as Beat[],
      };
      return JSON.stringify(bundle, null, 2);
    },

    /**
     * 离线导入另一台设备的节拍包：
     * - 本地没有的节拍：按镜号把 shotId 重映射后直接新增；
     * - 本地已有且内容一致：跳过；
     * - 本地已有但内容冲突（节拍本体或挂接关系）：两版并列存入
     *   beatConflicts，确认前不动当前帧序。
     */
    async importBundle(json: string, shots: Shot[]): Promise<BeatMergeReport> {
      let bundle: BeatSyncBundle;
      try {
        bundle = JSON.parse(json) as BeatSyncBundle;
      } catch {
        throw new Error('同步包不是有效的 JSON');
      }
      if (!bundle || bundle.format !== 1 || !Array.isArray(bundle.beats)) {
        throw new Error('同步包格式不受支持');
      }
      const report: BeatMergeReport = { added: 0, updated: 0, conflicted: [] };

      for (const raw of bundle.beats) {
        const incoming = this._remapShotIds(raw, shots);
        const local = this.byCode(incoming.code) ?? (await api.getBeatByCode(incoming.code));
        if (!local) {
          const { id: _omit, ...rest } = incoming;
          const id = await api.addBeat(rest as Beat);
          this.beats = [...this.beats, { ...(rest as Beat), id }].sort((a, b) =>
            a.code.localeCompare(b.code, 'zh-Hans-CN'),
          );
          report.added += 1;
          continue;
        }
        if (this._beatsEqual(local, incoming)) continue;

        // 冲突：两版并列，不改动当前节拍帧序
        const linkConflicts = this._diffLinks(local.links, incoming.links);
        await api.addConflict({
          beatCode: local.code,
          beatName: local.name,
          local: JSON.parse(JSON.stringify(local)) as Beat,
          incoming: JSON.parse(JSON.stringify(incoming)) as Beat,
          incomingDeviceId: bundle.deviceId,
          incomingDeviceName: bundle.deviceName,
          linkConflicts,
          createdAt: Date.now(),
          resolved: false,
        });
        report.conflicted.push(local.code);
      }
      this.conflicts = await api.listConflicts();
      return report;
    },

    /**
     * 冲突裁定：采用本地版或离线版。
     * 裁定完成前当前帧序一直保持本地版不动。
     */
    async resolveConflict(conflictId: number, choice: 'local' | 'incoming') {
      const conflict = this.conflicts.find((c) => c.id === conflictId);
      if (!conflict) return;
      const chosen = choice === 'incoming' ? conflict.incoming : conflict.local;
      const localId = conflict.local.id;
      const next: Beat = {
        ...JSON.parse(JSON.stringify(chosen)),
        id: localId,
        code: conflict.local.code,
        revision: Math.max(conflict.local.revision, conflict.incoming.revision) + 1,
        updatedAt: Date.now(),
      };
      await api.bulkPutBeats([next]);
      await api.resolveConflict(conflictId);
      this._replace(next);
      this.conflicts = await api.listConflicts();
    },

    async dismissConflict(conflictId: number) {
      await api.resolveConflict(conflictId);
      this.conflicts = this.conflicts.filter((c) => c.id !== conflictId);
    },

    /* ---------------- 内部工具 ---------------- */

    /** 保存锚点后按当前主机位帧区间重算挂接机位（锚点编辑的统一出口） */
    async _saveAnchorsAndRecompute(beat: Beat, anchors: BeatAnchor[]) {
      const master = await api.getShot(beat.masterShotId);
      if (!master) throw new Error('主机位镜头不存在，无法换算帧位');
      const links = beat.links.map(async (link) => {
        const shot = await api.getShot(link.shotId);
        if (!shot) throw new Error(`挂接机位镜头 ${link.shotCode} 不存在，重算中止`);
        return recomputeLink(
          { ...link, fps: link.fps || shot.fps },
          anchors,
          master.startFrame,
          master.fps,
          shot.startFrame,
        );
      });
      const resolvedLinks = await Promise.all(links);
      const next: Beat = {
        ...beat,
        anchors,
        masterFps: master.fps,
        masterFrameCount: master.endFrame - master.startFrame + 1,
        links: resolvedLinks,
        revision: beat.revision + 1,
        updatedAt: Date.now(),
      };
      await db.transaction('rw', db.beats, async () => {
        if (typeof next.id !== 'number') throw new Error('节拍缺少 id');
        const { id, ...rest } = next;
        await db.beats.update(id, toPlain(rest));
      });
      this._replace(next);
    },

    _replace(beat: Beat) {
      this.beats = this.beats.map((b) => (b.id === beat.id ? beat : b));
    },

    /** 跨设备导入时按镜号重映射 shotId（各设备自增 id 不一致） */
    _remapShotIds(beat: Beat, shots: Shot[]): Beat {
      const mapId = (code: string, fallback: number) => shots.find((s) => s.code === code)?.id ?? fallback;
      const clone: Beat = JSON.parse(JSON.stringify(beat));
      clone.masterShotId = mapId(clone.masterShotCode, clone.masterShotId);
      clone.links = clone.links.map((l) => ({ ...l, shotId: mapId(l.shotCode, l.shotId) }));
      return clone;
    },

    _beatsEqual(a: Beat, b: Beat): boolean {
      return (
        a.name === b.name &&
        a.masterShotCode === b.masterShotCode &&
        a.masterFps === b.masterFps &&
        a.masterFrameCount === b.masterFrameCount &&
        JSON.stringify(a.anchors) === JSON.stringify(b.anchors) &&
        JSON.stringify(a.links.map(linkDigest)) === JSON.stringify(b.links.map(linkDigest))
      );
    },

    _diffLinks(local: BeatLink[], incoming: BeatLink[]) {
      const conflicts = [];
      for (const inc of incoming) {
        const loc = local.find((l) => l.shotId === inc.shotId || l.shotCode === inc.shotCode);
        if (!loc) continue; // 新增挂接不属于冲突
        if (
          loc.status !== inc.status ||
          loc.fps !== inc.fps ||
          !sameFrames(loc.frames, inc.frames)
        ) {
          conflicts.push({ shotId: loc.shotId, shotCode: loc.shotCode, local: loc, incoming: inc });
        }
      }
      return conflicts;
    },
  },
});
