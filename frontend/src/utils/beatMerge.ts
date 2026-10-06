/**
 * 离线合并：两台设备各自导出节拍包，并入时按稳定 uuid 匹配
 * （节拍 uuid / 挂接 uuid），镜号（shotCode）是跨设备镜头匹配键。
 * 冲突项两版并列挂到 beat.conflicts；确认前一律以本机版为准，不动当前帧序。
 */
import type { ActionBeat, BeatAttachment, BeatConflict, BeatMergeStats, BeatPackage } from '../types/beat';
import { beatUuid } from '../types/beat';

/** 本机镜头目录：镜号 → 镜头 id/帧率 */
export interface LocalShotCatalogEntry {
  id: number;
  code: string;
  fps: number;
}

export interface MergePlanItem {
  uuid: string;
  /** add=本机没有；update=本机已有；skip=包内同条重复 */
  action: 'add' | 'update' | 'skip';
  /** 本机当前版（update 时存在） */
  local: ActionBeat | null;
  /** 待落库版本：有冲突时与本机版同值（仅挂冲突项），无冲突时为合并结果 */
  merged: ActionBeat;
  conflicts: BeatConflict[];
}

export interface MergePlan {
  items: MergePlanItem[];
  stats: BeatMergeStats;
}

function nowTs(): number {
  return Date.now();
}

function conflict(partial: Omit<BeatConflict, 'uuid' | 'createdAt'>): BeatConflict {
  return { uuid: beatUuid('cf'), createdAt: nowTs(), ...partial };
}

/** 把并入节拍里的镜头 id 按镜号重映射到本机；找不到返回 null（缺镜头冲突） */
function remapShotId(code: string, catalog: Map<string, LocalShotCatalogEntry>): number | null {
  return catalog.get(code)?.id ?? null;
}

/** 生成本机版 / 并入版的帧位文案 */
function frameLabel(frame: number, fps: number): string {
  return `第 ${frame} 帧 @${fps}fps`;
}

/**
 * 计算并入一个节拍的计划。纯函数，不写库。
 */
export function planMergeBeat(
  incomingRaw: ActionBeat,
  local: ActionBeat | null,
  catalog: Map<string, LocalShotCatalogEntry>,
  maxCameras: number,
): MergePlanItem {
  const incoming: ActionBeat = JSON.parse(JSON.stringify(incomingRaw)) as ActionBeat;
  incoming.conflicts = [];

  // 并入版镜头 id 一律按镜号在本机重映射；找不到用 -1 占位，避免误用对端自增 id 误关联本机镜头
  incoming.masterShotId = remapShotId(incoming.masterShotCode, catalog) ?? -1;
  for (const att of incoming.attachments) {
    att.shotId = remapShotId(att.shotCode, catalog);
  }

  const conflicts: BeatConflict[] = [];

  /* ---- 新增：本机无此 uuid ---- */
  if (!local) {
    if (incoming.masterShotId === null || !catalog.has(incoming.masterShotCode)) {
      conflicts.push(
        conflict({
          kind: 'missing-shot',
          shotCode: incoming.masterShotCode,
          localLabel: '本机没有该主机位镜头',
          incomingLabel: `并入节拍「${incoming.name || '未命名'}」主机位 ${incoming.masterShotCode} @${incoming.masterFps}fps`,
          incoming: null,
          note: '主机位镜头尚未同步到本机，节拍可先并入，镜号到位后补挂；也可放弃整条并入节拍。',
        }),
      );
    }
    for (const att of incoming.attachments) {
      if (att.shotId === null || !catalog.has(att.shotCode)) {
        conflicts.push(
          conflict({
            kind: 'missing-shot',
            shotCode: att.shotCode,
            attachmentUuid: att.uuid,
            localLabel: '本机没有该镜头',
            incomingLabel: `挂接机位 ${att.shotCode}（${frameLabel(att.framePos, att.fps)}）`,
            incoming: JSON.parse(JSON.stringify(att)) as BeatAttachment,
            note: '该挂接镜头本机尚无记录，可保留挂接关系待镜头到位，或放弃此挂接。',
          }),
        );
      }
    }
    incoming.source = 'imported';
    incoming.conflicts = conflicts;
    return { uuid: incoming.uuid, action: 'add', local: null, merged: incoming, conflicts };
  }

  /* ---- 更新：本机已有，逐字段比对 ---- */
  const merged: ActionBeat = JSON.parse(JSON.stringify(local)) as ActionBeat;
  merged.conflicts = [];

  if (local.name !== incoming.name) {
    conflicts.push(
      conflict({
        kind: 'beat-field',
        field: 'name',
        localLabel: `节拍名「${local.name || '未命名'}」`,
        incomingLabel: `节拍名「${incoming.name || '未命名'}」`,
        incoming: incoming.name,
        note: '两台设备对节拍命名不一致，二选一确认。',
      }),
    );
  }

  if (local.masterFrame !== incoming.masterFrame || local.masterFps !== incoming.masterFps) {
    conflicts.push(
      conflict({
        kind: 'beat-field',
        field: 'masterFrame',
        shotCode: local.masterShotCode,
        localLabel: `主机位帧号 ${frameLabel(local.masterFrame, local.masterFps)}`,
        incomingLabel: `主机位帧号 ${frameLabel(incoming.masterFrame, incoming.masterFps)}`,
        incoming: { frame: incoming.masterFrame, fps: incoming.masterFps },
        note: '主机位帧号两机不一致，确认并入将按并入值重算全部挂接帧位。',
      }),
    );
  }

  const localAtts = new Map(local.attachments.map((a) => [a.uuid, a]));
  const incomingAtts = new Map(incoming.attachments.map((a) => [a.uuid, a]));
  const cameraCount = 1 + local.attachments.length;

  let pendingAddSlots = Math.max(0, maxCameras - cameraCount);

  for (const att of incoming.attachments) {
    const own = localAtts.get(att.uuid);
    if (!own) {
      // 本机没有的挂接：新增挂接冲突；机位已满则为超限冲突
      const cap = pendingAddSlots <= 0;
      conflicts.push(
        conflict({
          kind: cap ? 'attachment-cap' : 'attachment-add',
          shotCode: att.shotCode,
          attachmentUuid: att.uuid,
          localLabel: cap ? `本机已挂满 ${maxCameras} 个机位` : '本机没有该挂接',
          incomingLabel: `挂接机位 ${att.shotCode}（${frameLabel(att.framePos, att.fps)}）`,
          incoming: JSON.parse(JSON.stringify(att)) as BeatAttachment,
          note: cap
            ? `同一节拍最多挂 ${maxCameras} 个机位，无法直接并入；确认保留本机版即放弃该挂接。`
            : '并入将新增一个挂接机位，帧位按其帧率换算。',
        }),
      );
      if (!cap) pendingAddSlots -= 1;
      if (att.shotId === null || !catalog.has(att.shotCode)) {
        conflicts.push(
          conflict({
            kind: 'missing-shot',
            shotCode: att.shotCode,
            attachmentUuid: att.uuid,
            localLabel: '本机没有该镜头',
            incomingLabel: `挂接机位 ${att.shotCode}（${frameLabel(att.framePos, att.fps)}）`,
            incoming: JSON.parse(JSON.stringify(att)) as BeatAttachment,
            note: '该挂接镜头本机尚无记录，可保留挂接关系待镜头到位，或放弃此挂接。',
          }),
        );
      }
      continue;
    }
    if (own.framePos !== att.framePos || own.fps !== att.fps) {
      conflicts.push(
        conflict({
          kind: 'attachment-frame',
          shotCode: att.shotCode,
          attachmentUuid: att.uuid,
          localLabel: `机位 ${att.shotCode}：${frameLabel(own.framePos, own.fps)}`,
          incomingLabel: `机位 ${att.shotCode}：${frameLabel(att.framePos, att.fps)}`,
          incoming: { framePos: att.framePos, fps: att.fps },
          note: '同一挂接两机帧位不一致，二选一确认；确认前本镜头维持当前帧位。',
        }),
      );
    }
  }

  // 本机有、并入版没有：可能是对端解挂，挂接关系冲突两版并列
  for (const att of local.attachments) {
    if (!incomingAtts.has(att.uuid)) {
      conflicts.push(
        conflict({
          kind: 'attachment-remove',
          shotCode: att.shotCode,
          attachmentUuid: att.uuid,
          localLabel: `保留挂接 ${att.shotCode}（${frameLabel(att.framePos, att.fps)}）`,
          incomingLabel: '对端已解除该挂接',
          incoming: att.uuid,
          note: '并入设备上不存在该挂接关系，确认保留或解除。',
        }),
      );
    }
  }

  if (incoming.masterShotId === null || !catalog.has(incoming.masterShotCode)) {
    conflicts.push(
      conflict({
        kind: 'missing-shot',
        shotCode: incoming.masterShotCode,
        localLabel: `本机主机位镜头 ${local.masterShotCode} 存在`,
        incomingLabel: `并入版主机位 ${incoming.masterShotCode} 在本机查无此镜号`,
        incoming: null,
        note: '镜号对不上，维持本机主机位；请核对后手动处理。',
      }),
    );
  }

  // 无冲突：直接合并（并入版带来的新挂接/同名同帧挂接），不触碰主机位帧号
  if (conflicts.length === 0) {
    const byUuid = new Map<string, BeatAttachment>();
    for (const att of [...local.attachments, ...incoming.attachments]) {
      const prev = byUuid.get(att.uuid);
      byUuid.set(att.uuid, { ...(prev ?? att), ...att, shotId: remapShotId(att.shotCode, catalog) ?? att.shotId });
    }
    merged.attachments = [...byUuid.values()];
    merged.source = 'imported';
    merged.updatedAt = nowTs();
    return { uuid: local.uuid, action: 'update', local, merged, conflicts };
  }

  // 有冲突：merged 维持本机原值，仅挂冲突列表
  merged.source = local.source;
  merged.conflicts = conflicts;
  return { uuid: local.uuid, action: 'update', local, merged, conflicts };
}

/** 校验离线节拍包 */
export function parseBeatPackage(text: string): BeatPackage {
  const data = JSON.parse(text) as BeatPackage;
  if (!data || data.format !== 'gbstopmotion-beats' || data.version !== 1 || !Array.isArray(data.beats)) {
    throw new Error('节拍包格式不识别（应为 gbstopmotion-beats v1）');
  }
  return data;
}

/** 对整包生成合并计划（包内同 uuid 重复只取首条，其余 skip） */
export function planMerge(
  incomingBeats: ActionBeat[],
  localBeats: ActionBeat[],
  shots: LocalShotCatalogEntry[],
  maxCameras: number,
): MergePlan {
  const catalog = new Map(shots.map((s) => [s.code, s]));
  const localByUuid = new Map(localBeats.map((b) => [b.uuid, b]));
  const seen = new Set<string>();
  const items: MergePlanItem[] = [];
  let added = 0;
  let updated = 0;
  let conflictCount = 0;

  for (const raw of incomingBeats) {
    if (!raw || !raw.uuid) continue;
    if (seen.has(raw.uuid)) {
      items.push({ uuid: raw.uuid, action: 'skip', local: localByUuid.get(raw.uuid) ?? null, merged: raw, conflicts: [] });
      continue;
    }
    seen.add(raw.uuid);
    const item = planMergeBeat(raw, localByUuid.get(raw.uuid) ?? null, catalog, maxCameras);
    items.push(item);
    if (item.action === 'add') added += 1;
    if (item.action === 'update' && item.conflicts.length === 0) updated += 1;
    conflictCount += item.conflicts.length;
  }

  const stats: BeatMergeStats = { added, updated, conflicts: conflictCount, beatCount: items.filter((i) => i.action !== 'skip').length };
  return { items, stats };
}

export type ConflictChoice = 'local' | 'incoming';

/**
 * 解决一条冲突，返回应用后的节拍拷贝（纯函数）。
 * local=维持本机当前帧序；incoming=采用并入版。冲突列表移除该项。
 */
export function resolveConflict(beat: ActionBeat, conflictUuid: string, choice: ConflictChoice): ActionBeat {
  const target = beat.conflicts.find((c) => c.uuid === conflictUuid);
  if (!target) return beat;
  const next: ActionBeat = JSON.parse(JSON.stringify(beat)) as ActionBeat;
  next.conflicts = next.conflicts.filter((c) => c.uuid !== conflictUuid);

  if (choice === 'incoming') {
    switch (target.kind) {
      case 'beat-field':
        if (target.field === 'name') {
          next.name = typeof target.incoming === 'string' ? target.incoming : '';
        } else if (target.field === 'masterFrame') {
          const value = target.incoming as { frame: number; fps: number } | null;
          if (value) {
            next.previousMasterFrame = next.masterFrame;
            next.masterFrame = value.frame;
            next.masterFps = value.fps;
            // 主机位帧位变化：从机位帧位需按新基准重算，交给 store 统一处理，这里先标记
            next.attachments = next.attachments.map((a) => ({
              ...a,
              fps: a.fps,
            }));
          }
        }
        break;
      case 'attachment-frame': {
        const value = target.incoming as { framePos: number; fps: number } | null;
        const att = next.attachments.find((a) => a.uuid === target.attachmentUuid);
        if (att && value) {
          att.framePos = value.framePos;
          att.fps = value.fps;
          att.previousFramePos = null;
          att.suggestedFramePos = null;
          att.reviewState = 'none';
        }
        break;
      }
      case 'attachment-add':
      case 'missing-shot': {
        const att = target.incoming as BeatAttachment | null;
        if (att && !next.attachments.some((a) => a.uuid === att.uuid)) {
          next.attachments.push({ ...att, reviewState: 'none', previousFramePos: null, suggestedFramePos: null });
        }
        break;
      }
      case 'attachment-remove':
        next.attachments = next.attachments.filter((a) => a.uuid !== target.attachmentUuid);
        break;
      case 'attachment-cap':
      default:
        break;
    }
  }
  // choice === 'local'：仅移除冲突，当前帧序不动
  return next;
}

/** 全部冲突是否已清空（清空后节拍恢复正常重算） */
export function hasPendingConflict(beat: ActionBeat): boolean {
  return beat.conflicts.length > 0;
}
