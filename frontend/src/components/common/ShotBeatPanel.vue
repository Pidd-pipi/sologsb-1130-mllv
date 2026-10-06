<script setup lang="ts">
/**
 * 镜头详情内的多机位动作节拍面板：
 * 展示该镜头作主机位/从机位参与的节拍，已拍镜头待复核时可就地采纳/保留，
 * 其余编排与离线合并统一到「动作节拍」页处理。
 */
import { computed, onMounted, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import { useBeatStore } from '../../stores/beatStore';
import { beatAtSeconds } from '../../utils/beatMath';
import type { ActionBeat, BeatAttachment } from '../../types/beat';
import type { Shot } from '../../types/shot';

const props = defineProps<{ shot: Shot }>();
const router = useRouter();
const beatStore = useBeatStore();
const { beats } = storeToRefs(beatStore);

onMounted(async () => {
  if (!beatStore.ready) await beatStore.load();
});
watch(
  () => props.shot.id,
  async () => {
    if (!beatStore.ready) await beatStore.load();
  },
);

interface Row {
  beat: ActionBeat;
  role: '主机位' | '从机位';
  fps: number;
  framePos: number;
  attachment: BeatAttachment | null;
  frozen: boolean;
  legacy: boolean;
}

const rows = computed<Row[]>(() =>
  beats.value
    .filter((b) => b.masterShotId === props.shot.id || b.attachments.some((a) => a.shotId === props.shot.id))
    .map((beat) => {
      const att = beat.attachments.find((a) => a.shotId === props.shot.id) ?? null;
      return {
        beat,
        role: att ? '从机位' : '主机位',
        fps: att ? att.fps : beat.masterFps,
        framePos: att ? att.framePos : beat.masterFrame,
        attachment: att,
        frozen: beat.conflicts.length > 0,
        legacy: beat.legacy,
      };
    }),
);

const pendingCount = computed(() =>
  rows.value.filter((r) => r.attachment?.reviewState === 'pending').length,
);

async function accept(row: Row) {
  if (!row.attachment || typeof row.beat.id !== 'number') return;
  await beatStore.acceptSuggestion(row.beat.id, row.attachment.uuid);
}
async function reject(row: Row) {
  if (!row.attachment || typeof row.beat.id !== 'number') return;
  await beatStore.rejectSuggestion(row.beat.id, row.attachment.uuid);
}

function gotoBeats() {
  void router.push('/beats');
}
</script>

<template>
  <div class="beat-panel">
    <div class="bp-head">
      <span class="muted">
        该镜头参与 {{ rows.length }} 个动作节拍
        <template v-if="pendingCount">，<strong class="warn">{{ pendingCount }} 个已拍帧位待复核</strong></template>
      </span>
      <button type="button" class="btn tiny" data-testid="shot-goto-beats" @click="gotoBeats">去动作节拍编排</button>
    </div>

    <table v-if="rows.length" class="bp-table" data-testid="shot-beat-table">
      <thead>
        <tr><th>节拍</th><th>角色</th><th>本机位帧位</th><th>动作时间</th><th>状态 / 复核</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.beat.uuid">
          <td>{{ row.beat.name || '未命名节拍' }}</td>
          <td><span class="tag" :class="{ master: row.role === '主机位' }">{{ row.role }}</span></td>
          <td class="mono strong">第 {{ row.framePos }} 帧</td>
          <td class="mono">{{ beatAtSeconds(row.framePos, row.fps) }} s</td>
          <td>
            <template v-if="row.frozen"><span class="tag warn">合并冲突待确认</span></template>
            <template v-else-if="row.legacy"><span class="tag legacy">单机位节拍</span></template>
            <template v-else-if="row.attachment && row.attachment.reviewState === 'pending'">
              <div class="review">
                <span class="tag warn">已拍 · 待复核（建议第 {{ row.attachment.suggestedFramePos }} 帧，原值保留）</span>
                <span class="acts">
                  <button type="button" class="btn tiny primary" data-testid="shot-review-accept" @click="accept(row)">采纳新值</button>
                  <button type="button" class="btn tiny" data-testid="shot-review-reject" @click="reject(row)">保留原值</button>
                </span>
              </div>
            </template>
            <template v-else><span class="ok">已同步</span></template>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="muted">尚未挂到任何动作节拍；可到「动作节拍」页以该镜头为主机位建立节拍，或把它挂到同场节拍上。</p>
  </div>
</template>

<style scoped>
.beat-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bp-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.bp-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.bp-table th,
.bp-table td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid #eef1f6;
  vertical-align: middle;
}
.bp-table th {
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
.warn {
  color: #b26a00;
}
.ok {
  color: #1f8a4c;
  font-size: 12px;
}
.tag {
  display: inline-flex;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  border: 1px solid #d6ddff;
  background: #eef2ff;
  color: #3b52c4;
}
.tag.master {
  background: #eef2ff;
}
.tag.legacy {
  background: #f1f3f6;
  border-color: #dde2ea;
  color: #6b7686;
}
.tag.warn {
  background: #fff4e5;
  border-color: #ffd8a8;
  color: #b26a00;
}
.review {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.acts {
  display: flex;
  gap: 6px;
}
.btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 12px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
.btn.tiny {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
}
</style>
