import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = process.cwd()
const dataDir = await mkdtemp(path.join(tmpdir(), 'ktv-romaji-edit-'))
const songId = randomUUID()
const lineId = randomUUID()
const port = 32000 + Math.floor(Math.random() * 10000)
const base = `http://127.0.0.1:${port}`
const song = {
  id: songId,
  title: 'Romanization edit check',
  artist: '',
  audioFile: 'unused.wav',
  originalAudioName: 'unused.wav',
  createdAt: new Date().toISOString(),
  status: 'ready',
  lines: [{
    id: lineId,
    start: 1,
    end: 2,
    text: 'あい',
    romaji: 'ai',
    units: [{ text: 'あ', start: 1, end: 1.5 }, { text: 'い', start: 1.5, end: 2 }],
    romajiUnits: [{ text: 'a', start: 1, end: 1.5 }, { text: 'i', start: 1.5, end: 2 }],
    confidence: 1,
    method: 'manual',
  }],
}
const database = new DatabaseSync(path.join(dataDir, 'songs.sqlite'))
database.exec('CREATE TABLE songs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL)')
database.prepare('INSERT INTO songs VALUES (?, ?, ?)').run(songId, song.createdAt, JSON.stringify(song))
database.close()

const server = spawn(process.execPath, ['dist-server/index.js'], {
  cwd: root,
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let output = ''
server.stdout.on('data', chunk => { output += chunk })
server.stderr.on('data', chunk => { output += chunk })

try {
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) break
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) { ready = true; break }
    } catch { /* Server is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(ready, `Isolated server did not start: ${output}`)

  async function saveRomaji(romaji) {
    const count = [...romaji].length
    const romajiUnits = [...romaji].map((text, index) => ({
      text,
      start: 1 + index / count,
      end: 1 + (index + 1) / count,
    }))
    const response = await fetch(`${base}/api/songs/${songId}/lines/${lineId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ units: song.lines[0].units, romajiUnits }),
    })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.lines[0].romaji, romaji || undefined)
    assert.deepEqual(body.lines[0].romajiUnits?.map(unit => unit.text).join(''), romaji || undefined)
    const reloaded = await (await fetch(`${base}/api/songs/${songId}`)).json()
    assert.equal(reloaded.lines[0].romaji, romaji || undefined)
  }

  await saveRomaji('ei')
  await saveRomaji('eiyo')
  await saveRomaji('')
  console.log('Romaji replacement, insertion, deletion, and persistence passed.')
} finally {
  server.kill()
  if (path.dirname(dataDir) === tmpdir() && path.basename(dataDir).startsWith('ktv-romaji-edit-')) {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
