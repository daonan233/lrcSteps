<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { LyricLine, TimedUnit } from './types'
import { api } from './api'

const props = defineProps<{
  line: LyricLine
  currentTime: number
  playing: boolean
  saving: boolean
  error: string
  duration: number
  songId: string
}>()
const emit = defineEmits<{
  seek: [time: number]
  preview: [time: number]
  toggle: []
  close: []
  save: [units: TimedUnit[], romajiUnits?: TimedUnit[]]
}>()

const draft = ref<LyricLine>({
  ...props.line,
  units: props.line.units.map(unit => ({ ...unit })),
  romajiUnits: props.line.romajiUnits?.map(unit => ({ ...unit })),
})
const lane = ref<'japanese' | 'romaji'>('japanese')
const selectedIndex = ref(0)
const deletedRomaji = ref<Array<{ unit: TimedUnit; index: number; previousEnd?: number; nextStart?: number }>>([])
const aligning = ref(false)
const alignError = ref('')
const alignNotice = ref('')
const padding = ref(2)
const hasRomajiTrack = Boolean(props.line.romajiUnits?.length)
const units = computed(() => lane.value === 'japanese' ? draft.value.units : draft.value.romajiUnits ?? [])
const selectedUnit = computed(() => units.value[selectedIndex.value])
const initialUnits = [...props.line.units, ...props.line.romajiUnits ?? []]
const rangeStart = computed(() => Math.max(0, Math.min(...initialUnits.map(unit => unit.start)) - padding.value))
const rangeEnd = computed(() => {
  const end = Math.max(...initialUnits.map(unit => unit.end)) + padding.value
  return props.duration > 0 ? Math.max(rangeStart.value + 0.1, Math.min(end, props.duration)) : end
})
const trackGeometry = computed(() => {
  let cursor = 12
  const segments = units.value.map((unit, index) => {
    if (index > 0) cursor += Math.min(80, Math.max(0, unit.start - units.value[index - 1].end) * 80)
    const segment = { left: cursor, width: Math.max(36, Math.min(280, (unit.end - unit.start) * 80)) }
    cursor += segment.width
    return segment
  })
  return { segments, width: cursor + 12 }
})
const playheadLeft = computed(() => {
  const list = units.value
  const segments = trackGeometry.value.segments
  if (!list.length) return 0
  if (props.currentTime <= list[0].start) return segments[0].left
  for (let index = 0; index < list.length; index++) {
    if (props.currentTime <= list[index].end) {
      const position = Math.max(0, Math.min(1, (props.currentTime - list[index].start) / Math.max(0.01, list[index].end - list[index].start)))
      return segments[index].left + position * segments[index].width
    }
    if (index < list.length - 1 && props.currentTime < list[index + 1].start) {
      const gap = list[index + 1].start - list[index].end
      return segments[index].left + segments[index].width + (props.currentTime - list[index].end) / gap * (segments[index + 1].left - segments[index].left - segments[index].width)
    }
  }
  return trackGeometry.value.width
})
const selectedStartMin = computed(() => selectedIndex.value > 0 ? Math.max(rangeStart.value, units.value[selectedIndex.value - 1].start + 0.01) : rangeStart.value)
const selectedStartMax = computed(() => (selectedUnit.value?.end ?? rangeEnd.value) - 0.01)
const selectedEndMin = computed(() => (selectedUnit.value?.start ?? rangeStart.value) + 0.01)
const selectedEndMax = computed(() => selectedIndex.value < units.value.length - 1 ? Math.min(rangeEnd.value, units.value[selectedIndex.value + 1].end - 0.01) : rangeEnd.value)
const activeIndex = computed(() => units.value.findLastIndex(unit => props.currentTime >= unit.start && props.currentTime < unit.end))

function roundTime(value: number): number { return Math.round(value * 1000) / 1000 }
function displayTime(value: number): string {
  const minutes = Math.floor(value / 60).toString().padStart(2, '0')
  const seconds = (value % 60).toFixed(2).padStart(5, '0')
  return `${minutes}:${seconds}`
}
function segmentStyle(index: number): Record<string, string> {
  const segment = trackGeometry.value.segments[index]
  return { left: `${segment.left}px`, width: `${segment.width}px` }
}
function unitProgress(unit: TimedUnit): number {
  return Math.max(0, Math.min(100, (props.currentTime - unit.start) / Math.max(0.01, unit.end - unit.start) * 100))
}
function changeLane(value: 'japanese' | 'romaji'): void { lane.value = value; selectedIndex.value = 0; alignNotice.value = ''; alignError.value = '' }
function selectUnit(index: number): void { selectedIndex.value = index; emit('seek', units.value[index].start) }
function seekOnRail(event: Event): void { emit('seek', Number((event.target as HTMLInputElement).value)) }
function setBoundary(field: 'start' | 'end', value: number): void {
  const unit = selectedUnit.value
  if (!unit || !Number.isFinite(value)) return
  alignNotice.value = ''
  if (field === 'start') {
    if (selectedStartMin.value > selectedStartMax.value) return
    const time = roundTime(Math.max(selectedStartMin.value, Math.min(selectedStartMax.value, value)))
    unit.start = time
    if (selectedIndex.value > 0) units.value[selectedIndex.value - 1].end = time
  } else {
    if (selectedEndMin.value > selectedEndMax.value) return
    const time = roundTime(Math.max(selectedEndMin.value, Math.min(selectedEndMax.value, value)))
    unit.end = time
    if (selectedIndex.value < units.value.length - 1) units.value[selectedIndex.value + 1].start = time
  }
}
function boundaryInput(field: 'start' | 'end', event: Event): void {
  setBoundary(field, Number((event.target as HTMLInputElement).value))
}
function removeSelectedRomaji(): void {
  if (lane.value !== 'romaji' || !draft.value.romajiUnits?.[selectedIndex.value]) return
  alignNotice.value = ''
  const index = selectedIndex.value
  const list = draft.value.romajiUnits
  const previous = list[index - 1]
  const next = list[index + 1]
  const previousEnd = previous?.end
  const nextStart = next?.start
  const [unit] = list.splice(index, 1)
  if (previous && next) {
    if (previous.text.trim()) previous.end = next.start
    else next.start = previous.end
  } else if (previous) previous.end = unit.end
  else if (next) next.start = unit.start
  deletedRomaji.value.push({ unit, index, previousEnd, nextStart })
  draft.value.romaji = list.map(item => item.text).join('')
  selectedIndex.value = Math.max(0, Math.min(index, list.length - 1))
}
function undoRomajiRemoval(): void {
  const removed = deletedRomaji.value.pop()
  if (!removed || !draft.value.romajiUnits) return
  alignNotice.value = ''
  const list = draft.value.romajiUnits
  list.splice(removed.index, 0, removed.unit)
  if (removed.previousEnd !== undefined) list[removed.index - 1].end = removed.previousEnd
  if (removed.nextStart !== undefined) list[removed.index + 1].start = removed.nextStart
  draft.value.romaji = list.map(item => item.text).join('')
  lane.value = 'romaji'
  selectedIndex.value = removed.index
}
function save(): void {
  emit('save', draft.value.units.map(unit => ({ ...unit })), draft.value.romajiUnits?.map(unit => ({ ...unit })))
}
async function alignCurrentLine(): Promise<void> {
  if (aligning.value || props.saving) return
  const targetLane = lane.value
  if (targetLane === 'romaji' && !draft.value.romajiUnits?.length) {
    alignError.value = '本句罗马音已删空，无法对齐罗马音轨'
    return
  }
  aligning.value = true
  alignError.value = ''
  alignNotice.value = ''
  try {
    const result = await api<{ units?: TimedUnit[]; romajiUnits?: TimedUnit[]; warning?: string }>(
      `/api/songs/${props.songId}/lines/${props.line.id}/align`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ units: draft.value.units, romajiUnits: draft.value.romajiUnits, lane: targetLane }),
      },
    )
    if (targetLane === 'romaji' && !result.romajiUnits) throw new Error('本句罗马音未能自动对齐，请继续用滑轨手动调整')
    if (targetLane === 'japanese' && !result.units) throw new Error('本句日文歌词未能自动对齐，请继续用滑轨手动调整')
    if (result.units) draft.value.units = result.units
    if (result.romajiUnits) {
      draft.value.romajiUnits = result.romajiUnits
      deletedRomaji.value = []
    }
    selectedIndex.value = Math.min(selectedIndex.value, units.value.length - 1)
    alignNotice.value = `本句${result.units && result.romajiUnits ? '日文与罗马音' : targetLane === 'romaji' ? '罗马音' : '日文歌词'}已按当前内容重新校时。试听确认后点击“保存校时”。${result.warning ? ` ${result.warning}` : ''}`
  } catch (failure) {
    alignError.value = String(failure instanceof Error ? failure.message : failure)
  } finally { aligning.value = false }
}
function onKeydown(event: KeyboardEvent): void { if (event.key === 'Escape') emit('close') }
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="timing-backdrop" @click.self="emit('close')">
    <section class="timing-modal" role="dialog" aria-modal="true" aria-label="实时逐字校对">
      <header class="timing-header">
        <div><span class="timing-eyebrow">TIMING EDITOR</span><h2>实时逐字校对</h2><p>{{ line.text }}</p></div>
        <button class="timing-close" type="button" aria-label="关闭校对" @click="emit('close')">×</button>
      </header>

      <div class="timing-preview">
        <div class="timing-preview-lyrics">
          <div class="timing-preview-jp"><span v-for="(unit, index) in draft.units" :key="index" class="karaoke-unit"><span class="base-text">{{ unit.text }}</span><span class="fill-text" :style="{ width: `${unitProgress(unit)}%` }">{{ unit.text }}</span></span></div>
          <div v-if="draft.romajiUnits?.length" class="timing-preview-romaji"><span v-for="(unit, index) in draft.romajiUnits" :key="index" class="karaoke-unit"><span class="base-text">{{ unit.text }}</span><span class="fill-text" :style="{ width: `${unitProgress(unit)}%` }">{{ unit.text }}</span></span></div>
        </div>
        <div class="timing-transport">
          <button class="timing-play" type="button" :aria-label="playing ? '暂停' : '播放'" @click="emit('toggle')">{{ playing ? '❚❚' : '▶' }}</button>
          <button class="timing-replay" type="button" @click="emit('preview', draft.units[0]?.start ?? line.start)">从本句试听</button>
          <span class="timing-clock">{{ displayTime(currentTime) }}</span>
        </div>
        <input class="timing-scrub" type="range" aria-label="试听进度" :min="rangeStart" :max="rangeEnd" step="0.01" :value="currentTime" @input="seekOnRail" />
        <div class="timing-scale"><span>{{ displayTime(rangeStart) }}</span><span>{{ displayTime(rangeEnd) }}</span></div>
      </div>

      <div class="timing-workspace" :class="{ busy: aligning }" :aria-busy="aligning">
        <div class="timing-toolbar">
          <div class="timing-tabs" role="tablist" aria-label="歌词轨道">
            <button type="button" role="tab" :aria-selected="lane === 'japanese'" :class="{ active: lane === 'japanese' }" @click="changeLane('japanese')">日文歌词</button>
            <button v-if="hasRomajiTrack" type="button" role="tab" :aria-selected="lane === 'romaji'" :class="{ active: lane === 'romaji' }" @click="changeLane('romaji')">罗马音</button>
          </div>
          <label class="timing-padding">视野 <select v-model.number="padding"><option :value="2">±2 秒</option><option :value="5">±5 秒</option><option :value="10">±10 秒</option></select></label>
        </div>
        <p class="timing-hint">随时可以重新校时本句。删除的罗马音不会再显示；校时会参考日文读音，必要时借助下一句定位，并同步更新两条轨道。试听后仍可用滑轨微调。</p>
        <div class="timing-track-scroll">
          <div class="timing-track" :style="{ width: `${trackGeometry.width}px` }">
            <div class="timing-playhead" :style="{ left: `${playheadLeft}px` }"></div>
            <button v-for="(unit, index) in units" :key="index" type="button" class="timing-segment" :class="{ selected: selectedIndex === index, audible: activeIndex === index }" :style="segmentStyle(index)" :title="`${unit.text === ' ' ? '空格' : unit.text} · ${displayTime(unit.start)}—${displayTime(unit.end)}`" @click="selectUnit(index)">{{ unit.text === ' ' ? '␣' : unit.text }}</button>
          </div>
        </div>
        <div v-if="selectedUnit" class="timing-focus">
          <div class="timing-focus-head"><span>当前调整 <strong>{{ selectedUnit.text === ' ' ? '␣' : selectedUnit.text }}</strong></span><span>{{ displayTime(selectedUnit.start) }} — {{ displayTime(selectedUnit.end) }}</span></div>
          <label class="timing-boundary"><span>起点</span><input type="range" aria-label="当前字起点" :min="selectedStartMin" :max="selectedStartMax" step="0.01" :value="selectedUnit.start" @input="boundaryInput('start', $event)" /><output>{{ selectedUnit.start.toFixed(2) }} s</output></label>
          <label class="timing-boundary"><span>终点</span><input type="range" aria-label="当前字终点" :min="selectedEndMin" :max="selectedEndMax" step="0.01" :value="selectedUnit.end" @input="boundaryInput('end', $event)" /><output>{{ selectedUnit.end.toFixed(2) }} s</output></label>
          <div class="timing-fine"><span>精确输入</span><label>起点 <input type="number" min="0" step="0.01" :value="selectedUnit.start" @change="boundaryInput('start', $event)" /></label><label>终点 <input type="number" min="0" step="0.01" :value="selectedUnit.end" @change="boundaryInput('end', $event)" /></label></div>
          <div v-if="lane === 'romaji'" class="timing-romaji-actions"><button type="button" class="timing-remove" :aria-label="`删除选中的罗马音 ${selectedUnit.text === ' ' ? '空格' : selectedUnit.text}`" @click="removeSelectedRomaji">删除选中的罗马音</button><button v-if="deletedRomaji.length" type="button" class="timing-undo" @click="undoRomajiRemoval">撤销删除</button></div>
        </div>
        <div v-else-if="lane === 'romaji'" class="timing-romaji-empty">本行罗马音已全部删除。<button type="button" class="timing-undo" @click="undoRomajiRemoval">撤销删除</button></div>
      </div>

      <div v-if="error || alignError" class="timing-error" role="alert">{{ alignError || error }}</div>
      <div v-if="alignNotice" class="timing-notice" role="status">{{ alignNotice }}</div>
      <footer class="timing-actions"><button type="button" class="timing-cancel" @click="emit('close')">取消</button><button type="button" class="timing-realign" :title="`按当前${lane === 'romaji' ? '罗马音' : '日文歌词'}重新校时本句`" :disabled="aligning || saving || (lane === 'romaji' && !draft.romajiUnits?.length)" @click="alignCurrentLine">{{ aligning ? '本句校时中…' : '本句重新校时' }}</button><button type="button" class="timing-save" :disabled="saving || aligning" @click="save">{{ saving ? '保存中…' : '保存校时' }}</button></footer>
    </section>
  </div>
</template>

<style scoped>
.timing-backdrop{position:fixed;z-index:30;inset:0;background:#03030be8;display:grid;place-items:center;padding:16px}
.timing-modal{width:min(900px,100%);max-height:min(94vh,960px);overflow:auto;background:#1b192a;border:1px solid #544968;border-radius:18px;box-shadow:0 35px 100px #000a;color:#eeeaf5;padding:24px;display:flex;flex-direction:column;gap:18px}
.timing-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.timing-eyebrow{font-size:10px;font-weight:800;letter-spacing:2.5px;color:#b9a0ff}.timing-header h2{font-size:22px;margin:5px 0}.timing-header p{font-size:13px;color:#aaa3be;margin:0}.timing-close{border:0;background:none;color:#bbb3ce;font-size:28px;line-height:1}
.timing-preview{padding:18px;border:1px solid #493e68;border-radius:14px;background:radial-gradient(circle at 50% 20%,#30244d,#201b34 75%)}.timing-preview-lyrics{text-align:center;min-height:88px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px}.timing-preview-jp{font-size:27px;font-weight:800;line-height:1.5;word-break:break-word}.timing-preview-romaji{font-size:14px;line-height:1.5;color:#aca2c8;word-break:break-word}.timing-preview-lyrics .karaoke-unit{position:relative;display:inline-block;white-space:pre}.timing-preview-lyrics .base-text{color:#aea5c5}.timing-preview-lyrics .fill-text{position:absolute;left:0;top:0;overflow:hidden;white-space:pre;color:#fff0a3}.timing-transport{display:flex;align-items:center;gap:10px;margin:12px 0 8px}.timing-play{border:0;border-radius:50%;width:37px;height:37px;background:#a584f3;color:#140e24}.timing-replay{border:1px solid #6b598d;border-radius:8px;background:#302744;color:#eee7ff;padding:8px 12px;font-size:12px}.timing-clock{margin-left:auto;font-size:15px;font-variant-numeric:tabular-nums;color:#ddcef9}.timing-scrub{width:100%;accent-color:#ad8eff;cursor:pointer}.timing-scale{display:flex;justify-content:space-between;color:#8e84a6;font-size:11px;font-variant-numeric:tabular-nums}
.timing-workspace{min-height:0}.timing-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px}.timing-tabs{display:flex;gap:5px}.timing-tabs button{border:1px solid #49415c;background:#262237;color:#ada5be;border-radius:8px;padding:9px 13px;font-size:12px}.timing-tabs button.active{background:#533c81;border-color:#a585ed;color:white}.timing-padding{display:flex;align-items:center;gap:7px;color:#9b91b1;font-size:11px}.timing-padding select{color:#e2d9ef;background:#29243a;border:1px solid #514765;border-radius:7px;padding:6px}.timing-hint{color:#aaa1ba;font-size:12px;line-height:1.5;margin:11px 0}.timing-track-scroll{overflow-x:auto;overflow-y:hidden;padding:8px 2px 14px;border-radius:10px;background:#131221}.timing-track{height:66px;position:relative;background:linear-gradient(to bottom,transparent 49%,#453c57 50%,transparent 51%)}.timing-segment{position:absolute;top:14px;height:38px;min-width:9px;overflow:hidden;text-overflow:clip;white-space:nowrap;text-align:center;padding:0 2px;border:1px solid #665280;border-radius:5px;background:#443458;color:#e9dff5;font-weight:700;font-size:13px;z-index:1}.timing-segment:hover{background:#6a4e8d}.timing-segment.audible{background:#77609b}.timing-segment.selected{background:#a780f0;border-color:#e2c9ff;color:#150f24;z-index:2;box-shadow:0 0 0 2px #bea4ff55}.timing-playhead{position:absolute;top:0;bottom:0;width:2px;background:#ffe8a1;z-index:3;pointer-events:none;box-shadow:0 0 8px #ffe8a1}
.timing-focus{margin-top:15px;padding:16px;border:1px solid #433a59;border-radius:12px;background:#252034}.timing-focus-head{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:#c1b5d6;margin-bottom:13px}.timing-focus-head strong{display:inline-grid;place-items:center;margin-left:7px;min-width:30px;min-height:30px;background:#70549e;border-radius:7px;color:#fff;font-size:17px}.timing-focus-head span:last-child{font-variant-numeric:tabular-nums}.timing-boundary{display:grid;grid-template-columns:40px minmax(0,1fr) 65px;align-items:center;gap:12px;margin-top:10px;color:#cfc5de;font-size:12px}.timing-boundary input{width:100%;accent-color:#ad8eff;cursor:ew-resize}.timing-boundary output{text-align:right;font-variant-numeric:tabular-nums;color:#eee0ff}.timing-fine{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:16px;padding-top:13px;border-top:1px solid #433a59;color:#9e94b1;font-size:11px}.timing-fine label{display:flex;align-items:center;gap:7px}.timing-fine input{width:90px;padding:6px 8px;border:1px solid #514861;background:#1c192b;border-radius:6px;color:#eee5f6;font-size:12px}.timing-error{color:#ffb6ca;background:#482535;border-radius:9px;padding:10px 12px;font-size:12px}.timing-actions{display:flex;justify-content:flex-end;gap:9px;padding-top:14px;border-top:1px solid #40384f}.timing-actions button{padding:10px 16px;border-radius:8px;font-size:12px;font-weight:700}.timing-cancel{border:1px solid #51475d;background:#2a2637;color:#e2d8ed}.timing-save{border:0;background:#a584ee;color:#1c1230}.timing-save:disabled{opacity:.6}
.timing-romaji-actions{display:flex;gap:8px;margin-top:15px}.timing-remove,.timing-undo{border:1px solid #775367;background:#3b283c;color:#ffd6df;border-radius:8px;padding:8px 11px;font-size:12px;cursor:pointer}.timing-undo{border-color:#66557f;background:#302744;color:#e4d6fc}.timing-romaji-empty{margin-top:15px;padding:18px;border:1px dashed #66557f;border-radius:10px;color:#c9bddc;font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:10px}
.timing-header,.timing-preview,.timing-workspace,.timing-actions{flex-shrink:0}.timing-workspace.busy{pointer-events:none;opacity:.65}.timing-notice{color:#d7f7dd;background:#244034;border-radius:9px;padding:10px 12px;font-size:12px}.timing-actions{position:sticky;bottom:-24px;z-index:5;background:#1b192a;margin:0 -24px -24px;padding:14px 24px 24px;box-shadow:0 -10px 24px #0b091355}.timing-realign{border:1px solid #856aae;background:#41335e;color:#f0e6ff}.timing-actions button:disabled{opacity:.6;cursor:wait}
@media(max-width:620px){.timing-backdrop{padding:8px}.timing-modal{padding:15px;gap:13px;max-height:98vh}.timing-preview-jp{font-size:20px}.timing-transport{flex-wrap:wrap}.timing-focus{padding:12px}.timing-boundary{grid-template-columns:32px minmax(0,1fr) 55px;gap:6px}.timing-fine{gap:8px}.timing-tabs button{padding:8px 9px}}
@media(max-width:620px){.timing-actions{flex-wrap:wrap;bottom:-15px;margin:0 -15px -15px;padding:12px 15px 15px}.timing-realign{margin-left:auto}}
</style>
