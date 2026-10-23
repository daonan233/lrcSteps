<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from './api'
import type { LyricLine, Song, TimedUnit } from './types'

interface MvStyle {
  vertical: number; scale: number
  leftX: number; leftY: number; leftScale: number
  rightX: number; rightY: number; rightScale: number
  beforeColor: string; afterColor: string; outlineColor: string; showRomaji: boolean
}
type MvLayout = 'single' | 'double'
interface MvProject {
  id: string; songId: string; title: string; originalVideoName: string; createdAt: string
  duration: number; width: number; height: number; offsetMs: number; style: MvStyle
  videoUrl: string; assUrl: string
  exportUrls: Record<MvLayout, { preview: string | null; full: string | null }>
  render?: { kind: 'preview' | 'full'; layout?: MvLayout; status: 'queued' | 'running' | 'failed' | 'complete'; progress: number; error?: string }
}
interface SyncResult { offsetSeconds: number; confidence: number; applied: boolean; project: MvProject }

const props = defineProps<{ songs: Song[]; selectedSongId?: string }>()
const projects = ref<MvProject[]>([])
const project = ref<MvProject | null>(null)
const linkedSong = ref<Song | null>(null)
const video = ref<HTMLVideoElement | null>(null)
const stage = ref<HTMLElement | null>(null)
const stageWidth = ref(640)
const videoFile = ref<File | null>(null)
const chosenSongId = ref(props.selectedSongId || '')
const projectTitle = ref('')
const offsetMs = ref(0)
const viewSeconds = ref(30)
const defaultStyle: MvStyle = {
  vertical: 0.76, scale: 1,
  leftX: 0.07, leftY: 0.69, leftScale: 1,
  rightX: 0.93, rightY: 0.82, rightScale: 1,
  beforeColor: '#d8d1e8', afterColor: '#ffe69a', outlineColor: '#17101f', showRomaji: true,
}
const style = ref<MvStyle>({ ...defaultStyle })
const layout = ref<MvLayout>('single')
const videoTime = ref(0)
const playing = ref(false)
const uploading = ref(false)
const saving = ref(false)
const syncing = ref(false)
const error = ref('')
const notice = ref('')
let poller: ReturnType<typeof setInterval> | undefined
let frame = 0
let observer: ResizeObserver | undefined

watch(() => props.songs, songs => { if (!chosenSongId.value && songs.length) chosenSongId.value = props.selectedSongId || songs[0].id }, { immediate: true })
watch(stage, element => {
  observer?.disconnect()
  if (element) {
    observer = new ResizeObserver(entries => { stageWidth.value = entries[0].contentRect.width })
    observer.observe(element)
  }
})

const activeLine = computed<LyricLine | null>(() => {
  const lines = linkedSong.value?.lines ?? []
  const songTime = videoTime.value - offsetMs.value / 1000
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    const start = Math.min(...line.units.map(unit => unit.start))
    const end = Math.max(...line.units.map(unit => unit.end), ...line.romajiUnits?.map(unit => unit.end) ?? [])
    if (songTime >= start && songTime <= end) return line
  }
  return null
})
const countdownPreviewSeconds = 4
const preloadSeconds = 3.5
const minBreakSeconds = 8
function lineOnset(line: LyricLine): number { return Math.min(...line.units.map(unit => unit.start)) }
function lineFinish(line: LyricLine): number { return Math.max(line.end, ...line.units.map(unit => unit.end), ...line.romajiUnits?.map(unit => unit.end) ?? []) }
function hasBreakBefore(lines: LyricLine[], index: number): boolean {
  return index === 0 || lineOnset(lines[index]) - lineFinish(lines[index - 1]) >= minBreakSeconds
}
function doubleRowStart(lines: LyricLine[], index: number, offset: number): number {
  const firstStart = Math.max(0, lineOnset(lines[0]) + offset - 2)
  const ordinaryStart = index < 2 ? firstStart : Math.max(0, lineOnset(lines[index - 1]) + offset)
  if (index === 0) return Math.max(0, lineOnset(lines[index]) + offset - preloadSeconds)
  return hasBreakBefore(lines, index)
    ? Math.max(ordinaryStart, lineOnset(lines[index]) + offset - preloadSeconds)
    : ordinaryStart
}
function doubleRowEnd(lines: LyricLine[], index: number, offset: number, finalEnd: number): number {
  let end = index + 2 < lines.length ? doubleRowStart(lines, index + 2, offset) : finalEnd
  for (let next = index + 1; next < lines.length; next++) {
    if (hasBreakBefore(lines, next)) {
      end = Math.min(end, lineFinish(lines[next - 1]) + offset + 1.2)
      break
    }
  }
  return end
}
const doubleRows = computed(() => {
  const lines = (linkedSong.value?.lines ?? []).filter(line => line.units.length)
  if (!lines.length) return []
  const offset = offsetMs.value / 1000
  const finalEnd = Math.max(...lines.map(lineFinish)) + offset + 2
  const rows: Array<{ line: LyricLine; slot: number; countdown: number }> = []
  for (let slot = 0; slot < 2; slot++) {
    for (let index = lines.length - 1; index >= 0; index--) {
      if (index % 2 !== slot) continue
      const start = doubleRowStart(lines, index, offset)
      const end = doubleRowEnd(lines, index, offset, finalEnd)
      if (videoTime.value >= start && videoTime.value < end) {
        const remaining = lineOnset(lines[index]) + offset - videoTime.value
        const countdown = hasBreakBefore(lines, index) && remaining > 0 && remaining <= countdownPreviewSeconds
          ? remaining > 2 ? 3 : remaining > 1 ? 2 : 1
          : -1
        rows.push({ line: lines[index], slot, countdown })
        break
      }
    }
  }
  return rows
})
const stageHeight = computed(() => project.value ? stageWidth.value * project.value.height / project.value.width : 360)
const jpFontSize = computed(() => {
  const base = stageHeight.value * 0.055 * style.value.scale
  const textLength = activeLine.value?.text.length ?? 10
  return Math.max(10, Math.min(base, stageWidth.value * 0.88 / Math.max(1, textLength)))
})
const romanFontSize = computed(() => {
  const base = jpFontSize.value * 0.46
  const length = activeLine.value?.romaji?.length ?? 10
  return Math.max(9, Math.min(base, stageWidth.value * 0.88 / Math.max(1, length * 0.55)))
})
function doubleGeometry(line: LyricLine, slot: number): { top: string; left: string; right: string; maxWidth: string; jpSize: string; romanSize: string } {
  if (!project.value) return { top: '0px', left: '0', right: 'auto', maxWidth: '90%', jpSize: '20px', romanSize: '10px' }
  const { width, height } = project.value
  const ratio = stageWidth.value / width
  const isLeft = slot === 0
  const x = isLeft ? style.value.leftX : style.value.rightX
  const y = isLeft ? style.value.leftY : style.value.rightY
  const sideScale = isLeft ? style.value.leftScale : style.value.rightScale
  const baseJp = Math.max(22, Math.round(height * 0.046 * sideScale))
  const baseRoman = Math.max(14, Math.round(baseJp * 0.45))
  const maxTextWidth = width * (isLeft ? 0.96 - x : x - 0.04)
  const jpLength = line.units.map(unit => unit.text).join('').length
  const romanLength = (line.romajiUnits ?? []).map(unit => unit.text).join('').length
  const jpSize = Math.max(14, Math.min(baseJp, Math.floor(maxTextWidth / Math.max(1, jpLength))))
  const romanSize = Math.max(10, Math.min(baseRoman, Math.floor(maxTextWidth / Math.max(1, romanLength * 0.55))))
  return {
    top: `${(height * y - jpSize * 0.58) * ratio}px`,
    left: isLeft ? `${x * 100}%` : 'auto',
    right: isLeft ? 'auto' : `${(1 - x) * 100}%`,
    maxWidth: `${maxTextWidth * ratio}px`,
    jpSize: `${jpSize * ratio}px`, romanSize: `${romanSize * ratio}px`,
  }
}
function unitProgress(unit: TimedUnit): number {
  const songTime = videoTime.value - offsetMs.value / 1000
  return Math.max(0, Math.min(100, (songTime - unit.start) / Math.max(0.01, unit.end - unit.start) * 100))
}
function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
}
function syncClock(): void {
  if (video.value) videoTime.value = video.value.currentTime
  frame = requestAnimationFrame(syncClock)
}
function hydrateSettings(value: MvProject): void { offsetMs.value = value.offsetMs; style.value = { ...defaultStyle, ...value.style } }
async function loadProjects(): Promise<void> {
  projects.value = await api<MvProject[]>('/api/mv-projects')
  if (project.value) {
    const refreshed = projects.value.find(item => item.id === project.value?.id)
    if (refreshed) project.value = refreshed
  }
}
async function selectProject(value: MvProject): Promise<void> {
  error.value = ''
  notice.value = ''
  video.value?.pause()
  project.value = value
  linkedSong.value = await api<Song>(`/api/songs/${value.songId}`)
  hydrateSettings(value)
  videoTime.value = 0
  await nextTick()
  video.value?.load()
}
async function uploadProject(): Promise<void> {
  if (!videoFile.value || !chosenSongId.value) { error.value = '请选择 MV 文件和关联歌曲'; return }
  uploading.value = true; error.value = ''; notice.value = ''
  const form = new FormData()
  form.append('video', videoFile.value)
  form.append('songId', chosenSongId.value)
  form.append('title', projectTitle.value.trim())
  try {
    const created = await api<MvProject>('/api/mv-projects', { method: 'POST', body: form })
    await loadProjects()
    await selectProject(created)
    videoFile.value = null
    projectTitle.value = ''
    notice.value = 'MV 已上传。可以先自动估算同步偏移，再用滑轨试听微调。'
  } catch (failure) { error.value = String(failure instanceof Error ? failure.message : failure) }
  finally { uploading.value = false }
}
async function saveSettings(): Promise<void> {
  if (!project.value) return
  saving.value = true; error.value = ''
  try {
    project.value = await api<MvProject>(`/api/mv-projects/${project.value.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offsetMs: offsetMs.value, style: style.value }),
    })
    projects.value = projects.value.map(item => item.id === project.value?.id ? project.value! : item)
    notice.value = '同步与字幕样式已保存。'
  } catch (failure) { error.value = String(failure instanceof Error ? failure.message : failure) }
  finally { saving.value = false }
}
async function autoSync(): Promise<void> {
  if (!project.value) return
  syncing.value = true; error.value = ''; notice.value = ''
  try {
    const result = await api<SyncResult>(`/api/mv-projects/${project.value.id}/sync`, { method: 'POST' })
    project.value = result.project
    if (result.applied) {
      offsetMs.value = result.project.offsetMs
      notice.value = `已自动同步：MV 比歌曲${result.offsetSeconds >= 0 ? '晚' : '早'} ${Math.abs(result.offsetSeconds).toFixed(2)} 秒。请试听确认。`
    } else notice.value = '自动比对的把握较低，未覆盖你的设置。请用滑轨手动对齐。'
  } catch (failure) { error.value = String(failure instanceof Error ? failure.message : failure) }
  finally { syncing.value = false }
}
async function exportVideo(kind: 'preview' | 'full'): Promise<void> {
  if (!project.value) return
  await saveSettings()
  if (error.value || !project.value) return
  const first = linkedSong.value?.lines[0]?.start ?? 0
  const start = kind === 'preview' ? Math.min(project.value.duration - 0.1, Math.max(0, videoTime.value || first + offsetMs.value / 1000 - 2)) : 0
  try {
    project.value = await api<MvProject>(`/api/mv-projects/${project.value.id}/export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, start, layout: layout.value }),
    })
    notice.value = `正在导出${layout.value === 'double' ? '双句 KTV 版' : '单句版'}${kind === 'preview' ? '约 30 秒预览片段' : '完整 MP4'}。`
  } catch (failure) { error.value = String(failure instanceof Error ? failure.message : failure) }
}
async function downloadAss(): Promise<void> {
  if (!project.value) return
  await saveSettings()
  if (error.value || !project.value) return
  const link = document.createElement('a')
  link.href = `${project.value.assUrl}?layout=${layout.value}`
  link.download = `${project.value.title}-${layout.value}.ass`
  link.click()
}
async function deleteProject(): Promise<void> {
  if (!project.value || !confirm(`删除「${project.value.title}」的 MV 项目和导出文件？`)) return
  try {
    await api<void>(`/api/mv-projects/${project.value.id}`, { method: 'DELETE' })
    project.value = null
    linkedSong.value = null
    await loadProjects()
    notice.value = 'MV 项目已删除。'
  } catch (failure) { error.value = String(failure instanceof Error ? failure.message : failure) }
}
function offsetInput(event: Event): void { offsetMs.value = Math.round(Number((event.target as HTMLInputElement).value) * 1000) }
function offsetNumber(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) offsetMs.value = Math.max(-600000, Math.min(600000, Math.round(value * 1000)))
}
function seekVideo(event: Event): void {
  if (video.value) video.value.currentTime = Number((event.target as HTMLInputElement).value)
}
async function toggleVideo(): Promise<void> {
  if (!video.value) return
  if (video.value.paused) {
    try { await video.value.play() } catch { error.value = '浏览器无法播放这个 MV 格式' }
  } else video.value.pause()
}
function jumpToFirstLine(): void {
  if (video.value && linkedSong.value?.lines.length) video.value.currentTime = Math.max(0, linkedSong.value.lines[0].start + offsetMs.value / 1000)
}

onMounted(async () => {
  try { await loadProjects(); if (projects.value.length) await selectProject(projects.value[0]) }
  catch (failure) { error.value = String(failure instanceof Error ? failure.message : failure) }
  poller = setInterval(() => {
    if (project.value?.render && ['queued', 'running'].includes(project.value.render.status)) loadProjects().catch(() => undefined)
  }, 1500)
  frame = requestAnimationFrame(syncClock)
})
onUnmounted(() => { if (poller) clearInterval(poller); cancelAnimationFrame(frame); observer?.disconnect() })
</script>

<template>
  <div class="mv-studio">
    <div v-if="error" class="mv-alert mv-error" role="alert">{{ error }}<button type="button" @click="error = ''">×</button></div>
    <div v-if="notice" class="mv-alert mv-notice">{{ notice }}<button type="button" @click="notice = ''">×</button></div>
    <section class="mv-card">
      <div class="mv-section-head"><span class="mv-number">01</span><div><h2>添加 MV</h2><p>关联一首已校时的歌曲，把日文和罗马音叠到视频画面。</p></div></div>
      <form class="mv-upload" @submit.prevent="uploadProject">
        <label class="mv-file"><span>▣</span><strong>{{ videoFile?.name || '选择 MV 文件' }}</strong><small>MP4、MOV、WebM、MKV · 最大 1 GB</small><input type="file" accept=".mp4,.mov,.webm,.mkv,video/*" @change="videoFile = ($event.target as HTMLInputElement).files?.[0] ?? null" /></label>
        <div class="mv-upload-controls"><label>关联歌曲<select v-model="chosenSongId"><option disabled value="">请选择歌曲</option><option v-for="song in songs" :key="song.id" :value="song.id">{{ song.title }}</option></select></label><label>项目名称<input v-model="projectTitle" type="text" placeholder="默认使用歌曲名称" maxlength="120" /></label><button class="mv-primary" type="submit" :disabled="uploading || !songs.length">{{ uploading ? '上传中…' : '上传 MV' }}</button></div>
      </form>
    </section>

    <section v-if="projects.length" class="mv-library"><div class="mv-library-head"><h3>MV 项目</h3><span>{{ projects.length }} 个</span></div><div class="mv-project-list"><button v-for="item in projects" :key="item.id" type="button" :class="{ active: project?.id === item.id }" @click="selectProject(item)"><strong>{{ item.title }}</strong><small>{{ item.originalVideoName }}</small></button></div></section>

    <section v-if="project" class="mv-card mv-editor">
      <div class="mv-section-head"><span class="mv-number">02</span><div><h2>{{ project.title }}</h2><p>{{ project.width }} × {{ project.height }} · {{ formatTime(project.duration) }} · {{ linkedSong?.title || '正在加载歌词' }}</p></div><button class="mv-delete" type="button" @click="deleteProject">删除项目</button></div>
      <div class="mv-layout-picker" role="group" aria-label="字幕版本"><button type="button" :class="{ active: layout === 'single' }" :aria-pressed="layout === 'single'" @click="layout = 'single'">单句版</button><button type="button" :class="{ active: layout === 'double' }" :aria-pressed="layout === 'double'" @click="layout = 'double'">双句 KTV 版</button><span>选择预览与本次导出的版本</span></div>
      <div ref="stage" class="mv-stage" :style="{ aspectRatio: `${project.width} / ${project.height}` }">
        <video :key="project.id" ref="video" :src="project.videoUrl" controls playsinline preload="metadata" @play="playing = true" @pause="playing = false" @timeupdate="videoTime = ($event.target as HTMLVideoElement).currentTime"></video>
        <div v-if="layout === 'single' && activeLine" class="mv-lyrics" :style="{ top: `${style.vertical * 100}%`, '--before': style.beforeColor, '--after': style.afterColor, '--outline': style.outlineColor, '--jp-size': `${jpFontSize}px`, '--roman-size': `${romanFontSize}px` }">
          <div class="mv-jp"><span v-for="(unit, index) in activeLine.units" :key="index" class="mv-unit"><span class="mv-base">{{ unit.text }}</span><span class="mv-fill" :style="{ width: `${unitProgress(unit)}%` }">{{ unit.text }}</span></span></div>
          <div v-if="style.showRomaji && activeLine.romajiUnits?.length" class="mv-roman"><span v-for="(unit, index) in activeLine.romajiUnits" :key="index" class="mv-unit"><span class="mv-base">{{ unit.text }}</span><span class="mv-fill" :style="{ width: `${unitProgress(unit)}%` }">{{ unit.text }}</span></span></div>
        </div>
        <div v-for="row in layout === 'double' ? doubleRows : []" :key="row.line.id" class="mv-lyrics mv-double" :class="row.slot === 0 ? 'mv-left' : 'mv-right'" :style="{ top: doubleGeometry(row.line, row.slot).top, left: doubleGeometry(row.line, row.slot).left, right: doubleGeometry(row.line, row.slot).right, maxWidth: doubleGeometry(row.line, row.slot).maxWidth, '--before': style.beforeColor, '--after': style.afterColor, '--outline': style.outlineColor, '--jp-size': doubleGeometry(row.line, row.slot).jpSize, '--roman-size': doubleGeometry(row.line, row.slot).romanSize }">
          <div v-if="row.countdown >= 0" class="mv-countdown" aria-label="即将开唱"><span v-for="dot in 3" :key="dot" :class="{ hidden: dot > row.countdown }">●</span></div>
          <div class="mv-jp"><span v-for="(unit, index) in row.line.units" :key="index" class="mv-unit"><span class="mv-base">{{ unit.text }}</span><span class="mv-fill" :style="{ width: `${unitProgress(unit)}%` }">{{ unit.text }}</span></span></div>
          <div v-if="style.showRomaji && row.line.romajiUnits?.length" class="mv-roman"><span v-for="(unit, index) in row.line.romajiUnits" :key="index" class="mv-unit"><span class="mv-base">{{ unit.text }}</span><span class="mv-fill" :style="{ width: `${unitProgress(unit)}%` }">{{ unit.text }}</span></span></div>
        </div>
      </div>
      <div class="mv-video-transport"><button type="button" :aria-label="playing ? '暂停 MV' : '播放 MV'" @click="toggleVideo">{{ playing ? '❚❚' : '▶' }}</button><span>{{ formatTime(videoTime) }}</span><input type="range" aria-label="MV 试听进度" min="0" :max="project.duration" step="0.01" :value="videoTime" @input="seekVideo" /><span>{{ formatTime(project.duration) }}</span><button type="button" @click="jumpToFirstLine">跳到首句</button></div>
      <p class="mv-preview-note">以 MV 自带音频为准实时预览。画面中的设置会在导出前保存。</p>

      <div class="mv-settings">
        <div class="mv-setting-title"><h3>歌词同步</h3><button type="button" :disabled="syncing" @click="autoSync">{{ syncing ? '正在比对音频…' : '自动估算偏移' }}</button></div>
        <p>正数表示 MV 中的歌声比歌曲文件晚出现。播放 MV 时拖动滑轨，看到歌词跟上人声后保存。</p>
        <div class="mv-offset"><span>−{{ viewSeconds }} s</span><input type="range" aria-label="歌词时间偏移" :min="-viewSeconds" :max="viewSeconds" step="0.01" :value="offsetMs / 1000" @input="offsetInput" /><span>+{{ viewSeconds }} s</span></div>
        <div class="mv-offset-details"><label>偏移秒数 <input type="number" min="-600" max="600" step="0.01" :value="(offsetMs / 1000).toFixed(2)" @change="offsetNumber" /></label><label>滑轨范围 <select v-model.number="viewSeconds"><option :value="30">±30 秒</option><option :value="120">±2 分钟</option><option :value="600">±10 分钟</option></select></label></div>
      </div>

      <div class="mv-settings">
        <h3>字幕样式</h3>
        <div v-if="layout === 'single'" class="mv-style-grid">
          <label>画面高度 <input v-model.number="style.vertical" type="range" min="0.15" max="0.85" step="0.01" /><span>{{ Math.round(style.vertical * 100) }}%</span></label>
          <label>字号 <input v-model.number="style.scale" type="range" min="0.6" max="1.6" step="0.05" /><span>{{ style.scale.toFixed(2) }}×</span></label>
        </div>
        <div v-else class="mv-side-controls">
          <div class="mv-side-control"><h4>左句</h4><label>横向位置 <input v-model.number="style.leftX" type="range" min="0.02" max="0.48" step="0.01" /><span>{{ Math.round(style.leftX * 100) }}%</span></label><label>纵向位置 <input v-model.number="style.leftY" type="range" min="0.08" max="0.88" step="0.01" /><span>{{ Math.round(style.leftY * 100) }}%</span></label><label>字号 <input v-model.number="style.leftScale" type="range" min="0.6" max="1.6" step="0.05" /><span>{{ style.leftScale.toFixed(2) }}×</span></label></div>
          <div class="mv-side-control"><h4>右句</h4><label>横向位置 <input v-model.number="style.rightX" type="range" min="0.52" max="0.98" step="0.01" /><span>{{ Math.round(style.rightX * 100) }}%</span></label><label>纵向位置 <input v-model.number="style.rightY" type="range" min="0.08" max="0.88" step="0.01" /><span>{{ Math.round(style.rightY * 100) }}%</span></label><label>字号 <input v-model.number="style.rightScale" type="range" min="0.6" max="1.6" step="0.05" /><span>{{ style.rightScale.toFixed(2) }}×</span></label></div>
        </div>
        <div class="mv-style-grid mv-colors"><label>未唱颜色 <input v-model="style.beforeColor" type="color" /></label><label>扫过颜色 <input v-model="style.afterColor" type="color" /></label><label>描边颜色 <input v-model="style.outlineColor" type="color" /></label><label class="mv-check"><input v-model="style.showRomaji" type="checkbox" />显示罗马音</label></div>
      </div>
      <div class="mv-save-row"><button type="button" :disabled="saving" @click="saveSettings">{{ saving ? '保存中…' : '保存同步和样式' }}</button></div>

      <div class="mv-export"><div><h3>导出{{ layout === 'double' ? '双句 KTV 版' : '单句版' }}</h3><p>两种版本可分别生成并下载。先导出当前播放位置附近的短片检查效果，再导出完整 MV。</p></div><div class="mv-export-buttons"><button type="button" :disabled="project.render?.status === 'queued' || project.render?.status === 'running'" @click="exportVideo('preview')">导出 30 秒预览</button><button type="button" class="mv-primary" :disabled="project.render?.status === 'queued' || project.render?.status === 'running'" @click="exportVideo('full')">导出完整 MP4</button><button type="button" @click="downloadAss">下载 ASS 字幕</button></div>
        <div v-if="project.render" class="mv-progress"><strong>{{ project.render.layout === 'double' ? '双句 KTV 版' : '单句版' }}{{ project.render.kind === 'preview' ? '预览片段' : '完整视频' }}：{{ ({ queued: '排队中', running: '渲染中', failed: '导出失败', complete: '已完成' } as const)[project.render.status] }}</strong><span v-if="project.render.status === 'running'">{{ project.render.progress }}%</span><progress v-if="project.render.status === 'queued' || project.render.status === 'running'" :value="project.render.progress" max="100"></progress><p v-if="project.render.error">{{ project.render.error }}</p></div>
        <div class="mv-downloads"><template v-for="variant in (['single', 'double'] as const)" :key="variant"><span v-if="project.exportUrls[variant].preview || project.exportUrls[variant].full" class="mv-download-group"><strong>{{ variant === 'single' ? '单句版' : '双句 KTV 版' }}</strong><a v-if="project.exportUrls[variant].preview" :href="project.exportUrls[variant].preview!" download>下载预览 MP4</a><a v-if="project.exportUrls[variant].full" :href="project.exportUrls[variant].full!" download>下载完整 MP4</a></span></template></div>
      </div>
    </section>
    <section v-else class="mv-empty">上传一个 MV，即可在视频画面上预览逐字歌词。</section>
  </div>
</template>

<style scoped>
.mv-layout-picker{display:flex;align-items:center;gap:8px;margin:-4px 0 14px;flex-wrap:wrap}.mv-layout-picker button{border:1px solid #66587f;background:#242034;color:#d8cfed;border-radius:8px;padding:9px 14px;font-size:12px;font-weight:700;cursor:pointer}.mv-layout-picker button.active{background:#5b438e;border-color:#ad8eff;color:#fff}.mv-layout-picker span{color:#aaa0bd;font-size:11px;margin-left:5px}.mv-lyrics.mv-double{width:max-content;transform:none;white-space:nowrap}.mv-lyrics.mv-left{text-align:left}.mv-lyrics.mv-right{text-align:right}.mv-side-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:16px}.mv-side-control{border:1px solid #3f3655;background:#211d30;border-radius:10px;padding:14px;display:grid;gap:10px}.mv-side-control h4{margin:0;color:#d6c5f5;font-size:13px}.mv-side-control label{display:grid;grid-template-columns:70px minmax(0,1fr) 42px;align-items:center;gap:8px;color:#b5acc5;font-size:11px}.mv-side-control input{width:100%;accent-color:#ad8eff}.mv-side-control span{text-align:right;font-variant-numeric:tabular-nums}.mv-colors{margin-top:14px}.mv-download-group{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap}.mv-download-group strong{color:#d8cfed;font-size:11px}
.mv-countdown{position:absolute;left:0;bottom:calc(100% + 2px);display:flex;gap:calc(var(--jp-size) * .22);font-size:calc(var(--jp-size) * .7);line-height:1;color:#bdbdc4;text-shadow:0 1px 3px #000,1px 1px var(--outline),-1px -1px var(--outline)}.mv-right .mv-countdown{left:auto;right:0}.mv-countdown span.hidden{visibility:hidden}
.mv-studio{display:flex;flex-direction:column;gap:22px}.mv-card,.mv-library,.mv-empty{background:#151521;border:1px solid #2b293e;border-radius:20px;padding:25px;box-shadow:0 22px 60px #0002}.mv-section-head{display:flex;align-items:flex-start;gap:14px;margin-bottom:20px}.mv-section-head>div{flex:1}.mv-number{display:grid;place-items:center;width:34px;height:34px;flex:0 0 34px;border-radius:9px;background:#29223f;color:#bb9cff;font-size:12px;font-weight:800}.mv-section-head h2{margin:0;font-size:20px}.mv-section-head p{margin:6px 0 0;color:#9791ab;font-size:12px}.mv-alert{padding:12px 15px;border-radius:10px;display:flex;justify-content:space-between;font-size:13px}.mv-alert button{border:0;background:none;color:inherit;font-size:20px}.mv-error{background:#482535;color:#ffb6ca}.mv-notice{background:#213b36;color:#a4ebd0}.mv-upload{display:grid;gap:14px}.mv-file{min-height:95px;border:1px dashed #63577c;background:#211d30;border-radius:12px;display:flex;align-items:center;gap:12px;padding:16px;position:relative;overflow:hidden}.mv-file span{font-size:28px;color:#b596f8}.mv-file strong{font-size:14px}.mv-file small{color:#9189aa;font-size:11px;margin-left:auto}.mv-file input{position:absolute;inset:0;opacity:0;cursor:pointer}.mv-upload-controls{display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end}.mv-upload-controls label{display:grid;gap:6px;color:#a9a0bd;font-size:11px}.mv-upload-controls input,.mv-upload-controls select,.mv-offset-details input,.mv-offset-details select{width:100%;border:1px solid #47415d;border-radius:8px;background:#252236;color:#f3efff;padding:10px;font-size:12px}.mv-primary{border:0;border-radius:9px;background:linear-gradient(120deg,#a982ee,#826de5);color:white;padding:11px 17px;font-size:12px;font-weight:800;white-space:nowrap}.mv-primary:disabled{opacity:.55}.mv-library{padding:16px 20px}.mv-library-head{display:flex;align-items:center;justify-content:space-between;color:#aaa0bd}.mv-library h3{font-size:14px;margin:0 0 12px}.mv-library-head span{font-size:11px}.mv-project-list{display:flex;gap:8px;overflow:auto}.mv-project-list button{min-width:180px;max-width:230px;text-align:left;padding:10px 12px;border:1px solid #403850;border-radius:9px;background:#211e2e;color:#ddd3eb}.mv-project-list button.active{border-color:#ab88ef;background:#362a50}.mv-project-list strong,.mv-project-list small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mv-project-list strong{font-size:12px}.mv-project-list small{font-size:10px;color:#9990ad;margin-top:4px}.mv-delete{border:1px solid #644255;background:#30212e;color:#e8afbf;border-radius:8px;padding:8px 10px;font-size:11px}.mv-stage{position:relative;background:#090910;border-radius:14px;overflow:hidden;max-height:72vh;margin:auto}.mv-stage video{width:100%;height:100%;display:block;object-fit:contain}.mv-lyrics{position:absolute;left:50%;width:90%;transform:translate(-50%,-50%);text-align:center;pointer-events:none;line-height:1.16;filter:drop-shadow(0 2px 3px #000b)}.mv-jp{font-size:var(--jp-size);font-weight:800}.mv-roman{font-size:var(--roman-size);font-weight:700;margin-top:2px}.mv-unit{position:relative;display:inline-block;white-space:pre}.mv-base{color:var(--before);text-shadow:-1px -1px var(--outline),1px 1px var(--outline),-1px 1px var(--outline),1px -1px var(--outline)}.mv-fill{position:absolute;left:0;top:0;overflow:hidden;white-space:pre;color:var(--after);text-shadow:-1px -1px var(--outline),1px 1px var(--outline),-1px 1px var(--outline),1px -1px var(--outline)}.mv-preview-note{color:#8c84a0;font-size:11px;margin:9px 0 0}.mv-settings{border-top:1px solid #343045;padding-top:20px;margin-top:23px}.mv-settings h3,.mv-export h3{font-size:15px;margin:0 0 8px}.mv-settings p,.mv-export p{font-size:11px;color:#9c93ad;line-height:1.5;margin:0 0 15px}.mv-setting-title{display:flex;justify-content:space-between;align-items:center}.mv-setting-title button,.mv-save-row button,.mv-export-buttons button,.mv-export-buttons a,.mv-downloads a{border:1px solid #66557f;background:#2b2540;color:#e4d6fc;border-radius:8px;padding:9px 12px;font-size:11px;text-decoration:none;font-weight:700}.mv-offset{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:12px;color:#a79db8;font-size:11px}.mv-offset input{width:100%;accent-color:#ad8eff}.mv-offset-details{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}.mv-offset-details label{display:flex;align-items:center;gap:8px;font-size:11px;color:#a79db8}.mv-offset-details input{width:100px}.mv-offset-details select{width:125px}.mv-style-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.mv-style-grid label{display:flex;align-items:center;gap:9px;color:#b5acc5;font-size:11px}.mv-style-grid label input[type=range]{flex:1;min-width:40px;accent-color:#ad8eff}.mv-style-grid label input[type=color]{width:42px;height:30px;border:0;background:none;padding:0}.mv-style-grid span{width:39px;text-align:right;font-variant-numeric:tabular-nums}.mv-check input{accent-color:#ad8eff}.mv-save-row{text-align:right;margin-top:17px}.mv-export{border-top:1px solid #343045;margin-top:22px;padding-top:19px}.mv-export-buttons,.mv-downloads{display:flex;flex-wrap:wrap;gap:8px}.mv-export-buttons button.mv-primary{border:0;background:linear-gradient(120deg,#a982ee,#826de5);color:white}.mv-progress{margin-top:14px;padding:12px;background:#242034;border-radius:9px;color:#d9cdeb;font-size:11px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}.mv-progress progress{width:100%;accent-color:#ab86f0}.mv-progress p{color:#ffb6ca;margin:0;width:100%;word-break:break-word}.mv-downloads{margin-top:12px}.mv-empty{text-align:center;color:#958ba7;font-size:13px;padding:50px}
.mv-video-transport{display:flex;align-items:center;gap:10px;margin-top:12px;color:#b7acc9;font-size:11px}.mv-video-transport input{flex:1;min-width:0;accent-color:#ad8eff}.mv-video-transport button{border:1px solid #64557b;background:#2b2540;color:#eee2ff;border-radius:7px;padding:7px 10px;font-size:11px}.mv-video-transport span{font-variant-numeric:tabular-nums}
@media(max-width:750px){.mv-upload-controls{grid-template-columns:1fr}.mv-style-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.mv-side-controls{grid-template-columns:1fr}.mv-file{flex-wrap:wrap}.mv-file small{margin-left:0}.mv-card{padding:17px}}
@media(max-width:450px){.mv-style-grid{grid-template-columns:1fr}.mv-section-head{gap:9px}.mv-section-head h2{font-size:17px}.mv-stage{max-height:65vh}}
</style>
