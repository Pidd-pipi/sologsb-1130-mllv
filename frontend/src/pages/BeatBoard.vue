<script setup lang="ts">
/**
 * 多机位动作节拍台：
 * - 新建动作节拍并在主机位时间线上增删动作锚点；
 * - 其他机位挂接后按各自帧率换算帧位（同一节拍最多 6 机位）；
 * - 主机位帧数一变：未拍机位立即重算，已拍机位保留原值待复核；
 * - 离线导出/导入同步包，冲突两版并列，确认前不动当前帧序。
 */
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useBeatStore, deviceId } from '../stores/beatStore';
import { useShotStore } from '../stores/shotStore';
import { convertFramePosition } from '../utils/beatMath';
import { MAX_CAMERAS_PER_BEAT, type Beat, type BeatConflict, type BeatLink } from '../types/beat';
import EmptyState from '../components/common/EmptyState.vue';

const beatStore = useBeatStore();
const shotStore = useShotStore();
const { beats, conflicts } = storeToRefs(beatStore);
const { shots } = storeToRefs(shotStore);

const selectedId = ref<number | null>(null);
const feedback = ref('');
const importing = ref(false);
const importText = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

const createForm = ref({ code: '', name: '', masterShotId: 0, masterFrame: 1, label: '' });
const anchorForm = ref({ masterFrame: 1, label: '', note: '' });
const attachShotId = ref<number>(0);

onMounted(async () => {
  await Promise.all([shotStore.load(), beatStore.load()]);
  if (beats.value.length) selectedId.value = beats.value[0].id ?? null;
});

const selectedBeat = computed<Beat | undefined>(() =>
  selectedId.value === null ? undefined : beats.value.find((b) => b.id === selectedId.value),
);

const masterShot = computed(() =>
  selectedBeat.value ? shotStore.byId(selectedBeat.value.masterShotId) : undefined,
);

/** 可挂接的镜头：排除主机位与已挂接镜头；机位上限 6 */
const attachableShots = computed(() => {
  const beat = selectedBeat.value;
  if (!beat) return [];
  const used = new Set<number>([beat.masterShotId, ...beat.links.map((l) => l.shotId)]);
  return shots.value.filter((s) => typeof s.id === 'number' && !used.has(s.id));
});

const cameraCount = computed(() => (selectedBeat.value ? selectedBeat.value.links.length + 1 : 1));
const atCapacity = computed(() => cameraCount.value >= MAX_CAMERAS_PER_BEAT);

function flash(text: string) {
  feedback.value = text;
  window.setTimeout(() => {
    if (feedback.value === text) feedback.value = '';
  }, 3600);
}

function selectBeat(id: number) {
  selectedId.value = id;
}

async function createBeat() {
  try {
    const master = shots.value.find((s) => s.id === Number(createForm.value.masterShotId));
    if (!master) {
      flash('请先选择主机位镜头');
      return;
    }
    const anchors = createForm.value.label.trim()
      ? [{ masterFrame: Math.max(1, Math.floor(createForm.value.masterFrame)), label: createForm.value.label.trim() }]
      : [];
    const saved = await beatStore.create({
      code: createForm.value.code.trim() || `B-${master.code}-${Date.now().toString(36)}`,
      name: createForm.value.name.trim(),
      master,
      anchors,
    });
    selectedId.value = saved.id ?? null;
    createForm.value = { code: '', name: '', masterShotId: 0, masterFrame: 1, label: '' };
    flash('动作节拍已建立，其他机位可在右侧挂接');
  } catch (e) {
    flash((e as Error).message);
  }
}

async function addAnchor() {
  if (!selectedBeat.value) return;
  if (!anchorForm.value.label.trim()) {
    flash('请填写动作名');
    return;
  }
  try {
    await beatStore.addAnchor(selectedBeat.value.id as number, {
      masterFrame: Math.max(1, Math.floor(anchorForm.value.masterFrame)),
      label: anchorForm.value.label.trim(),
      note: anchorForm.value.note.trim() || undefined,
    });
    anchorForm.value = { masterFrame: 1, label: '', note: '' };
    flash('锚点已加入，各机位帧位已按帧率换算');
  } catch (e) {
    flash((e as Error).message);
  }
}

async function removeAnchor(key: string) {
  if (!selectedBeat.value) return;
  await beatStore.removeAnchor(selectedBeat.value.id as number, key);
  flash('锚点已删除，帧位已重算');
}

async function attach() {
  if (!selectedBeat.value) return;
  const shot = shots.value.find((s) => s.id === Number(attachShotId.value));
  if (!shot) {
    flash('请选择要挂接的机位镜头');
    return;
  }
  try {
    await beatStore.attach(selectedBeat.value.id as number, shot);
    attachShotId.value = 0;
    flash(`机位 ${shot.code} 已挂接，帧位按 ${shot.fps} fps 换算`);
  } catch (e) {
    flash((e as Error).message);
  }
}

async function detach(shotId: number) {
  if (!selectedBeat.value) return;
  await beatStore.detach(selectedBeat.value.id as number, shotId);
  flash('已摘除该挂接机位');
}

async function toggleShot(link: BeatLink) {
  if (!selectedBeat.value) return;
  const next = link.status === 'shot' ? 'unshot' : 'shot';
  await beatStore.setLinkStatus(selectedBeat.value.id as number, link.shotId, next);
  flash(next === 'shot' ? '已标记为已拍：主机位再变帧数将保留当前帧位待复核' : '已标记为未拍：主机位变化将自动重算');
}

async function accept(link: BeatLink) {
  if (!selectedBeat.value) return;
  await beatStore.acceptReview(selectedBeat.value.id as number, link.shotId);
  flash(`机位 ${link.shotCode} 已采用重算帧位`);
}

async function keep(link: BeatLink) {
  if (!selectedBeat.value) return;
  await beatStore.keepCurrent(selectedBeat.value.id as number, link.shotId);
  flash(`机位 ${link.shotCode} 保留原帧位`);
}

async function removeBeat() {
  if (!selectedBeat.value?.id) return;
  await beatStore.remove(selectedBeat.value.id);
  selectedId.value = beats.value[0]?.id ?? null;
  flash('节拍已删除');
}

/** 帧位换算预览（挂接前给摄影助理看的对照表） */
function previewFrames(shotId: number): number[] {
  const beat = selectedBeat.value;
  const master = masterShot.value;
  const shot = shotStore.byId(shotId);
  if (!beat || !master || !shot) return [];
  return beat.anchors.map((a) =>
    convertFramePosition(a.masterFrame, master.startFrame, master.fps, shot.startFrame, shot.fps),
  );
}

/* ---------------- 离线合并 ---------------- */

function exportJson() {
  const blob = new Blob([beatStore.exportBundle()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `beat-sync-${deviceId().slice(-4)}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  flash('已导出本机节拍同步包，可拷给另一台设备导入');
}

function triggerImport() {
  fileInput.value?.click();
}

function onFilePicked(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    importText.value = String(reader.result ?? '');
    importing.value = true;
  };
  reader.readAsText(file);
  (event.target as HTMLInputElement).value = '';
}

async function doImport() {
  try {
    const report = await beatStore.importBundle(importText.value, shots.value);
    const parts = [`新增 ${report.added} 个节拍`];
    if (report.conflicted.length) parts.push(`${report.conflicted.length} 个节拍冲突，已两版并列待裁定`);
    flash(parts.join('，'));
    importing.value = false;
    importText.value = '';
  } catch (e) {
    flash((e as Error).message);
  }
}

async function resolve(id: number | undefined, choice: 'local' | 'incoming') {
  if (typeof id !== 'number') return;
  await beatStore.resolveConflict(id, choice);
  flash(choice === 'incoming' ? '已采用离线版帧序' : '已保留本机版帧序');
}

async function dismiss(id: number | undefined) {
  if (typeof id !== 'number') return;
  await beatStore.dismissConflict(id);
}

/** 冲突明细中某挂接机位的双版本行 */
function linkPairs(conflict: BeatConflict) {
  return conflict.linkConflicts.map((lc) => {
    const findLink = (beat: Beat) => beat.links.find((l) => l.shotId === lc.shotId || l.shotCode === lc.shotCode);
    return { lc, local: findLink(conflict.local), incoming: findLink(conflict.incoming) };
  });
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>多机位动作节拍</h1>
        <p class="sub">主机位动作节拍共享，其他机位挂接后按各自帧率换算帧位；主机位帧数一变，未拍立即重算，已拍保留待复核</p>
      </div>
      <div class="head-actions">
        <button type="button" class="btn" data-testid="beat-export" @click="exportJson">导出同步包</button>
        <button type="button" class="btn" data-testid="beat-import-open" @click="triggerImport">导入同步包</button>
        <input ref="fileInput" type="file" accept="application/json,.json" hidden data-testid="beat-import-file" @change="onFilePicked" />
      </div>
    </header>

    <p v-if="feedback" class="feedback" data-testid="beat-feedback">{{ feedback }}</p>

    <!-- 冲突两版并列：确认前当前帧序不动 -->
    <div v-if="conflicts.length" class="panel conflict-panel" data-testid="conflict-panel">
      <div class="panel-head">
        <h2>离线合并冲突（{{ conflicts.length }}）</h2>
        <span class="muted">两版并列，裁定前当前帧序保持本机版不变</span>
      </div>
      <div v-for="c in conflicts" :key="c.id" class="conflict" data-testid="conflict-item">
        <div class="conflict-title">
          <strong class="mono">{{ c.beatCode }}</strong>
          <span>{{ c.beatName }}</span>
          <span class="chip">本机版 修订{{ c.local.revision }}</span>
          <span class="chip alt">{{ c.incomingDeviceName || c.incomingDeviceId }} · 修订{{ c.incoming.revision }}</span>
        </div>
        <table v-if="linkPairs(c).length" class="table">
          <thead>
            <tr><th>机位</th><th>本机帧位（当前帧序）</th><th>离线帧位</th><th>本机状态</th><th>离线状态</th></tr>
          </thead>
          <tbody>
            <tr v-for="pair in linkPairs(c)" :key="pair.lc.shotId">
              <td class="mono">{{ pair.lc.shotCode }}</td>
              <td>{{ pair.local?.frames.join(' / ') ?? '—' }}</td>
              <td>{{ pair.incoming?.frames.join(' / ') ?? '—' }}</td>
              <td>{{ pair.local?.status === 'shot' ? '已拍' : '未拍' }} · {{ pair.local?.fps }}fps</td>
              <td>{{ pair.incoming?.status === 'shot' ? '已拍' : '未拍' }} · {{ pair.incoming?.fps }}fps</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">节拍本体（动作锚点 / 主机位帧数）存在差异，请在两版整体之间裁定。</p>
        <div class="conflict-actions">
          <button type="button" class="btn small" data-testid="conflict-keep-local" @click="resolve(c.id, 'local')">保留本机版</button>
          <button type="button" class="btn small primary" data-testid="conflict-take-incoming" @click="resolve(c.id, 'incoming')">采用离线版</button>
          <button type="button" class="btn small" @click="dismiss(c.id)">稍后处理</button>
        </div>
      </div>
    </div>

    <!-- 导入确认条 -->
    <div v-if="importing" class="panel import-panel" data-testid="import-panel">
      <div class="panel-head">
        <h2>离线节拍包预览</h2>
        <span class="muted">冲突项不会覆盖当前帧序，只做并列登记</span>
      </div>
      <textarea v-model="importText" class="json-box" rows="8" data-testid="import-text" />
      <div class="conflict-actions">
        <button type="button" class="btn primary" data-testid="import-confirm" @click="doImport">确认合并</button>
        <button type="button" class="btn" @click="importing = false">取消</button>
      </div>
    </div>

    <div class="board">
      <!-- 左列：节拍列表 + 新建 -->
      <div class="panel">
        <div class="panel-head"><h2>节拍列表</h2><span class="muted">{{ beats.length }} 个</span></div>
        <div class="beat-list">
          <button
            v-for="b in beats"
            :key="b.id"
            type="button"
            class="beat-item"
            :class="{ active: b.id === selectedId }"
            @click="selectBeat(b.id as number)"
          >
            <span class="mono">{{ b.code }}</span>
            <span class="beat-name">{{ b.name }}</span>
            <span class="beat-meta">{{ b.links.length + 1 }} 机位</span>
            <span v-if="b.links.some((l) => l.needsReview)" class="badge" data-testid="review-badge">
              待复核 {{ b.links.filter((l) => l.needsReview).length }}
            </span>
          </button>
          <EmptyState v-if="!beats.length" title="还没有动作节拍" description="选一个主机位镜头建立节拍，其他机位再挂接。" />
        </div>

        <div class="create-box" data-testid="beat-create">
          <h3>新建动作节拍</h3>
          <label class="field"><span>节拍编号</span><input v-model="createForm.code" type="text" placeholder="留空自动生成" /></label>
          <label class="field"><span>节拍名</span><input v-model="createForm.name" type="text" placeholder="如：开场回头" /></label>
          <label class="field">
            <span>主机位镜头</span>
            <select v-model="createForm.masterShotId" data-testid="beat-master">
              <option :value="0" disabled>选择镜头</option>
              <option v-for="s in shots" :key="s.id" :value="s.id">{{ s.code }} · {{ s.sceneName }}（{{ s.fps }}fps）</option>
            </select>
          </label>
          <div class="two-mini">
            <label class="field"><span>首个动作帧</span><input v-model.number="createForm.masterFrame" type="number" min="1" /></label>
            <label class="field"><span>首个动作名</span><input v-model="createForm.label" type="text" placeholder="可留空" /></label>
          </div>
          <button type="button" class="btn primary" data-testid="beat-create-btn" @click="createBeat">建立节拍</button>
        </div>
      </div>

      <!-- 右列：节拍详情 -->
      <div v-if="selectedBeat && masterShot" class="panel detail">
        <div class="panel-head">
          <div>
            <h2><span class="mono">{{ selectedBeat.code }}</span> {{ selectedBeat.name }}</h2>
            <span class="muted">
              主机位 {{ masterShot.code }} · {{ masterShot.fps }} fps · 帧 {{ masterShot.startFrame }}–{{ masterShot.endFrame }}
              · 节拍帧数快照 {{ selectedBeat.masterFrameCount }}
            </span>
          </div>
          <button type="button" class="btn tiny danger" data-testid="beat-delete" @click="removeBeat">删除节拍</button>
        </div>

        <!-- 锚点 -->
        <div class="section">
          <h3>动作锚点（主机位帧位）</h3>
          <table v-if="selectedBeat.anchors.length" class="table" data-testid="anchor-table">
            <thead><tr><th>动作</th><th>主机位帧</th><th>备注</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="a in selectedBeat.anchors" :key="a.key">
                <td>{{ a.label }}</td>
                <td class="mono">{{ a.masterFrame }}</td>
                <td class="muted">{{ a.note || '—' }}</td>
                <td><button type="button" class="btn tiny danger" @click="removeAnchor(a.key)">删除</button></td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">还没有动作锚点，先在主机位时间线上加一个动作节点。</p>
          <div class="anchor-form">
            <label class="field"><span>主机位帧位</span><input v-model.number="anchorForm.masterFrame" type="number" min="1" data-testid="anchor-frame" /></label>
            <label class="field grow"><span>动作名</span><input v-model="anchorForm.label" type="text" maxlength="20" data-testid="anchor-label" /></label>
            <label class="field grow"><span>备注</span><input v-model="anchorForm.note" type="text" maxlength="40" /></label>
            <button type="button" class="btn primary" data-testid="anchor-add" @click="addAnchor">加锚点并重算</button>
          </div>
        </div>

        <!-- 挂接机位 -->
        <div class="section">
          <div class="section-head">
            <h3>挂接机位（{{ cameraCount }}/{{ MAX_CAMERAS_PER_BEAT }}）</h3>
            <span class="muted">按各机位帧率换算同一动作时刻的帧位</span>
          </div>
          <table class="table" data-testid="link-table">
            <thead>
              <tr><th>机位</th><th>帧率</th><th>状态</th><th>各动作帧位</th><th>重算建议</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr class="master-row">
                <td class="mono">{{ masterShot.code }}（主机位）</td>
                <td>{{ masterShot.fps }}</td>
                <td><span class="chip">基准</span></td>
                <td class="mono">{{ selectedBeat.anchors.map((a) => a.masterFrame).join(' / ') || '—' }}</td>
                <td class="muted">—</td>
                <td>—</td>
              </tr>
              <tr v-for="link in selectedBeat.links" :key="link.shotId" :class="{ review: link.needsReview }">
                <td class="mono">{{ link.shotCode }}</td>
                <td>{{ link.fps }}</td>
                <td>
                  <button type="button" class="btn tiny" :class="{ primary: link.status === 'shot' }" @click="toggleShot(link)">
                    {{ link.status === 'shot' ? '已拍' : '未拍' }}
                  </button>
                </td>
                <td class="mono" data-testid="link-frames">{{ link.frames.join(' / ') || '—' }}</td>
                <td>
                  <span v-if="link.needsReview" class="warn" data-testid="link-review">
                    建议：{{ link.reviewFrames.join(' / ') }}
                  </span>
                  <span v-else class="muted">已同步</span>
                </td>
                <td class="row-actions">
                  <template v-if="link.needsReview">
                    <button type="button" class="btn tiny primary" @click="accept(link)">采用重算</button>
                    <button type="button" class="btn tiny" @click="keep(link)">保留原值</button>
                  </template>
                  <button type="button" class="btn tiny danger" @click="detach(link.shotId)">摘除</button>
                </td>
              </tr>
            </tbody>
          </table>

          <div v-if="!atCapacity" class="attach-form">
            <label class="field grow">
              <span>挂接其他机位镜头</span>
              <select v-model="attachShotId" data-testid="attach-select">
                <option :value="0" disabled>选择镜头</option>
                <option v-for="s in attachableShots" :key="s.id" :value="s.id">
                  {{ s.code }} · {{ s.sceneName }}（{{ s.fps }}fps，{{ s.status }}）
                </option>
              </select>
            </label>
            <span v-if="attachShotId" class="preview mono">
              换算预览：{{ previewFrames(Number(attachShotId)).join(' / ') || '暂无锚点' }}
            </span>
            <button type="button" class="btn primary" data-testid="attach-btn" @click="attach">挂接</button>
          </div>
          <p v-else class="warn">该节拍已达 {{ MAX_CAMERAS_PER_BEAT }} 机位上限，不能再挂接。</p>
        </div>
      </div>

      <div v-else class="panel detail empty-detail">
        <EmptyState
          title="选择或新建一个节拍"
          description="节拍以主机位动作时间线为基准，其他机位挂接后各自按帧率换算帧位。"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; }
.page-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; }
h1 { margin: 0; font-size: 22px; }
.sub { margin: 4px 0 0; color: #6b7686; font-size: 13px; }
.head-actions { display: flex; gap: 8px; }
.panel { background: #fff; border: 1px solid #e2e7ef; border-radius: 10px; padding: 16px; }
.panel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 8px; }
.panel-head h2 { margin: 0; font-size: 16px; }
.panel-head h2 .mono { color: #2f6fed; margin-right: 6px; }
.board { display: grid; grid-template-columns: 340px 1fr; gap: 16px; align-items: start; }
@media (max-width: 1100px) { .board { grid-template-columns: 1fr; } }
.beat-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.beat-item {
  display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 4px 8px;
  text-align: left; border: 1px solid #e2e7ef; background: #fff; border-radius: 8px;
  padding: 8px 10px; cursor: pointer; font-size: 13px;
}
.beat-item.active { border-color: #2f6fed; background: #f5f8ff; }
.beat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.beat-meta { color: #8a94a6; font-size: 12px; grid-column: 2; }
.badge { grid-column: 3; grid-row: 1 / span 2; background: #fff4e5; color: #b26a00; border-radius: 999px; padding: 2px 8px; font-size: 12px; }
.create-box { border-top: 1px dashed #e2e7ef; padding-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.create-box h3 { margin: 0; font-size: 14px; }
.two-mini { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #5a6472; }
.field input, .field select, .json-box {
  height: 30px; border: 1px solid #cfd6e0; border-radius: 6px; padding: 0 8px;
  font-size: 13px; background: #fff; color: #1f2d3d; width: 100%; box-sizing: border-box;
}
.json-box { height: auto; padding: 8px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.detail { min-height: 320px; }
.section { margin-bottom: 18px; }
.section h3 { margin: 0 0 8px; font-size: 14px; }
.section-head { display: flex; justify-content: space-between; align-items: baseline; }
.anchor-form, .attach-form { display: flex; gap: 10px; align-items: end; margin-top: 10px; flex-wrap: wrap; }
.grow { flex: 1; min-width: 160px; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th, .table td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #eef1f6; }
.table th { color: #6b7686; font-weight: 600; font-size: 12px; }
.master-row td { background: #f8faff; }
tr.review { background: #fff8ec; }
.row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.muted { color: #8a94a6; font-size: 12px; }
.warn { color: #b26a00; font-size: 12px; }
.chip { background: #f0f4ff; border: 1px solid #dbe6ff; border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.chip.alt { background: #fff4e5; border-color: #ffe1b3; color: #b26a00; }
.preview { color: #24559c; font-size: 12px; }
.feedback { margin: 0; background: #eef6ff; border: 1px solid #d3e4ff; color: #24559c; border-radius: 8px; padding: 8px 12px; font-size: 13px; }
.conflict-panel { border-color: #ffd9a8; background: #fffdf8; }
.conflict { border: 1px solid #f0e0c4; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
.conflict-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; font-size: 13px; }
.conflict-actions { display: flex; gap: 8px; margin-top: 8px; }
.import-panel { border-color: #bcd3ff; }
.empty-detail { display: flex; align-items: center; justify-content: center; }
.btn {
  height: 32px; padding: 0 14px; border-radius: 6px; border: 1px solid #cfd6e0;
  background: #fff; color: #1f2d3d; cursor: pointer; font-size: 13px;
}
.btn.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
.btn.small { height: 28px; padding: 0 10px; font-size: 12px; }
.btn.tiny { height: 24px; padding: 0 8px; font-size: 12px; }
.btn.danger { color: #c45656; border-color: #f0c8c8; }
</style>
