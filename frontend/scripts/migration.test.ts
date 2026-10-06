/* eslint-disable no-console */
/**
 * 验证真实的 Dexie v3（旧库）→ v4 升级：
 * 升级前存在的历史镜头，升级后每个镜头得到一条 legacy 单机位节拍。
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import Dexie from 'dexie';

const DB_NAME = 'gbstopmotion-db';

function openV3(): Dexie {
  const d = new Dexie(DB_NAME);
  d.version(1).stores({
    shots: '++id, code, status, sceneName',
    frames: '++id, shotId, frameNo, [shotId+frameNo]',
  });
  d.version(2)
    .stores({
      shots: '++id, code, status, sceneName',
      frames: '++id, shotId, frameNo, [shotId+frameNo]',
      props: '++id, shotId, name, [shotId+fromFrame]',
    })
    .upgrade(async () => {});
  d.version(3)
    .stores({
      shots: '++id, code, status, sceneName',
      frames: '++id, shotId, frameNo, [shotId+frameNo]',
      props: '++id, shotId, name, [shotId+fromFrame]',
      takes: '++id, shotId, date, shotCode',
    })
    .upgrade(async () => {});
  return d;
}

const oldDb = openV3();
await oldDb.open();
await oldDb.table('shots').bulkAdd([
  { code: 'S01', sceneName: 'a', fps: 24, durationSec: 2, startFrame: 1, endFrame: 48, status: '未开机', owner: '', progressPercent: 0, createdAt: 100, updatedAt: 100 },
  { code: 'S02', sceneName: 'b', fps: 12, durationSec: 1, startFrame: 5, endFrame: 16, status: '拍摄中', owner: 'x', progressPercent: 10, createdAt: 200, updatedAt: 200 },
]);
await oldDb.close();

// 用真实应用 schema 重新打开，触发 v4 升级
const { db } = await import('../src/db/index');
await db.open();
assert.equal(db.verno, 4, '升级到 v4');

const beats = await db.table('beats').toArray();
assert.equal(beats.length, 2, '两个历史镜头各生成一条节拍');

const b1 = beats.find((b: { masterShotCode: string }) => b.masterShotCode === 'S01');
const b2 = beats.find((b: { masterShotCode: string }) => b.masterShotCode === 'S02');
assert.ok(b1 && b2, '两条节拍都存在');
assert.equal(b1.legacy, true, '历史节拍为单机位 legacy');
assert.equal(b2.legacy, true);
assert.equal(b1.uuid, 'legacy_shot_1', 'legacy uuid 确定性');
assert.equal(b2.masterFrame, 5, '节拍帧位取镜头起始帧');
assert.equal(b1.masterFps, 24);
assert.equal(b2.masterFps, 12);
assert.deepEqual(b1.attachments, [], 'legacy 无挂接');

// 幂等：再打开一次不重复生成
await db.close();
await db.open();
const again = await db.table('beats').toArray();
assert.equal(again.length, 2, '重复打开不重复生成');

console.log('✓ v3→v4 历史数据升级为单机位节拍，且幂等');
