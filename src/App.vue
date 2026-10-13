<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { LyricLine, Song, TimedUnit } from './types'

interface ImportedLyrics { id: string; japanese: string; romaji: string | null }

const songs = ref<Song[]>([])
const selected = ref<Song | null>(null)
const audio = ref<HTMLAudioElement | null>(null)
const audioFile = ref<File | null>(null)
const lyricFile = ref<File | null>(null)
const romajiFile = ref<File | null>(null)
const title = ref('')
const artist = ref('')
const shareLink = ref('')
const importingLyrics = ref(false)
const importedLyrics = ref<ImportedLyrics | null>(null)
const uploading = ref(false)
const error = ref('')
const notice = ref('')
const currentTime = ref(0)
const duration = ref(0)
const playing = ref(false)
const volume = ref(0.8)
const editor = ref<LyricLine | null>(null)
const saving = ref(false)
let frame = 0
let poller: ReturnType<typeof setInterval> | undefined

const activeIndex = computed(() => selected.value?.lines.findLastIndex(line => currentTime.value >= line.start) ?? -1)
const activeLine = computed(() => selected.value?.lines[activeIndex.value])
const previousLine = computed(() => selected.value?.lines[activeIndex.value - 1])
const nextLine = computed(() => selected.value?.lines[activeIndex.value + 1] ?? selected.value?.lines[0])
const reviewCount = computed(() => selected.value?.lines.filter(line => line.method === 'estimated' || (line.confidence ?? 0) < 0.55).length ?? 0)

function unitProgress(unit: TimedUnit): number {
  return Math.max(0, Math.min(100, (currentTime.value - unit.start) / Math.max(0.01, unit.end - unit.start) * 100))
}
function formatTime(value: number): string {
  if (!Number.isFinite(value)) return '00:00'
  const minutes = Math.floor(value / 60).toString().padStart(2, '0')
  const seconds = Math.floor(value % 60).toString().padStart(2, '0')
  return `${minutes}:${seconds}`
}
function statusText(song: Song): string {
  return ({ queued: '等待校时', processing: '正在自动校时', ready: '已完成', 'needs-review': '可播放 · 待检查', failed: '处理失败' })[song.status]
}
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, options)
  } catch {
    throw new Error('请求未能完成，可能是连接中断或浏览器阻止了本地请求。请重试；若仍失败，请检查文件大小和本地服务状态。')
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `请求失败（${response.status}）`)
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}
async function importNeteaseLyrics(): Promise<void> {
  if (!shareLink.value.trim()) { error.value = '请先粘贴网易云音乐歌曲分享链接'; return }
  importingLyrics.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await api<ImportedLyrics>('/api/netease/lyrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link: shareLink.value }),
    })
    lyricFile.value = new File([result.japanese], `${result.id}-日文.lrc`, { type: 'text/plain;charset=utf-8' })
    romajiFile.value = result.romaji
      ? new File([result.romaji], `${result.id}-罗马音.lrc`, { type: 'text/plain;charset=utf-8' })
      : null
    importedLyrics.value = result
    for (const field of document.querySelectorAll<HTMLInputElement>('input[type=file]')) {
      if (field.accept.includes('.lrc')) field.value = ''
    }
    notice.value = result.romaji
      ? '已获取日文和罗马音 LRC，选好歌曲音频后即可上传。'
      : '已获取日文 LRC；这首歌的接口没有返回罗马音，可自行上传罗马音文件。'
  } catch (failure) { error.value = String(failure instanceof Error ? failure.message : failure) }
  finally { importingLyrics.value = false }
}
function downloadImported(kind: 'japanese' | 'romaji'): void {
  const result = importedLyrics.value
  const content = result?.[kind]
  if (!result || !content) return
  const name = `${result.id}-${kind === 'japanese' ? '日文' : '罗马音'}.lrc`
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function loadSongs(): Promise<void> {
  songs.value = await api<Song[]>('/api/songs')
  if (selected.value) {
    const listing = songs.value.find(song => song.id === selected.value?.id)
    if (!listing) selected.value = null
    else if (listing.status !== selected.value.status || listing.status === 'processing') {
      selected.value = await api<Song>(`/api/songs/${listing.id}`)
    }
  }
}
async function selectSong(id: string): Promise<void> {
  error.value = ''
  selected.value = await api<Song>(`/api/songs/${id}`)
  currentTime.value = 0
  playing.value = false
  await nextTick()
  audio.value?.load()
}
async function uploadSong(): Promise<void> {
  if (!audioFile.value || !lyricFile.value) { error.value = '请先选择音频和日文 LRC'; return }
  uploading.value = true
  error.value = ''
  notice.value = ''
  const form = new FormData()
  form.append('audio', audioFile.value)
  form.append('lyrics', lyricFile.value)
  if (romajiFile.value) form.append('romaji', romajiFile.value)
  form.append('title', title.value)
  form.append('artist', artist.value)
  try {
    const song = await api<Song>('/api/songs', { method: 'POST', body: form })
    await loadSongs()
    await selectSong(song.id)
    audioFile.value = null
    lyricFile.value = null
    romajiFile.value = null
    importedLyrics.value = null
    shareLink.value = ''
    title.value = ''
    artist.value = ''
    for (const field of document.querySelectorAll<HTMLInputElement>('input[type=file]')) field.value = ''
    notice.value = '上传成功，自动校时正在后台进行。现在可以先播放行级预览。'
  } catch (failure) { error.value = String(failure instanceof Error ? failure.message : failure) }
  finally { uploading.value = false }
}
function pickFile(event: Event, key: 'audio' | 'lyrics' | 'romaji'): void {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null
  if (key === 'audio') {
    audioFile.value = file
    if (file && !title.value) title.value = file.name.replace(/\.[^.]+$/, '')
  }
  if (key === 'lyrics') { lyricFile.value = file; importedLyrics.value = null }
  if (key === 'romaji') { romajiFile.value = file; importedLyrics.value = null }
}
async function togglePlay(): Promise<void> {
  if (!audio.value) return
  if (audio.value.paused) {
    try { await audio.value.play() } catch { error.value = '浏览器无法播放这个音频格式' }
  } else audio.value.pause()
}
function seek(event: Event): void { if (audio.value) audio.value.currentTime = Number((event.target as HTMLInputElement).value) }
function setVolume(event: Event): void { volume.value = Number((event.target as HTMLInputElement).value); if (audio.value) audio.value.volume = volume.value }
function syncClock(): void {
  if (audio.value) currentTime.value = audio.value.currentTime
  frame = requestAnimationFrame(syncClock)
}
function onMetadata(): void {
  duration.value = audio.value?.duration || 0
  if (audio.value) audio.value.volume = volume.value
}
function openEditor(line: LyricLine): void { editor.value = structuredClone(line); error.value = '' }
function shiftUnit(units: TimedUnit[], index: number, field: 'start' | 'end', event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) units[index][field] = value
}
async function saveEditor(): Promise<void> {
  if (!selected.value || !editor.value) return
  saving.value = true
  error.value = ''
  try {
    selected.value = await api<Song>(`/api/songs/${selected.value.id}/lines/${editor.value.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ units: editor.value.units, romajiUnits: editor.value.romajiUnits }),
    })
    editor.value = null
    await loadSongs()
  } catch (failure) { error.value = String(failure instanceof Error ? failure.message : failure) }
  finally { saving.value = false }
}
async function retryAlignment(): Promise<void> {
  if (!selected.value) return
  try {
    selected.value = await api<Song>(`/api/songs/${selected.value.id}/retry`, { method: 'POST' })
    await loadSongs()
  } catch (failure) { error.value = String(failure instanceof Error ? failure.message : failure) }
}
async function deleteSong(): Promise<void> {
  if (!selected.value || !confirm(`删除「${selected.value.title}」及其音频文件？`)) return
  await api<void>(`/api/songs/${selected.value.id}`, { method: 'DELETE' })
  selected.value = null
  await loadSongs()
}
function jumpTo(line: LyricLine): void { if (audio.value) audio.value.currentTime = line.start }
watch(() => selected.value?.id, () => { editor.value = null })
onMounted(async () => {
  try { await loadSongs() } catch { error.value = '无法连接服务器，请确认 Node.js 服务已启动。' }
  poller = setInterval(() => { if (songs.value.some(song => ['queued', 'processing'].includes(song.status))) loadSongs().catch(() => undefined) }, 2500)
  frame = requestAnimationFrame(syncClock)
})
onUnmounted(() => { if (poller) clearInterval(poller); cancelAnimationFrame(frame) })
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">◉</span><div><strong>声刻</strong><small>YOUR KARAOKE SPACE</small></div></div>
      <div class="side-heading"><span>我的曲库</span><span class="count">{{ songs.length }}</span></div>
      <div class="song-list">
        <button v-for="song in songs" :key="song.id" class="song-item" :class="{ selected: selected?.id === song.id }" @click="selectSong(song.id)">
          <span class="song-icon">♫</span>
          <span class="song-copy"><strong>{{ song.title }}</strong><small>{{ song.artist || '未知歌手' }} · {{ song.lineCount }} 行</small></span>
          <span v-if="song.status === 'processing' || song.status === 'queued'" class="small-spinner"></span>
        </button>
        <p v-if="!songs.length" class="empty-list">还没有歌曲。上传第一首，开始制作自己的 KTV。</p>
      </div>
      <div class="side-footer">本地保存 · 日文歌词优先</div>
    </aside>

    <main class="main-content">
      <header class="topbar"><div><span class="eyebrow">KARAOKE STUDIO</span><h1>让每一句歌词，都跟上你的节奏。</h1></div><span class="top-pill">✦ 自动逐字校时</span></header>
      <div v-if="error" class="alert error">{{ error }} <button @click="error = ''">×</button></div>
      <div v-if="notice" class="alert notice">{{ notice }} <button @click="notice = ''">×</button></div>

      <section class="upload-card">
        <div class="section-title"><span class="section-number">01</span><div><h2>添加一首歌</h2><p>上传音频和普通 LRC，系统会自动估计逐字时间。</p></div></div>
        <form class="upload-form" @submit.prevent="uploadSong">
          <div class="netease-import">
            <div class="netease-heading"><strong>从网易云获取歌词</strong><span>粘贴歌曲分享链接，自动填入日文歌词和可用的罗马音</span></div>
            <div class="netease-controls"><input v-model="shareLink" type="text" aria-label="网易云歌曲分享链接" placeholder="https://music.163.com/#/song?id=..." @keydown.enter.prevent="importNeteaseLyrics" /><button class="ghost-button" type="button" :disabled="importingLyrics || uploading" @click="importNeteaseLyrics">{{ importingLyrics ? '获取中…' : '获取歌词' }}</button></div>
            <div v-if="importedLyrics" class="netease-result"><span>已填入日文 LRC{{ importedLyrics.romaji ? '和罗马音 LRC' : ' · 无罗马音' }}</span><button type="button" @click="downloadImported('japanese')">下载日文 LRC</button><button v-if="importedLyrics.romaji" type="button" @click="downloadImported('romaji')">下载罗马音 LRC</button></div>
          </div>
          <div class="file-fields">
            <label class="file-field"><span class="file-symbol">♫</span><span><strong>歌曲音频</strong><small>{{ audioFile?.name || 'MP3、M4A、WAV、OGG、FLAC' }}</small></span><input type="file" accept=".mp3,.m4a,.wav,.ogg,.flac,audio/*" @change="pickFile($event, 'audio')" /></label>
            <label class="file-field"><span class="file-symbol">文</span><span><strong>日文歌词 <em>必填</em></strong><small>{{ lyricFile?.name || '普通 .lrc 文件' }}</small></span><input type="file" accept=".lrc,.txt" @change="pickFile($event, 'lyrics')" /></label>
            <label class="file-field optional"><span class="file-symbol">R</span><span><strong>罗马音 <em>可选</em></strong><small>{{ romajiFile?.name || '有的话一起上传 .lrc' }}</small></span><input type="file" accept=".lrc,.txt" @change="pickFile($event, 'romaji')" /></label>
          </div>
          <div class="form-bottom"><div class="text-fields"><input v-model="title" placeholder="歌曲名称" maxlength="120" /><input v-model="artist" placeholder="歌手（可选）" maxlength="120" /></div><button class="primary-button" type="submit" :disabled="uploading">{{ uploading ? '上传中…' : '上传并自动校时' }} <span>↗</span></button></div>
        </form>
      </section>

      <section v-if="selected" class="player-section">
        <div class="section-title player-title"><span class="section-number">02</span><div><h2>{{ selected.title }}</h2><p>{{ selected.artist || '未知歌手' }} <span class="separator">/</span> {{ statusText(selected) }}</p></div><div class="player-actions"><button v-if="selected.status === 'needs-review'" class="ghost-button" @click="retryAlignment">重新校时</button><button class="ghost-button danger" @click="deleteSong">删除</button></div></div>
        <div v-if="selected.error" class="process-note">{{ selected.error }}</div>
        <div class="stage">
          <div class="stage-glow"></div>
          <div class="stage-top"><span>NOW PLAYING</span><span>{{ String(Math.max(0, activeIndex + 1)).padStart(2, '0') }} / {{ String(selected.lines.length).padStart(2, '0') }}</span></div>
          <div class="lyric-stage">
            <p class="stage-previous">{{ previousLine?.text || '♪' }}</p>
            <div v-if="activeLine" class="active-lyrics">
              <div class="jp-line" aria-label="当前日文歌词"><span v-for="(unit, index) in activeLine.units" :key="index" class="karaoke-unit"><span class="base-text">{{ unit.text }}</span><span class="fill-text" :style="{ width: `${unitProgress(unit)}%` }">{{ unit.text }}</span></span></div>
              <div v-if="activeLine.romajiUnits?.length" class="romaji-line"><span v-for="(unit, index) in activeLine.romajiUnits" :key="index" class="karaoke-unit"><span class="base-text">{{ unit.text }}</span><span class="fill-text" :style="{ width: `${unitProgress(unit)}%` }">{{ unit.text }}</span></span></div>
            </div>
            <p v-else class="stage-placeholder">音乐即将开始…</p>
            <p class="stage-next">{{ nextLine?.text || '♪' }}</p>
          </div>
          <div class="stage-bottom"><span class="live-dot"></span><span>{{ selected.status === 'processing' ? '正在分析人声与歌词' : '跟着节奏，一起唱' }}</span><span v-if="activeLine" class="method-pill">{{ activeLine.method === 'manual' ? '手动校正' : activeLine.method === 'aligned' ? '声学校时' : '时间估算' }}</span></div>
        </div>
        <audio ref="audio" :src="selected.audioUrl" preload="metadata" @loadedmetadata="onMetadata" @play="playing = true" @pause="playing = false" @ended="playing = false" />
        <div class="controls"><button class="play-button" :aria-label="playing ? '暂停' : '播放'" @click="togglePlay">{{ playing ? '❚❚' : '▶' }}</button><span class="time">{{ formatTime(currentTime) }}</span><input class="seek" type="range" min="0" :max="duration || 1" step="0.01" :value="currentTime" :style="{ '--progress': `${duration ? currentTime / duration * 100 : 0}%` }" @input="seek" /><span class="time">{{ formatTime(duration) }}</span><span class="volume-icon">◖</span><input class="volume" type="range" min="0" max="1" step="0.01" :value="volume" @input="setVolume" /></div>
        <div class="timeline-head"><div><h3>歌词时间轴</h3><p>点击一行跳转播放；点“调整”修改字级时间。</p></div><span v-if="reviewCount" class="review-badge">{{ reviewCount }} 行建议检查</span></div>
        <div class="timeline">
          <div v-for="line in selected.lines" :key="line.id" class="timeline-row" :class="{ current: activeLine?.id === line.id, unsure: line.method === 'estimated' || (line.confidence ?? 0) < 0.55 }">
            <button class="line-time" @click="jumpTo(line)">{{ formatTime(line.start) }}</button><div class="line-copy" @click="jumpTo(line)"><strong>{{ line.text }}</strong><small v-if="line.romaji">{{ line.romaji }}</small></div><span class="line-method">{{ line.method === 'manual' ? '已校正' : line.method === 'aligned' ? '自动对齐' : '估算' }}</span><button class="edit-button" @click="openEditor(line)">调整</button>
          </div>
        </div>
      </section>
      <section v-else class="welcome-card"><span>✦</span><h2>选择一首歌，进入你的舞台</h2><p>上传歌曲后，自动校时会在后台运行。处理过程中也能先预览歌词。</p></section>
    </main>

    <div v-if="editor" class="modal-backdrop" @click.self="editor = null"><div class="editor-modal"><div class="modal-head"><div><span class="eyebrow">TIMING EDITOR</span><h2>调整逐字时间</h2><p>{{ editor.text }}</p></div><button class="close-button" @click="editor = null">×</button></div><p class="editor-help">时间单位为秒。先点击时间轴上的时间播放这一句，再修改偏差明显的字。</p><div class="editor-scroll"><div class="editor-group"><h3>日文歌词</h3><div v-for="(unit, index) in editor.units" :key="index" class="editor-row"><span class="editor-char">{{ unit.text }}</span><label>开始 <input type="number" min="0" step="0.01" :value="unit.start" @change="shiftUnit(editor.units, index, 'start', $event)" /></label><label>结束 <input type="number" min="0" step="0.01" :value="unit.end" @change="shiftUnit(editor.units, index, 'end', $event)" /></label></div></div><div v-if="editor.romajiUnits" class="editor-group"><h3>罗马音</h3><div v-for="(unit, index) in editor.romajiUnits" :key="index" class="editor-row"><span class="editor-char">{{ unit.text === ' ' ? '␣' : unit.text }}</span><label>开始 <input type="number" min="0" step="0.01" :value="unit.start" @change="shiftUnit(editor.romajiUnits!, index, 'start', $event)" /></label><label>结束 <input type="number" min="0" step="0.01" :value="unit.end" @change="shiftUnit(editor.romajiUnits!, index, 'end', $event)" /></label></div></div></div><div class="modal-actions"><button class="ghost-button" @click="editor = null">取消</button><button class="primary-button" :disabled="saving" @click="saveEditor">{{ saving ? '保存中…' : '保存校时' }}</button></div></div></div>
  </div>
</template>
