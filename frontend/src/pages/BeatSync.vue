<script setup lang="ts">
/**
 * 动作节拍（多机位）：
 *  - 以主机位帧号为动作时间基准，挂接其他镜头后按各自帧率换算帧位，同一节拍最多 6 个机位
 *  - 主机位帧数一变：未拍镜头立即重算；已拍镜头保留原值，建议帧位待复核
 *  - 两台设备离线合并节拍/挂接：冲突两版并列，确认前不动当前帧序
 */
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useShotStore } from '../stores/shotStore';
import { useBeatStore, BeatConflictFrozenError, BeatLimitError } from '../stores/beatStore';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { beatAtSeconds, convertFramePos } from '../utils/beatMath';
import type { ConflictChoice } from '../utils/beatMerge';
import { MAX_CAMERAS_PER_BEAT, type ActionBeat, type BeatAttachment, type BeatConflict, type BeatMergeStats } from '../types/beat';
import type { Shot } from '../types/shot';
import EmptyState from '../components/common/EmptyState.vue';

const shotStore = useShotStore();
const beatStore = useBeatStore();
const { shots } = storeToRefs(shotStore);
const { beats, busy } = storeToRefs(beatStore);

const { draft: deviceDraft } = useLocalDraft('beat-device', { device: 'device-local' });

/* ---------------- 新建节拍 ---------------- */
const form = ref({ masterShotId: null as number | null, name: '', masterFrame: 1 });
const formError = ref('');

/* ---------------- 挂接 / 编辑 ---------------- */
const attachTarget = ref<Record<number, number | null>>({});
const attachFrame = ref<Record<number, number | null>>({});
const masterFrameInput = ref<Record<number, number>>({});

/* ---------------- 导入 ---------------- */
const importText = ref('');
const importStats = ref<BeatMergeStats | null>(null);
const importError = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

const feedback = ref('');
function flash(text: string) {
  feedback.value = text;
  window.setTimeout(() => {
    if (feedback.value === text) feedback.value = '';
  }, 4000);
}

onMounted(async () => {
  if (!shotStore.ready) await shotStore.load();
  if (!beatStore.ready) await beatStore.load();
});

function shotOf(id: number | null): Shot | undefined {
  return id === null ? undefined : shotStore.byId(id);
}
function shotCount(shot?: Shot): number {
  return shot ? Math.max(1, shot.endFrame - shot.startFrame + 1) : 1;
}

const conflictedBeats = computed(() => beats.value.filter((b) => b.conflicts.length > 0));

/** 一个节拍上还能挂哪些镜头（排除主机位与已挂机位） */
function attachableShots(beat: ActionBeat): Shot[] {
  const used = new Set<number>([beat.masterShotId, ...beat.attachments.map((a) => a.shotId ?? -1)]);
  return shots.value.filter((s) => typeof s.id === 'number' && !used.has(s.id));
}

function attachPreview(beat: ActionBeat): number {
  const targetId = attachTarget.value[beat.id as number] ?? null;
  const target = shotOf(targetId);
  if (!target) return convertFramePos(beat.masterFrame, beat.masterFps, beat.masterFps);
  return convertFramePos(beat.masterFrame, beat.masterFps, target.fps);
}

function cameraCount(beat: ActionBeat): number {
  return 1 + beat.attachments.length;
}

/* ---------------- 动作 ---------------- */

async function submitCreate() {
  formError.value = '';
  if (form.value.masterShotId === null) {
    formError.value = '请选择主机位镜头';
    return;
  }
  const master = shotOf(form.value.masterShotId);
  const frame = Math.min(Math.max(1, Math.floor(form.value.masterFrame) || 1), shotCount(master));
  try {
    const beat = await beatStore.create({
      name: form.value.name.trim(),
      masterShotId: form.value.masterShotId,
      masterFrame: frame,
    });
    form.value.name = '';
    form.value.masterFrame = 1;
    flash(`已建立节拍「${beat.name}」，可挂接最多 ${MAX_CAMERAS_PER_BEAT - 1} 个从机位`);
  } catch (e) {
    formError.value = e instanceof Error ? e.message : '建立节拍失败';
  }
}

async function submitAttach(beat: ActionBeat) {
  const id = beat.id as number;
  const shotId = attachTarget.value[id] ?? null;
  if (shotId === null) {
    flash('请先选择要挂接的镜头');
    return;
  }
  try {
    await beatStore.attach({
      beatId: id,
      shotId,
      framePos: attachFrame.value[id] ?? undefined,
    });
    attachTarget.value[id] = null;
    attachFrame.value[id] = null;
    flash('机位已挂接，帧位按该镜头帧率换算');
  } catch (e) {
    if (e instanceof BeatLimitError || e instanceof BeatConflictFrozenError) flash(e.message);
    else flash(e instanceof Error ? e.message : '挂接失败');
  }
}

async function detach(beat: ActionBeat, att: BeatAttachment) {
  await beatStore.detach(beat.id as number, att.uuid);
  flash(`已摘除机位 ${att.shotCode}`);
}

async function saveMasterFrame(beat: ActionBeat) {
  const val = masterFrameInput.value[beat.id as number];
  if (typeof val !== 'number') return;
  try {
    await beatStore.setMasterFrame(beat.id as number, val);
    flash('主机位帧号已更新，未拍机位已重算，已拍机位待复核');
  } catch (e) {
    flash(e instanceof BeatConflictFrozenError ? e.message : '更新主机位帧号失败');
  }
}

async function accept(beat: ActionBeat, att: BeatAttachment) {
  await beatStore.acceptSuggestion(beat.id as number, att.uuid);
}
async function reject(beat: ActionBeat, att: BeatAttachment) {
  await beatStore.rejectSuggestion(beat.id as number, att.uuid);
}

async function enableMulti(beat: ActionBeat) {
  await beatStore.enableMultiCamera(beat.id as number);
  flash('该节拍已纳入多机位联动');
}

async function removeBeat(beat: ActionBeat) {
  await beatStore.remove(beat.id as number);
  flash('节拍已删除');
}

/* ---------------- 冲突 ---------------- */

const CONFLICT_KIND_LABEL: Record<BeatConflict['kind'], string> = {
  'beat-field': '节拍字段',
  'attachment-frame': '挂接帧位',
  'attachment-add': '新增挂接',
  'attachment-remove': '解除挂接',
  'attachment-cap': '机位超限',
  'missing-shot': '镜头缺失',
};

function canAcceptIncoming(c: BeatConflict): boolean {
  return c.kind !== 'attachment-cap';
}

async function solve(beat: ActionBeat, c: BeatConflict, choice: ConflictChoice) {
  await beatStore.resolveConflict(beat.id as number, c.uuid, choice);
  flash(choice === 'incoming' ? '已采用并入版' : '已保留本机当前帧序');
}

/* ---------------- 导入 / 导出 ---------------- */

function onPickFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    importText.value = String(reader.result ?? '');
  };
  reader.readAsText(file);
}

async function doImport() {
  importError.value = '';
  importStats.value = null;
  if (!importText.value.trim()) {
    importError.value = '请粘贴节拍包 JSON 或选择离线文件';
    return;
  }
  try {
    const plan = await beatStore.previewImport(importText.value);
    await beatStore.applyImport(plan);
    importStats.value = plan.stats;
    importText.value = '';
    if (fileInput.value) fileInput.value.value = '';
    if (plan.stats.conflicts > 0) {
      flash(`并入 ${plan.stats.beatCount} 条节拍，发现 ${plan.stats.conflicts} 个冲突，已两版并列待确认（当前帧序未动）`);
    } else {
      flash(`并入完成：新增 ${plan.stats.added} 条、更新 ${plan.stats.updated} 条，无冲突`);
    }
  } catch (e) {
    importError.value = e instanceof Error ? e.message : '节拍包解析失败';
  }
}

async function doExport() {
  const device = deviceDraft.value.device || 'device-local';
  const json = await beatStore.exportPackage(device);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gbstopmotion-beats-${device}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  flash('已导出本机节拍包，可拷到另一台设备离线并入');
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>动作节拍 · 多机位协同</h1>
        <p class="sub">多机位共用动作节拍，各机位按各自帧率换算帧位；同一节拍最多挂 {{ MAX_CAMERAS_PER_BEAT }} 个机位</p>
      </div>
      <div class="head-actions">
        <span v-if="conflictedBeats.length" class="badge warn" data-testid="conflict-badge">
          {{ conflictedBeats.length }} 条节拍有 {{ beatStore.pendingConflictCount }} 个冲突待确认
        </span>
        <span v-if="busy" class="muted">重算中…</span>
      </div>
    </header>

    <p v-if="feedback" class="feedback" data-testid="beat-feedback">{{ feedback }}</p>

    <!-- 离线合并 -->
    <div class="panel">
      <div class="panel-head">
        <h2>两台设备离线合并</h2>
        <span class="muted">导出节拍包拷到另一台设备并入；冲突项两版并列，确认前不动当前帧序</span>
      </div>
      <div class="io-grid">
        <label class="field">
          <span>本机设备名</span>
          <input v-model="deviceDraft.device" type="text" maxlength="24" data-testid="beat-device" />
        </label>
        <div class="io-actions">
          <button type="button" class="btn primary" data-testid="beat-export" @click="doExport">导出本机节拍包</button>
        </div>
      </div>
      <div class="import-box">
        <textarea
          v-model="importText"
          rows="4"
          placeholder="粘贴另一台设备导出的节拍包 JSON，或点右侧选择文件"
          data-testid="beat-import-text"
        ></textarea>
        <div class="import-side">
          <input ref="fileInput" type="file" accept="application/json,.json" data-testid="beat-import-file" @change="onPickFile" />
          <button type="button" class="btn primary" data-testid="beat-import-apply" @click="doImport">离线并入</button>
        </div>
      </div>
      <p v-if="importError" class="err" data-testid="beat-import-error">{{ importError }}</p>
      <p v-if="importStats" class="muted" data-testid="beat-import-stats">
        上次并入：{{ importStats.beatCount }} 条节拍（新增 {{ importStats.added }} / 更新 {{ importStats.updated }}），冲突 {{ importStats.conflicts }} 个
      </p>
    </div>

    <!-- 冲突中心 -->
    <div v-if="conflictedBeats.length" class="panel conflict-panel" data-testid="conflict-center">
      <div class="panel-head"><h2>冲突确认中心</h2><span class="muted">确认前一律保持本机当前帧序</span></div>
      <div v-for="beat in conflictedBeats" :key="`cf-${beat.id}`" class="conflict-beat">
        <div class="conflict-beat-title">节拍「{{ beat.name || '未命名' }}」· 主机位 {{ beat.masterShotCode }}</div>
        <table class="table">
          <thead>
            <tr><th style="width:96px">类型</th><th>本机当前版</th><th>并入设备版</th><th style="width:230px">确认</th></tr>
          </thead>
          <tbody>
            <tr v-for="c in beat.conflicts" :key="c.uuid">
              <td><span class="tag">{{ CONFLICT_KIND_LABEL[c.kind] }}</span></td>
              <td class="local-cell">{{ c.localLabel }}</td>
              <td class="incoming-cell">{{ c.incomingLabel }}</td>
              <td class="row-actions">
                <button type="button" class="btn tiny" data-testid="conflict-local" @click="solve(beat, c, 'local')">保留本机</button>
                <button
                  type="button"
                  class="btn tiny primary"
                  :disabled="!canAcceptIncoming(c)"
                  :title="canAcceptIncoming(c) ? '' : '机位已满，不能并入该挂接'"
                  data-testid="conflict-incoming"
                  @click="solve(beat, c, 'incoming')"
                >
                  采用并入
                </button>
              </td>
            </tr>
            <tr v-for="c in beat.conflicts" :key="`${c.uuid}-note`">
              <td colspan="4" class="conflict-note">{{ c.note }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 新建节拍 -->
    <div class="panel">
      <div class="panel-head"><h2>新建动作节拍</h2><span class="muted">先定主机位与动作所在主机位帧号</span></div>
      <div class="create-grid">
        <label class="field">
          <span>主机位镜头</span>
          <select v-model.number="form.masterShotId" data-testid="beat-master-shot">
            <option :value="null" disabled>选择镜头</option>
            <option v-for="s in shots" :key="s.id" :value="s.id">{{ s.code }} · {{ s.sceneName }}（{{ s.fps }}fps）</option>
          </select>
        </label>
        <label class="field">
          <span>节拍名称</span>
          <input v-model="form.name" type="text" maxlength="24" placeholder="如：开门 / 抬手" data-testid="beat-name" />
        </label>
        <label class="field">
          <span>主机位帧号（共 {{ shotOf(form.masterShotId) ? shotCount(shotOf(form.masterShotId)) : '-' }} 帧）</span>
          <input v-model.number="form.masterFrame" type="number" min="1" data-testid="beat-master-frame" />
        </label>
        <div class="io-actions">
          <button type="button" class="btn primary" data-testid="beat-create" @click="submitCreate">建立节拍</button>
        </div>
      </div>
      <p v-if="formError" class="err">{{ formError }}</p>
    </div>

    <!-- 节拍列表 -->
    <EmptyState v-if="!beats.length" title="还没有动作节拍" description="选主机位建立第一个节拍，再把同场的其他机位镜头挂上来。" />

    <article v-for="beat in beats" :key="beat.id" class="panel beat-card" :class="{ frozen: beat.conflicts.length > 0, legacy: beat.legacy }" data-testid="beat-card">
      <div class="beat-head">
        <div class="beat-title">
          <h2>{{ beat.name || '未命名节拍' }}</h2>
          <div class="badges">
            <span class="tag role">主机位 {{ beat.masterShotCode }}</span>
            <span v-if="beat.legacy" class="tag legacy">单机位节拍（历史升级，不联动）</span>
            <span v-if="beat.source === 'imported'" class="tag imported">离线并入</span>
            <span v-if="beat.conflicts.length" class="tag warn">{{ beat.conflicts.length }} 个冲突待确认</span>
          </div>
        </div>
        <div class="head-actions">
          <button v-if="beat.legacy" type="button" class="btn small" data-testid="beat-enable" @click="enableMulti(beat)">纳入多机位联动</button>
          <button type="button" class="btn small danger" data-testid="beat-delete" @click="removeBeat(beat)">删除节拍</button>
        </div>
      </div>

      <table class="table camera-table">
        <thead>
          <tr>
            <th>角色</th><th>镜号</th><th>帧率</th><th>帧位</th><th>动作时间</th><th>状态 / 复核</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr class="master-row">
            <td><span class="tag role">主机位</span></td>
            <td class="mono">{{ beat.masterShotCode }}</td>
            <td>{{ beat.masterFps }} fps</td>
            <td>
              <div class="frame-edit">
                <input
                  :value="masterFrameInput[beat.id as number] ?? beat.masterFrame"
                  type="number"
                  min="1"
                  :max="shotCount(shotOf(beat.masterShotId))"
                  :disabled="beat.legacy || beat.conflicts.length > 0"
                  data-testid="beat-master-frame-input"
                  @input="masterFrameInput[beat.id as number] = Number(($event.target as HTMLInputElement).value)"
                />
                <button
                  type="button"
                  class="btn tiny"
                  :disabled="beat.legacy || beat.conflicts.length > 0"
                  data-testid="beat-master-frame-save"
                  @click="saveMasterFrame(beat)"
                >
                  挪动
                </button>
              </div>
              <small v-if="beat.previousMasterFrame !== null" class="muted">原第 {{ beat.previousMasterFrame }} 帧</small>
            </td>
            <td class="mono">{{ beatAtSeconds(beat.masterFrame, beat.masterFps) }} s</td>
            <td><span class="muted">动作时间基准</span></td>
            <td></td>
          </tr>
          <tr v-for="att in beat.attachments" :key="att.uuid" :class="{ review: att.reviewState === 'pending' }" data-testid="beat-attachment">
            <td><span class="tag">从机位</span></td>
            <td class="mono">{{ att.shotCode }}</td>
            <td>{{ att.fps }} fps</td>
            <td class="mono strong">第 {{ att.framePos }} 帧</td>
            <td class="mono">{{ beatAtSeconds(att.framePos, att.fps) }} s</td>
            <td>
              <div v-if="att.reviewState === 'pending'" class="review-box" data-testid="review-box">
                <span class="tag warn">已拍 · 待复核</span>
                <span class="muted">原值保留：第 {{ att.framePos }} 帧 → 建议第 {{ att.suggestedFramePos }} 帧</span>
                <div class="row-actions">
                  <button type="button" class="btn tiny primary" data-testid="review-accept" @click="accept(beat, att)">采纳新值</button>
                  <button type="button" class="btn tiny" data-testid="review-reject" @click="reject(beat, att)">保留原值</button>
                </div>
              </div>
              <span v-else class="ok">已同步</span>
            </td>
            <td>
              <button
                type="button"
                class="btn tiny danger"
                :disabled="beat.conflicts.length > 0"
                data-testid="beat-detach"
                @click="detach(beat, att)"
              >
                摘除
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="!beat.legacy" class="attach-bar">
        <span class="cap" :class="{ full: cameraCount(beat) >= MAX_CAMERAS_PER_BEAT }">机位 {{ cameraCount(beat) }}/{{ MAX_CAMERAS_PER_BEAT }}</span>
        <template v-if="cameraCount(beat) < MAX_CAMERAS_PER_BEAT && !beat.conflicts.length">
          <select v-model.number="attachTarget[beat.id as number]" data-testid="beat-attach-shot">
            <option :value="null" disabled>选择镜头挂接</option>
            <option v-for="s in attachableShots(beat)" :key="s.id" :value="s.id">{{ s.code }} · {{ s.sceneName }}（{{ s.fps }}fps）</option>
          </select>
          <label class="inline-field">
            帧位（留空按帧率换算 ≈ 第 {{ attachPreview(beat) }} 帧）
            <input v-model.number="attachFrame[beat.id as number]" type="number" min="1" placeholder="自动" data-testid="beat-attach-frame" />
          </label>
          <button type="button" class="btn small primary" data-testid="beat-attach-apply" @click="submitAttach(beat)">挂接该机位</button>
        </template>
        <span v-else-if="cameraCount(beat) >= MAX_CAMERAS_PER_BEAT" class="muted">已达机位上限</span>
        <span v-else class="muted">冲突确认后才能增删挂接</span>
      </div>
    </article>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
}
h1 {
  margin: 0;
  font-size: 22px;
}
h2 {
  margin: 0;
  font-size: 16px;
}
.sub {
  margin: 4px 0 0;
  color: #6b7686;
  font-size: 13px;
}
.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.panel {
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 16px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  gap: 10px;
  flex-wrap: wrap;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #5a6472;
}
.field input,
.field select,
.attach-bar select,
.attach-bar input {
  height: 32px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
  color: #1f2d3d;
}
.create-grid,
.io-grid {
  display: grid;
  grid-template-columns: 1.4fr 1.4fr 1fr auto;
  gap: 12px;
  align-items: end;
}
.io-grid {
  grid-template-columns: 1fr auto;
  margin-bottom: 12px;
}
.io-actions {
  display: flex;
  gap: 8px;
}
.import-box {
  display: grid;
  grid-template-columns: 1fr 200px;
  gap: 12px;
  align-items: stretch;
}
.import-box textarea {
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 8px;
  font-size: 12px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.import-side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  justify-content: center;
}
.import-side input[type='file'] {
  font-size: 12px;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table th,
.table td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid #eef1f6;
  vertical-align: middle;
}
.table th {
  color: #6b7686;
  font-weight: 600;
  font-size: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.strong {
  font-weight: 700;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.err {
  color: #c45656;
  font-size: 12px;
  margin: 8px 0 0;
}
.feedback {
  margin: 0;
  background: #eef6ff;
  border: 1px solid #d3e4ff;
  color: #24559c;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
}
.badge,
.tag {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  border: 1px solid transparent;
}
.badge.warn,
.tag.warn {
  background: #fff4e5;
  border-color: #ffd8a8;
  color: #b26a00;
}
.tag.role {
  background: #eef2ff;
  border-color: #d6ddff;
  color: #3b52c4;
}
.tag.legacy {
  background: #f1f3f6;
  border-color: #dde2ea;
  color: #6b7686;
}
.tag.imported {
  background: #e9f9f0;
  border-color: #bfe8cf;
  color: #1f8a4c;
}
.conflict-panel {
  border-color: #ffd8a8;
  background: #fffdf9;
}
.conflict-beat {
  border: 1px solid #f0e2cc;
  border-radius: 8px;
  padding: 10px;
  margin-bottom: 10px;
}
.conflict-beat-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 6px;
}
.local-cell {
  color: #3d4757;
}
.incoming-cell {
  color: #8a5a00;
}
.conflict-note {
  color: #8a94a6;
  font-size: 12px;
  padding-top: 2px;
  padding-bottom: 2px;
}
.beat-card.frozen {
  border-color: #ffd8a8;
}
.beat-card.legacy {
  background: #fafbfc;
}
.beat-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}
.beat-title {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.master-row {
  background: #f7f9ff;
}
.camera-table tr.review {
  background: #fff8ef;
}
.frame-edit {
  display: flex;
  gap: 6px;
  align-items: center;
}
.frame-edit input {
  width: 80px;
  height: 28px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
}
.review-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.ok {
  color: #1f8a4c;
  font-size: 12px;
}
.attach-bar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 12px;
  flex-wrap: wrap;
}
.cap {
  font-size: 12px;
  font-weight: 700;
  color: #3b52c4;
  background: #eef2ff;
  border: 1px solid #d6ddff;
  border-radius: 999px;
  padding: 2px 10px;
}
.cap.full {
  color: #b26a00;
  background: #fff4e5;
  border-color: #ffd8a8;
}
.inline-field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #5a6472;
}
.inline-field input {
  width: 90px;
}
.row-actions {
  display: flex;
  gap: 6px;
}
.btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 13px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
.btn.small {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
}
.btn.tiny {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
}
.btn.danger {
  color: #c45656;
  border-color: #f0c8c8;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
@media (max-width: 1100px) {
  .create-grid,
  .io-grid,
  .import-box {
    grid-template-columns: 1fr;
  }
}
</style>
