/**
 * IndexedDB 持久化层（Dexie 封装）。
 * 库名 gbstopmotion-db，含版本号与升级迁移：
 *   v1 建 shots / frames
 *   v2 增加 props 表与 shotId 索引
 *   v3 增加 takes 表，并按实拍张数回填进度
 *   v4 增加 beats（动作节拍）表；历史镜头自动各生成一条单机位节拍
 */
import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import type { ActionBeat } from '../types/beat';

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
  beats!: Table<ActionBeat, number>;

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
        beats: '++id, uuid, masterShotId, masterShotCode, legacy',
      })
      .upgrade(async (tx) => {
        // v4：历史数据没有多机位节拍，为每个镜头生成一条「单机位节拍」（legacy），
        // 节拍落在该镜头首帧，不挂从机位、不参与联动重算，可在节拍页继续管理。
        const shots = await tx.table('shots').toCollection().toArray();
        const now = Date.now();
        for (const shot of shots as Shot[]) {
          if (typeof shot.id !== 'number') continue;
          const beat: ActionBeat = {
            uuid: `legacy_shot_${shot.id}`,
            name: `${shot.code} 单机位节拍`,
            masterShotId: shot.id,
            masterShotCode: shot.code,
            masterFps: shot.fps,
            masterFrame: shot.startFrame,
            previousMasterFrame: null,
            attachments: [],
            legacy: true,
            source: 'local',
            conflicts: [],
            createdAt: shot.createdAt ?? now,
            updatedAt: now,
          };
          await tx.table('beats').add(beat);
        }
      });
  }
}

/** 供运行时降级复用：镜头对应的单机位节拍骨架（uuid 确定性，幂等） */
export function legacyBeatOf(shot: Shot): ActionBeat {
  const now = Date.now();
  return {
    uuid: `legacy_shot_${shot.id ?? 'new'}`,
    name: `${shot.code} 单机位节拍`,
    masterShotId: shot.id ?? 0,
    masterShotCode: shot.code,
    masterFps: shot.fps,
    masterFrame: shot.startFrame,
    previousMasterFrame: null,
    attachments: [],
    legacy: true,
    source: 'local',
    conflicts: [],
    createdAt: now,
    updatedAt: now,
  };
}

export const db = new StopMotionDb();
