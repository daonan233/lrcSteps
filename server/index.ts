import express from 'express'
import multer from 'multer'
import { parseFile } from 'music-metadata'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { promises as fs, createReadStream } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Request, Response } from 'express'
import { createLines, decodeLyrics, parseLrc } from './lyrics.js'
import { getNeteaseLyrics, parseNeteaseSongId } from './netease.js'
import { registerMvRoutes } from './mv-routes.js'
import type { LyricLine, Song, TimedUnit } from './types.js'

const root = process.cwd()
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data')
const audioDir = path.join(dataDir, 'audio')
const uploadsDir = path.join(dataDir, 'uploads')
const modelDir = path.join(dataDir, 'models')
const torchDir = path.join(modelDir, 'torch')
const app = express()
app.use(express.json({ limit: '2mb' }))
await Promise.all([audioDir, uploadsDir, modelDir, torchDir].map(dir => fs.mkdir(dir, { recursive: true })))
const database = new DatabaseSync(path.join(dataDir, 'songs.sqlite'))
database.exec('CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL)')
const findSong = database.prepare('SELECT payload FROM songs WHERE id = ?')
const listSongs = database.prepare('SELECT payload FROM songs ORDER BY created_at DESC')
const storeSong = database.prepare('INSERT INTO songs (id, created_at, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, payload = excluded.payload')
const removeSong = database.prepare('DELETE FROM songs WHERE id = ?')

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 200 * 1024 * 1024, files: 3 },
  fileFilter: (_request, file, callback) => {
    const allowed = file.fieldname === 'audio'
      ? /\.(mp3|m4a|wav|ogg|flac)$/i.test(file.originalname)
      : (file.fieldname === 'lyrics' || file.fieldname === 'romaji') && /\.(lrc|txt)$/i.test(file.originalname)
    callback(null, allowed)
  },
}).fields([{ name: 'audio', maxCount: 1 }, { name: 'lyrics', maxCount: 1 }, { name: 'romaji', maxCount: 1 }])

function validId(id: string): boolean { return /^[a-f0-9-]{36}$/.test(id) }
async function readSong(id: string): Promise<Song | null> {
  if (!validId(id)) return null
  const row = findSong.get(id) as { payload: string } | undefined
  return row ? JSON.parse(row.payload) as Song : null
}
async function saveSong(song: Song): Promise<void> {
  storeSong.run(song.id, song.createdAt, JSON.stringify(song))
}
const invalidateMvExports = await registerMvRoutes(app, database, dataDir, readSong)

function uploaded(request: Request, key: string): Express.Multer.File | undefined {
  return (request.files as Record<string, Express.Multer.File[]> | undefined)?.[key]?.[0]
}
function publicSong(song: Song): Omit<Song, 'audioFile'> & { audioUrl: string } {
  const { audioFile: _audioFile, ...rest } = song
  return { ...rest, audioUrl: `/api/songs/${song.id}/audio` }
}

app.get('/api/health', (_request, response) => response.json({ ok: true }))
app.post('/api/netease/lyrics', async (request, response) => {
  let id: string
  try { id = parseNeteaseSongId(String(request.body?.link ?? '')) }
  catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : '无效的歌曲链接' }) }
  try { return response.json(await getNeteaseLyrics(id)) }
  catch (error) { return response.status(502).json({ error: error instanceof Error ? error.message : '获取歌词失败' }) }
})
app.get('/api/songs', async (_request, response) => {
  const songs = (listSongs.all() as { payload: string }[]).map(row => JSON.parse(row.payload) as Song)
  response.json(songs.map(song => ({ ...publicSong(song), lines: undefined, lineCount: song.lines.length,
    manualCount: song.lines.filter(line => line.method === 'manual').length })))
})
app.get('/api/songs/:id', async (request, response) => {
  const song = await readSong(request.params.id)
  if (!song) return response.status(404).json({ error: '找不到歌曲' })
  response.json(publicSong(song))
})

app.patch('/api/songs/:id/lyrics-delay', async (request, response) => {
  const song = await readSong(request.params.id)
  if (!song) return response.status(404).json({ error: '找不到歌曲' })
  const delayMs = request.body?.delayMs
  if (!Number.isInteger(delayMs) || delayMs < -2000 || delayMs > 3000) {
    return response.status(400).json({ error: '歌词延迟需在 -2 到 +3 秒之间' })
  }
  song.lyricsDelayMs = delayMs
  await saveSong(song)
  invalidateMvExports(song.id)
  response.json(publicSong(song))
})

app.post('/api/songs', (request, response, next) => upload(request, response, async error => {
  if (error) return next(error)
  const files = Object.values(request.files as Record<string, Express.Multer.File[]> | undefined ?? {}).flat()
  const audio = uploaded(request, 'audio')
  const lyrics = uploaded(request, 'lyrics')
  try {
    if (!audio || !lyrics) throw new Error('请同时上传歌曲音频和日文 LRC')
    const rawLyrics = parseLrc(decodeLyrics(await fs.readFile(lyrics.path)))
    if (!rawLyrics.length) throw new Error('歌词文件没有找到有效的 [mm:ss.xx] 时间戳')
    const duration = await parseFile(audio.path, { duration: true }).then(metadata => metadata.format.duration).catch(() => undefined)
    if (duration && rawLyrics.some(line => line.start >= duration)) throw new Error('歌词时间戳超出了歌曲长度，请检查是否选错文件')
    const romanFile = uploaded(request, 'romaji')
    const rawRomaji = romanFile ? parseLrc(decodeLyrics(await fs.readFile(romanFile.path))) : []
    const id = randomUUID()
    const ext = path.extname(audio.originalname).toLowerCase()
    const audioFile = `${id}${ext}`
    const song: Song = {
      id,
      title: String(request.body.title || path.parse(audio.originalname).name).trim().slice(0, 120),
      artist: String(request.body.artist || '').trim().slice(0, 120),
      audioFile,
      originalAudioName: audio.originalname,
      createdAt: new Date().toISOString(),
      status: 'queued',
      lines: createLines(rawLyrics, rawRomaji, duration),
    }
    await fs.rename(audio.path, path.join(audioDir, audioFile))
    await saveSong(song)
    response.status(201).json(publicSong(song))
    enqueueAlignment(id)
  } catch (failure) {
    response.status(400).json({ error: failure instanceof Error ? failure.message : '上传失败' })
  } finally {
    await Promise.all(files.map(file => fs.rm(file.path, { force: true }).catch(() => undefined)))
  }
}))

app.get('/api/songs/:id/audio', async (request, response) => {
  const song = await readSong(request.params.id)
  if (!song) return response.status(404).end()
  const target = path.join(audioDir, song.audioFile)
  let stat
  try { stat = await fs.stat(target) } catch { return response.status(404).end() }
  const ext = path.extname(target)
  const mime: Record<string, string> = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac' }
  response.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream')
  response.setHeader('Accept-Ranges', 'bytes')
  const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '')
  if (!match) {
    response.setHeader('Content-Length', stat.size)
    return createReadStream(target).pipe(response)
  }
  const suffix = !match[1]
  const start = suffix ? Math.max(0, stat.size - Number(match[2])) : Number(match[1])
  const end = suffix ? stat.size - 1 : Math.min(stat.size - 1, match[2] ? Number(match[2]) : stat.size - 1)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
    response.setHeader('Content-Range', `bytes */${stat.size}`)
    return response.status(416).end()
  }
  response.status(206)
  response.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
  response.setHeader('Content-Length', end - start + 1)
  createReadStream(target, { start, end }).pipe(response)
})

app.put('/api/songs/:id/lines/:lineId', async (request, response) => {
  const song = await readSong(request.params.id)
  if (!song) return response.status(404).json({ error: '找不到歌曲' })
  const line = song.lines.find(item => item.id === request.params.lineId)
  if (!line) return response.status(404).json({ error: '找不到歌词行' })
  const units = request.body.units as TimedUnit[]
  const romajiUnits = request.body.romajiUnits as TimedUnit[] | undefined
  const remainingRomaji = Array.isArray(romajiUnits) && romajiUnits.every(unit => unit && typeof unit.text === 'string')
    ? romajiUnits.map(unit => unit.text).join('') : ''
  if (!validateUnits(units, line.text)
    || (romajiUnits !== undefined && (remainingRomaji.length > 300 || !validateUnits(romajiUnits, remainingRomaji)))) {
    return response.status(400).json({ error: '时间轴无效：请检查逐字时间和罗马音内容' })
  }
  line.units = units
  if (romajiUnits !== undefined) {
    line.romaji = remainingRomaji || undefined
    line.romajiUnits = romajiUnits?.length ? romajiUnits : undefined
  }
  line.method = 'manual'
  line.confidence = 1
  line.start = Math.min(...units.map(unit => unit.start))
  line.end = Math.max(...units.map(unit => unit.end))
  await saveSong(song)
  invalidateMvExports(song.id)
  response.json(publicSong(song))
})

app.delete('/api/songs/:id/lines/:lineId', async (request, response) => {
  const song = await readSong(request.params.id)
  if (!song) return response.status(404).json({ error: '找不到歌曲' })
  if (song.status === 'queued' || song.status === 'processing') {
    return response.status(409).json({ error: '自动校时进行中，请完成后再删除歌词行' })
  }
  const index = song.lines.findIndex(line => line.id === request.params.lineId)
  if (index === -1) return response.status(404).json({ error: '找不到歌词行' })
  song.lines.splice(index, 1)
  await saveSong(song)
  invalidateMvExports(song.id)
  response.json(publicSong(song))
})

app.post('/api/songs/:id/lines/:lineId/align', async (request, response) => {
  const song = await readSong(request.params.id)
  if (!song) return response.status(404).json({ error: '找不到歌曲' })
  const line = song.lines.find(item => item.id === request.params.lineId)
  if (!line) return response.status(404).json({ error: '找不到歌词行' })
  const lane = request.body.lane as 'japanese' | 'romaji' | undefined
  const units = request.body.units as TimedUnit[] | undefined
  const romajiUnits = request.body.romajiUnits as TimedUnit[] | undefined
  const romaji = Array.isArray(romajiUnits) && romajiUnits.every(unit => unit && typeof unit.text === 'string')
    ? romajiUnits.map(unit => unit.text).join('') : ''
  if ((lane !== 'japanese' && lane !== 'romaji') || (lane === 'romaji' && !romajiUnits?.length)
    || !validateUnits(units, line.text)
    || (romajiUnits !== undefined && (romaji.length > 300 || !validateUnits(romajiUnits, romaji)))) {
    return response.status(400).json({ error: '当前歌词无效，请检查罗马音文字和时间后重试' })
  }
  const searchUnits = lane === 'romaji' ? romajiUnits! : units
  const input = path.join(uploadsDir, `${randomUUID()}-line-input.json`)
  const output = path.join(uploadsDir, `${randomUUID()}-line-output.json`)
  try {
    const result = await scheduleAlignment(async () => {
      const currentLine = {
        ...line,
        start: Math.min(...searchUnits.map(unit => unit.start)),
        end: Math.max(...searchUnits.map(unit => unit.end)),
        romaji: romaji || undefined,
      }
      const nextLine = song.lines[song.lines.findIndex(item => item.id === line.id) + 1]
      const following = nextLine && nextLine.start - currentLine.end <= 2
        && nextLine.end > currentLine.end && nextLine.end - currentLine.start <= 20 ? nextLine : undefined
      await fs.writeFile(input, JSON.stringify({
        audio: path.join(audioDir, song.audioFile), lines: [currentLine], singleLine: true,
        following: following ? { text: following.text, end: following.end } : undefined,
      }), 'utf8')
      await runWorker(input, output)
      return JSON.parse(await fs.readFile(output, 'utf8')) as { lines: AlignedLine[]; warning?: string }
    })
    const aligned = result.lines.find(item => item.index === 0)
    if (!aligned || (!validateUnits(aligned.units, line.text) && (!romaji || !validateUnits(aligned.romajiUnits, romaji)))) {
      return response.status(422).json({ error: '本句未能自动对齐，请继续用滑轨手动调整' })
    }
    response.json({
      units: validateUnits(aligned.units, line.text) ? aligned.units : undefined,
      romajiUnits: romaji && validateUnits(aligned.romajiUnits, romaji) ? aligned.romajiUnits : undefined,
      warning: result.warning,
    })
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : '本句校时失败' })
  } finally {
    await Promise.all([input, output].map(file => fs.rm(file, { force: true }).catch(() => undefined)))
  }
})

app.post('/api/songs/:id/retry', async (request, response) => {
  const song = await readSong(request.params.id)
  if (!song) return response.status(404).json({ error: '找不到歌曲' })
  if (song.status === 'queued' || song.status === 'processing') return response.status(409).json({ error: '正在处理' })
  song.status = 'queued'
  song.alignmentMode = 'lrc'
  song.error = undefined
  await saveSong(song)
  enqueueAlignment(song.id)
  response.json(publicSong(song))
})

app.post('/api/songs/:id/align-romaji', async (request, response) => {
  const song = await readSong(request.params.id)
  if (!song) return response.status(404).json({ error: '找不到歌曲' })
  if (song.status === 'queued' || song.status === 'processing') return response.status(409).json({ error: '正在处理' })
  const missing = song.lines.filter(line => !/[a-z]/i.test((line.romaji || line.text).normalize('NFKD')))
  if (missing.length) return response.status(400).json({ error: `有 ${missing.length} 句缺少罗马音，请先补齐后重试` })
  song.status = 'queued'
  song.alignmentMode = 'romaji'
  song.error = undefined
  await saveSong(song)
  enqueueRomajiAlignment(song.id)
  response.json(publicSong(song))
})

app.delete('/api/songs/:id', async (request, response) => {
  const song = await readSong(request.params.id)
  if (!song) return response.status(404).json({ error: '找不到歌曲' })
  await fs.rm(path.join(audioDir, song.audioFile), { force: true })
  removeSong.run(song.id)
  response.status(204).end()
})

function validateUnits(units: TimedUnit[] | undefined, text: string): units is TimedUnit[] {
  if (!Array.isArray(units) || units.length > 500 || units.some(unit => !unit || typeof unit.text !== 'string') || units.map(unit => unit.text).join('') !== text) return false
  return units.every((unit, index) =>
    Number.isFinite(unit.start) && Number.isFinite(unit.end) && unit.start >= 0 && unit.end > unit.start
    && (index === 0 || unit.start >= units[index - 1].start))
}
interface AlignedLine { index: number; start?: number; end?: number; units?: TimedUnit[]; romajiUnits?: TimedUnit[]; confidence: number; method: 'aligned' | 'estimated' }
let queue: Promise<void> = Promise.resolve()
function scheduleAlignment<T>(task: () => Promise<T>): Promise<T> {
  const job = queue.then(task)
  queue = job.then(() => undefined, () => undefined)
  return job
}
function enqueueAlignment(id: string): void {
  void scheduleAlignment(() => runAlignment(id)).catch(error => console.error('Alignment job failed:', error))
}
function enqueueRomajiAlignment(id: string): void {
  void scheduleAlignment(() => runRomajiAlignment(id)).catch(error => console.error('Romaji alignment job failed:', error))
}
async function runRomajiAlignment(id: string): Promise<void> {
  let song = await readSong(id)
  if (!song) return
  song.status = 'processing'
  await saveSong(song)
  const lineSnapshot = JSON.stringify(song.lines)
  const input = path.join(uploadsDir, `${id}-romaji-${randomUUID()}-input.json`)
  const output = path.join(uploadsDir, `${id}-romaji-${randomUUID()}-output.json`)
  try {
    await fs.writeFile(input, JSON.stringify({ mode: 'romaji_global', audio: path.join(audioDir, song.audioFile), lines: song.lines }), 'utf8')
    await runWorker(input, output)
    const result = JSON.parse(await fs.readFile(output, 'utf8')) as { lines: AlignedLine[]; warning?: string }
    song = await readSong(id)
    if (!song) return
    if (JSON.stringify(song.lines) !== lineSnapshot) {
      throw new Error('校时期间歌词被修改，已保留新修改；请重新点击罗马音全曲校时')
    }
    if (result.lines.length !== song.lines.length || result.lines.some((item, index) => {
      const line = song!.lines[index]
      return item.index !== index || !Number.isFinite(item.start) || !Number.isFinite(item.end)
        || item.end! <= item.start! || !validateUnits(item.units, line.text)
        || (line.romaji && !validateUnits(item.romajiUnits, line.romaji))
    })) throw new Error('全曲校时结果不完整，已保留原时间')
    const backupDir = path.join(dataDir, 'backups')
    await fs.mkdir(backupDir, { recursive: true })
    await fs.writeFile(path.join(backupDir, `${id}-before-romaji-${Date.now()}.json`), JSON.stringify(song), 'utf8')
    for (const item of result.lines) {
      const line = song.lines[item.index]
      line.start = item.start!
      line.end = item.end!
      line.units = item.units!
      if (line.romaji) line.romajiUnits = item.romajiUnits!
      line.confidence = Math.max(0, Math.min(1, item.confidence))
      if (line.method !== 'manual') line.method = item.method
    }
    song.status = song.lines.some(line => line.method === 'estimated' || (line.confidence ?? 0) < 0.55) ? 'needs-review' : 'ready'
    song.error = result.warning
    await saveSong(song)
    invalidateMvExports(song.id)
  } catch (error) {
    song = await readSong(id)
    if (song) {
      song.status = 'needs-review'
      song.error = error instanceof Error ? error.message : '罗马音全曲校时失败'
      await saveSong(song)
    }
  } finally {
    await Promise.all([input, output].map(file => fs.rm(file, { force: true }).catch(() => undefined)))
  }
}
async function runAlignment(id: string): Promise<void> {
  let song = await readSong(id)
  if (!song) return
  song.status = 'processing'
  await saveSong(song)
  const input = path.join(uploadsDir, `${id}-input.json`)
  const output = path.join(uploadsDir, `${id}-output.json`)
  try {
    await fs.writeFile(input, JSON.stringify({ audio: path.join(audioDir, song.audioFile), lines: song.lines }), 'utf8')
    await runWorker(input, output)
    const result = JSON.parse(await fs.readFile(output, 'utf8')) as { lines: AlignedLine[]; warning?: string }
    song = await readSong(id)
    if (!song) return
    for (const item of result.lines) {
      const line = song.lines[item.index]
      if (!line || line.method === 'manual') continue
      if (!validateUnits(item.units, line.text)) continue
      line.units = item.units
      if (line.romaji && validateUnits(item.romajiUnits, line.romaji)) line.romajiUnits = item.romajiUnits
      line.confidence = Math.max(0, Math.min(1, item.confidence))
      line.method = item.method
    }
    song.status = song.lines.some(line => line.method === 'estimated' || (line.confidence ?? 0) < 0.55) ? 'needs-review' : 'ready'
    song.error = result.warning
    await saveSong(song)
    invalidateMvExports(song.id)
  } catch (error) {
    song = await readSong(id)
    if (song) {
      song.status = 'needs-review'
      song.error = error instanceof Error ? error.message : '自动校时失败'
      await saveSong(song)
    }
  } finally {
    await Promise.all([input, output].map(file => fs.rm(file, { force: true }).catch(() => undefined)))
  }
}

function runWorker(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON_CMD || 'python', [path.join(root, 'worker', 'align.py'), input, output], {
      cwd: root,
      env: { ...process.env, HF_HOME: process.env.HF_HOME || modelDir, TORCH_HOME: process.env.TORCH_HOME || torchDir },
      windowsHide: true,
    })
    let errors = ''
    child.stderr.on('data', chunk => { errors = (errors + String(chunk)).slice(-4000) })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) return resolve()
      const message = errors.match(/ALIGN_ERROR:([^\r\n]+)/)?.[1]
      reject(new Error(message || `校时进程退出：${code}`))
    })
  })
}

app.use((error: Error, _request: Request, response: Response, _next: express.NextFunction) => {
  response.status(400).json({ error: error.message })
})

const staticDir = path.join(root, 'dist')
app.use(express.static(staticDir))
app.get('/{*path}', (_request, response) => response.sendFile(path.join(staticDir, 'index.html')))

const port = Number(process.env.PORT || 3001)
app.listen(port, () => console.log(`KTV API listening at http://localhost:${port}`))
for (const row of listSongs.all() as { payload: string }[]) {
  const song = JSON.parse(row.payload) as Song
  if (song && (song.status === 'queued' || song.status === 'processing')) {
    if (song.alignmentMode === 'romaji') enqueueRomajiAlignment(song.id)
    else enqueueAlignment(song.id)
  }
}
