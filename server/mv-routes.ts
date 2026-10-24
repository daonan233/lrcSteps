import type { Application, Request, Response } from 'express'
import multer from 'multer'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultMvStyle, estimateAudioOffset, generateAss, pcmEnergy, validMvStyle, type MvLayout, type MvOutput, type MvProject } from './mv.js'
import type { Song } from './types.js'

const uuid = /^[a-f0-9-]{36}$/
const rendererVersion = 1

function ffmpegPath(root: string): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH
  for (const directory of [
    path.join(root, '.venv', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries'),
    path.join(root, 'worker', 'vendor', 'imageio_ffmpeg', 'binaries'),
  ]) {
    if (!existsSync(directory)) continue
    const binary = readdirSync(directory).find(name => /^ffmpeg.*\.exe$/i.test(name))
    if (binary) return path.join(directory, binary)
  }
  return 'ffmpeg'
}

function runCapture(binary: string, args: string[], limit = 8 * 1024 * 1024): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true })
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) { child.kill(); reject(new Error('FFmpeg 输出超过安全限制')); return }
      chunks.push(chunk)
    })
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-12000) })
    child.on('error', () => reject(new Error('找不到 FFmpeg。请安装 FFmpeg 或设置 FFMPEG_PATH。')))
    child.on('close', code => resolve({ stdout: Buffer.concat(chunks), stderr, code: code ?? -1 }))
  })
}

async function probeVideo(binary: string, file: string): Promise<{ duration: number; width: number; height: number }> {
  const result = await runCapture(binary, ['-hide_banner', '-i', file], 1024)
  const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(result.stderr)
  const videoLine = result.stderr.split(/\r?\n/).find(line => line.includes('Video:')) ?? ''
  const dimensions = /(?:^|[, ])(\d{2,5})x(\d{2,5})(?:[ ,]|$)/.exec(videoLine)
  if (!durationMatch || !dimensions) throw new Error('无法读取 MV 的视频轨或时长，请使用常见的 MP4、MOV、WebM 视频')
  const duration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
  if (!Number.isFinite(duration) || duration < 1 || duration > 4 * 3600) throw new Error('MV 时长须在 1 秒到 4 小时之间')
  return { duration, width: Number(dimensions[1]), height: Number(dimensions[2]) }
}

async function streamFile(request: Request, response: Response, file: string, mime: string, downloadName?: string): Promise<void> {
  let stat
  try { stat = await fs.stat(file) } catch { response.status(404).end(); return }
  response.setHeader('Content-Type', mime)
  response.setHeader('Accept-Ranges', 'bytes')
  if (downloadName) response.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`)
  const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '')
  if (!match) {
    response.setHeader('Content-Length', stat.size)
    createReadStream(file).pipe(response)
    return
  }
  const suffix = !match[1]
  const start = suffix ? Math.max(0, stat.size - Number(match[2])) : Number(match[1])
  const end = suffix ? stat.size - 1 : Math.min(stat.size - 1, match[2] ? Number(match[2]) : stat.size - 1)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
    response.setHeader('Content-Range', `bytes */${stat.size}`)
    response.status(416).end()
    return
  }
  response.status(206)
  response.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
  response.setHeader('Content-Length', end - start + 1)
  createReadStream(file, { start, end }).pipe(response)
}

async function audioEnergy(binary: string, file: string): Promise<number[]> {
  const result = await runCapture(binary, ['-v', 'error', '-t', '180', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], 4 * 1024 * 1024)
  if (result.code !== 0 || result.stdout.length < 8000 * 2 * 25) throw new Error('无法提取足够的音频用于自动同步，请使用手动偏移滑轨')
  return pcmEnergy(result.stdout)
}

export async function registerMvRoutes(app: Application, database: DatabaseSync, dataDir: string, readSong: (id: string) => Promise<Song | null>): Promise<(songId: string) => void> {
  const root = process.cwd()
  const binary = ffmpegPath(root)
  const mvDir = path.join(dataDir, 'mv')
  const uploadDir = path.join(mvDir, 'uploads')
  const outputDir = path.join(mvDir, 'outputs')
  await Promise.all([uploadDir, outputDir].map(dir => fs.mkdir(dir, { recursive: true })))
  const renderFontsDir = path.join(outputDir, 'fonts')
  await fs.mkdir(renderFontsDir, { recursive: true })
  await Promise.all(['NotoSansJP-ExtraBold.ttf', 'DMSans-Bold.ttf'].map(font =>
    fs.copyFile(path.join(root, 'assets', 'fonts', font), path.join(renderFontsDir, font))))
  database.exec('CREATE TABLE IF NOT EXISTS mv_projects (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL)')
  const find = database.prepare('SELECT payload FROM mv_projects WHERE id = ?')
  const list = database.prepare('SELECT payload FROM mv_projects ORDER BY created_at DESC')
  const store = database.prepare('INSERT INTO mv_projects (id, created_at, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
  const remove = database.prepare('DELETE FROM mv_projects WHERE id = ?')
  function read(id: string): MvProject | null {
    if (!uuid.test(id)) return null
    const row = find.get(id) as { payload: string } | undefined
    if (!row) return null
    const project = JSON.parse(row.payload) as MvProject
    return { ...project, style: { ...defaultMvStyle, ...project.style } }
  }
  function save(project: MvProject): void { store.run(project.id, project.createdAt, JSON.stringify(project)) }
  function outputFor(project: MvProject, layout: MvLayout): MvOutput {
    const legacy = layout === 'single' ? {
      previewFile: project.previewFile, fullFile: project.fullFile,
      previewVersion: project.previewVersion, fullVersion: project.fullVersion,
    } : {}
    return { ...legacy, ...project.outputs?.[layout] }
  }
  function outputUrl(project: MvProject, layout: MvLayout, kind: 'preview' | 'full'): string | null {
    const output = outputFor(project, layout)
    const file = kind === 'preview' ? output.previewFile : output.fullFile
    const version = kind === 'preview' ? output.previewVersion : output.fullVersion
    const fontVersion = kind === 'preview' ? output.previewRendererVersion : output.fullRendererVersion
    return file && (version ?? 0) === (project.settingsVersion ?? 0) && fontVersion === rendererVersion
      ? `/api/mv-projects/${project.id}/export/${kind}?layout=${layout}` : null
  }
  function publicProject(project: MvProject) {
    const { videoFile: _videoFile, previewFile: _previewFile, fullFile: _fullFile, outputs: _outputs, ...rest } = project
    return {
      ...rest,
      style: { ...defaultMvStyle, ...project.style },
      videoUrl: `/api/mv-projects/${project.id}/video`,
      assUrl: `/api/mv-projects/${project.id}/ass`,
      exportUrls: {
        single: { preview: outputUrl(project, 'single', 'preview'), full: outputUrl(project, 'single', 'full') },
        double: { preview: outputUrl(project, 'double', 'preview'), full: outputUrl(project, 'double', 'full') },
      },
    }
  }
  for (const row of list.all() as { payload: string }[]) {
    const project = JSON.parse(row.payload) as MvProject
    if (project.render?.status === 'queued' || project.render?.status === 'running') {
      project.render = { ...project.render, status: 'failed', error: '服务重启中断了导出，请重新执行' }
      save(project)
    }
  }

  const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 1024 * 1024 * 1024, files: 1 },
    fileFilter: (_request, file, callback) => callback(null, /\.(mp4|mov|webm|mkv)$/i.test(file.originalname)),
  }).single('video')

  app.get('/api/mv-projects', (_request, response) => {
    response.json((list.all() as { payload: string }[]).map(row => publicProject(JSON.parse(row.payload) as MvProject)))
  })
  app.get('/api/mv-projects/:id', (request, response) => {
    const project = read(request.params.id)
    if (!project) return response.status(404).json({ error: '找不到 MV 项目' })
    response.json(publicProject(project))
  })
  app.post('/api/mv-projects', (request, response, next) => upload(request, response, async error => {
    if (error) return next(error)
    const video = request.file
    try {
      if (!video) throw new Error('请上传 MP4、MOV、WebM 或 MKV 视频')
      const song = await readSong(String(request.body.songId ?? ''))
      if (!song) throw new Error('请先选择曲库中的歌曲')
      const info = await probeVideo(binary, video.path)
      const id = randomUUID()
      const videoFile = `${id}${path.extname(video.originalname).toLowerCase()}`
      await fs.rename(video.path, path.join(uploadDir, videoFile))
      const project: MvProject = {
        id, songId: song.id, title: String(request.body.title || song.title).trim().slice(0, 120),
        videoFile, originalVideoName: video.originalname, createdAt: new Date().toISOString(),
        duration: info.duration, width: info.width, height: info.height,
        offsetMs: 0, style: { ...defaultMvStyle }, settingsVersion: 0,
      }
      save(project)
      response.status(201).json(publicProject(project))
    } catch (failure) {
      response.status(400).json({ error: failure instanceof Error ? failure.message : '上传 MV 失败' })
    } finally {
      if (video) await fs.rm(video.path, { force: true }).catch(() => undefined)
    }
  }))
  app.patch('/api/mv-projects/:id', (request, response) => {
    const project = read(request.params.id)
    if (!project) return response.status(404).json({ error: '找不到 MV 项目' })
    const offsetMs = Number(request.body.offsetMs)
    const nextStyle = { ...defaultMvStyle, ...request.body.style }
    if (!Number.isInteger(offsetMs) || offsetMs < -600000 || offsetMs > 600000 || !validMvStyle(nextStyle)) {
      return response.status(400).json({ error: '歌词偏移或字幕样式无效' })
    }
    if (project.offsetMs !== offsetMs || JSON.stringify(project.style) !== JSON.stringify(nextStyle)) {
      project.settingsVersion = (project.settingsVersion ?? 0) + 1
    }
    project.offsetMs = offsetMs
    project.style = nextStyle
    save(project)
    response.json(publicProject(project))
  })
  app.get('/api/mv-projects/:id/video', async (request, response) => {
    const project = read(request.params.id)
    if (!project) return response.status(404).end()
    const ext = path.extname(project.videoFile)
    const mime: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' }
    await streamFile(request, response, path.join(uploadDir, project.videoFile), mime[ext] ?? 'application/octet-stream')
  })
  app.get('/api/mv-projects/:id/ass', async (request, response) => {
    const project = read(request.params.id)
    if (!project) return response.status(404).json({ error: '找不到 MV 项目' })
    const song = await readSong(project.songId)
    if (!song) return response.status(404).json({ error: '关联的歌曲已被删除' })
    const layout = request.query.layout === 'double' ? 'double' : 'single'
    response.setHeader('Content-Type', 'text/plain; charset=utf-8')
    response.setHeader('Content-Disposition', `attachment; filename="${project.id}-${layout}.ass"`)
    response.send(generateAss(song.lines, project.offsetMs, project.style, project.width, project.height, 0, undefined, layout))
  })
  app.post('/api/mv-projects/:id/sync', async (request, response) => {
    const project = read(request.params.id)
    if (!project) return response.status(404).json({ error: '找不到 MV 项目' })
    const song = await readSong(project.songId)
    if (!song) return response.status(404).json({ error: '关联的歌曲已被删除' })
    try {
      const [songEnergy, videoEnergy] = await Promise.all([
        audioEnergy(binary, path.join(dataDir, 'audio', song.audioFile)),
        audioEnergy(binary, path.join(uploadDir, project.videoFile)),
      ])
      const result = estimateAudioOffset(songEnergy, videoEnergy)
      const applied = result.confidence >= 0.4
      if (applied) {
        const newOffset = Math.round(result.offsetSeconds * 1000)
        if (project.offsetMs !== newOffset) project.settingsVersion = (project.settingsVersion ?? 0) + 1
        project.offsetMs = newOffset
        save(project)
      }
      response.json({ ...result, applied, project: publicProject(project) })
    } catch (failure) {
      response.status(400).json({ error: failure instanceof Error ? failure.message : '自动同步失败' })
    }
  })

  let renderQueue = Promise.resolve()
  async function renderProject(id: string, kind: 'preview' | 'full', previewStart: number, layout: MvLayout): Promise<void> {
    const project = read(id)
    if (!project) return
    const song = await readSong(project.songId)
    if (!song) throw new Error('关联的歌曲已被删除')
    project.render = { kind, layout, status: 'running', progress: 0 }
    save(project)
    const clipStart = kind === 'preview' ? previewStart : 0
    const clipDuration = kind === 'preview' ? Math.min(30, project.duration - clipStart) : project.duration
    const renderVersion = project.settingsVersion ?? 0
    const assFile = path.join(outputDir, `${id}-${layout}-${kind}.ass`)
    const outputFile = path.join(outputDir, `${id}-${layout}-${kind}-${randomUUID()}.mp4`)
    await fs.writeFile(assFile, generateAss(song.lines, project.offsetMs, project.style, project.width, project.height, clipStart, clipDuration, layout), 'utf8')
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1']
    if (clipStart > 0) args.push('-ss', String(clipStart))
    args.push('-i', path.join(uploadDir, project.videoFile))
    if (kind === 'preview') args.push('-t', String(clipDuration))
    args.push('-map', '0:v:0', '-map', '0:a?', '-vf', `ass=${path.basename(assFile)}:fontsdir=fonts`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputFile)
    try { await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, { cwd: outputDir, windowsHide: true })
      let stderr = ''
      let progressData = ''
      let lastProgress = 0
      child.stdout.on('data', chunk => {
        progressData += String(chunk)
        const lines = progressData.split(/\r?\n/)
        progressData = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('out_time=')) continue
          const match = /out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line)
          if (!match) continue
          const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
          const progress = Math.min(99, Math.round(seconds / clipDuration * 100))
          if (progress >= lastProgress + 2) {
            lastProgress = progress
            const latest = read(id)
            if (latest?.render?.status === 'running') { latest.render.progress = progress; save(latest) }
          }
        }
      })
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-5000) })
      child.on('error', () => reject(new Error('找不到 FFmpeg。请安装 FFmpeg 或设置 FFMPEG_PATH。')))
      child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `视频导出失败（${code}）`)))
    }) } catch (failure) {
      await fs.rm(outputFile, { force: true }).catch(() => undefined)
      throw failure
    }
    const stat = await fs.stat(outputFile)
    if (!stat.size) throw new Error('FFmpeg 没有生成有效的视频文件')
    const latest = read(id)
    if (latest) {
      const previous = outputFor(latest, layout)
      const previousFile = kind === 'preview' ? previous.previewFile : previous.fullFile
      const output = { ...previous }
      if (kind === 'preview') { output.previewFile = path.basename(outputFile); output.previewVersion = renderVersion; output.previewRendererVersion = rendererVersion }
      else { output.fullFile = path.basename(outputFile); output.fullVersion = renderVersion; output.fullRendererVersion = rendererVersion }
      latest.outputs = { ...latest.outputs, [layout]: output }
      latest.render = { kind, layout, status: 'complete', progress: 100 }
      save(latest)
      if (previousFile) await fs.rm(path.join(outputDir, previousFile), { force: true }).catch(() => undefined)
    }
  }
  app.post('/api/mv-projects/:id/export', (request, response) => {
    const project = read(request.params.id)
    if (!project) return response.status(404).json({ error: '找不到 MV 项目' })
    if (project.render?.status === 'queued' || project.render?.status === 'running') return response.status(409).json({ error: '已有视频正在导出' })
    const kind = request.body.kind
    if (kind !== 'preview' && kind !== 'full') return response.status(400).json({ error: '无效的导出类型' })
    const layout = request.body.layout === 'double' ? 'double' : request.body.layout === 'single' || request.body.layout === undefined ? 'single' : null
    if (!layout) return response.status(400).json({ error: '无效的字幕版本' })
    const previewStart = kind === 'preview' ? Number(request.body.start ?? 0) : 0
    if (!Number.isFinite(previewStart) || previewStart < 0 || previewStart >= project.duration) return response.status(400).json({ error: '预览起点超出 MV 时长' })
    project.render = { kind, layout, status: 'queued', progress: 0 }
    save(project)
    renderQueue = renderQueue.then(() => renderProject(project.id, kind, previewStart, layout)).catch(failure => {
      const latest = read(project.id)
      if (latest) {
        latest.render = { kind, layout, status: 'failed', progress: 0, error: failure instanceof Error ? failure.message : '视频导出失败' }
        save(latest)
      }
    })
    response.status(202).json(publicProject(project))
  })
  app.get('/api/mv-projects/:id/export/:kind', async (request, response) => {
    const project = read(request.params.id)
    if (!project) return response.status(404).end()
    const layout = request.query.layout === 'double' ? 'double' : 'single'
    const output = outputFor(project, layout)
    const file = request.params.kind === 'preview' && (output.previewVersion ?? 0) === (project.settingsVersion ?? 0) && output.previewRendererVersion === rendererVersion ? output.previewFile : request.params.kind === 'full' && (output.fullVersion ?? 0) === (project.settingsVersion ?? 0) && output.fullRendererVersion === rendererVersion ? output.fullFile : undefined
    if (!file) return response.status(404).end()
    await streamFile(request, response, path.join(outputDir, file), 'video/mp4', `${project.id}-${layout}-${request.params.kind}.mp4`)
  })
  app.delete('/api/mv-projects/:id', async (request, response) => {
    const project = read(request.params.id)
    if (!project) return response.status(404).json({ error: '找不到 MV 项目' })
    if (project.render?.status === 'queued' || project.render?.status === 'running') return response.status(409).json({ error: '请等待视频导出结束后再删除' })
    const files = [project.previewFile, project.fullFile, ...Object.values(project.outputs ?? {}).flatMap(output => [output?.previewFile, output?.fullFile])]
    await Promise.all([path.join(uploadDir, project.videoFile), ...files.filter((file): file is string => Boolean(file)).map(file => path.join(outputDir, file)), ...['preview', 'full'].flatMap(kind => [path.join(outputDir, `${project.id}-${kind}.ass`), ...(['single', 'double'] as const).map(layout => path.join(outputDir, `${project.id}-${layout}-${kind}.ass`))])].map(file => fs.rm(file, { force: true }).catch(() => undefined)))
    remove.run(project.id)
    response.status(204).end()
  })
  return songId => {
    for (const row of list.all() as { payload: string }[]) {
      const project = JSON.parse(row.payload) as MvProject
      if (project.songId !== songId) continue
      project.settingsVersion = (project.settingsVersion ?? 0) + 1
      save(project)
    }
  }
}
