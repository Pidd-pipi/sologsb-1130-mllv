/**
 * IndexedDB 持久化层（Dexie 封装）。
 * 库名 gbstopmotion-db，含版本号与升级迁移：
 *   v1 建 shots / frames
 *   v2 增加 props 表与 shotId 索引
 *   v3 增加 takes 表，并按实拍张数回填进度
 *   v4 增加 beats / beatConflicts 表（多机位动作节拍），
 *      历史镜头逐一生成「单机位节拍」（主机位即镜头自身、无挂接机位）
 */
import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import type { Beat, BeatConflict } from '../types/beat';

export const DB_NAME = 'gbstopmotion-db';

/**
 * 脱代理：Pinia 里的对象是 Proxy，直接写进 IndexedDB 会抛 DataCloneError。
 * 这里统一做一次结构化克隆后的纯对象转换。
 */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export class StopMotionDb extends Dexie {
  shots!: Table<Shot, number>;
  frames!: Table<FrameEntry, number>;
  props!: Table<PropState, number>;
  takes!: Table<TakeLog, number>;
  beats!: Table<Beat, number>;
  beatConflicts!: Table<BeatConflict, number>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      shots: '++id, code, status, sceneName',
      frames: '++id, shotId, frameNo, [shotId+frameNo]',
    });
    this.version(2)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
      })
      .upgrade(async (tx) => {
        // v2：为已有帧补齐道具位移字段，保证轨迹页可直接读取
        await tx
          .table('frames')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.propOffsetMm !== 'number') row.propOffsetMm = 0;
          });
      });
    this.version(3)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode',
      })
      .upgrade(async (tx) => {
        // v3：按已登记的实拍张数回填完成百分比
        const takes = await tx.table('takes').toCollection().toArray();
        const shots = await tx.table('shots').toCollection().toArray();
        for (const take of takes) {
          const shot = shots.find((s: Record<string, unknown>) => s.id === take.shotId);
          if (!shot || typeof shot.durationSec !== 'number' || typeof shot.fps !== 'number') continue;
          const total = Math.max(1, Math.ceil(shot.durationSec * shot.fps));
          const percent = Math.min(100, Math.round((take.takenFrames / total) * 100));
          await tx.table('takes').update(take.id, { percent });
        }
      });
    this.version(4)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode',
        beats: '++id, code, masterShotId, updatedAt',
        beatConflicts: '++id, beatCode, resolved',
      })
      .upgrade(async (tx) => {
        // v4：历史数据升级——每个镜头派生一个单机位节拍
        // （主机位即镜头自身、无锚点、无挂接机位），帧序维持原值。
        const shots = await tx.table('shots').toCollection().toArray();
        const usedCodes = new Set<string>();
        const beats: Record<string, unknown>[] = [];
        for (const shot of shots as Record<string, unknown>[]) {
          const shotId = Number(shot.id);
          const shotCode = String(shot.code ?? '');
          let code = shotCode ? `B-${shotCode}` : `B-S${shotId}`;
          // 镜号重复时追加镜头 id，保证节拍编号（离线合并匹配键）唯一
          if (usedCodes.has(code)) code = `${code}-${shotId}`;
          usedCodes.add(code);
          const fps = Number(shot.fps) > 0 ? Number(shot.fps) : 24;
          const start = Number(shot.startFrame) || 1;
          const end = Number(shot.endFrame) ?? start;
          beats.push({
            code,
            name: `${String(shot.sceneName ?? shotCode ?? '未命名镜头')}（单机位节拍）`,
            masterShotId: shotId,
            masterShotCode: shotCode,
            masterFps: fps,
            masterFrameCount: Math.max(1, end - start + 1),
            anchors: [],
            links: [],
            revision: 1,
            createdAt: Number(shot.createdAt) || Date.now(),
            updatedAt: Number(shot.updatedAt) || Date.now(),
          });
        }
        if (beats.length) await tx.table('beats').bulkAdd(beats);
      });
  }
}

export const db = new StopMotionDb();
