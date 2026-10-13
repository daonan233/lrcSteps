import { DatabaseSync } from 'node:sqlite'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const [songId, outputDirectory] = process.argv.slice(2)
if (!songId || !outputDirectory) {
  console.error('Usage: node scripts/export-example.mjs <song-id> <output-directory>')
  process.exit(1)
}

const database = new DatabaseSync(path.resolve('data/songs.sqlite'), { readOnly: true })
const row = database.prepare('SELECT payload FROM songs WHERE id = ?').get(songId)
database.close()
if (!row) throw new Error(`Song ${songId} was not found`)

const song = JSON.parse(row.payload)
const timestamp = seconds => {
  const millis = Math.round(seconds * 1000)
  const minutes = String(Math.floor(millis / 60000)).padStart(2, '0')
  const remainder = String(Math.floor(millis % 60000 / 1000)).padStart(2, '0')
  return `[${minutes}:${remainder}.${String(millis % 1000).padStart(3, '0')}]`
}
const lrc = lines => lines.map(line => `${timestamp(line.start)}${line.text}`).join('\n') + '\n'
const romanized = song.lines.filter(line => line.romaji).map(line => ({ start: line.start, text: line.romaji }))

await mkdir(outputDirectory, { recursive: true })
await writeFile(path.join(outputDirectory, 'japanese.lrc'), lrc(song.lines), 'utf8')
if (romanized.length) await writeFile(path.join(outputDirectory, 'romaji.lrc'), lrc(romanized), 'utf8')
await writeFile(path.join(outputDirectory, 'alignment.json'), JSON.stringify({
  title: song.title,
  artist: song.artist,
  sourceSongId: song.id,
  lines: song.lines,
}, null, 2) + '\n', 'utf8')
console.log(`Exported ${song.lines.length} lyric lines to ${outputDirectory}`)
