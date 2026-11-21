// Listing the songs in a folder the person picked (usually a pen drive),
// with their tags, for the organizer page to filter, select and reorganise.
// Also looks at what is already where a plan would write (inspectTargets),
// so a plan never aims at a name that is taken. Only reads; never writes.
//
// API (used by organizer/routes.js):
//
//   scanFolder(folder, { maxDepth = 4, maxSongs = 20000, readTags = readSongTags,
//       onProgress = () => {}, log = console.log } = {})
//     -> Promise<{ root, songs, truncated }>
//     root       the folder's real path (links resolved); every song's path
//                starts with it
//     songs      Song objects, folder by folder in name order: a folder's
//                own MP3s first, then its subfolders
//     truncated  true when there were more than maxSongs MP3s (the first
//                maxSongs are listed)
//     Goes maxDepth folders down at most (1 reaches <folder>/a/*.mp3). Skips
//     hidden files and folders ("._" macOS twins, .Trashes, the undo
//     journals' .zipify-organizer), links of any kind (never followed, so
//     nothing outside the folder is listed) and "<folder>/_Duplicates",
//     where dedupe sets songs aside. A subfolder or file that can't be read
//     is skipped with a log line; a song whose tags can't be read is listed
//     untagged. onProgress({ found, scanned }) follows the MP3s found and
//     those whose tags have been read. Rejects when folder itself can't be
//     read (e.g. ENOENT, ENOTDIR).
//
//   Song = { id, path, relPath, folder, fileName, size, mtimeMs, title,
//            artist, album, year, genre, track, durationSec, hasCover, tagged }
//     id         songIdFor(relPath): the same in every scan
//     relPath    the path inside root, "/"-separated; folder: its folder
//                ('' for root itself); fileName: its name
//     size, mtimeMs   from lstat
//     title … hasCover   see organizer/tags.js
//     tagged     has both a title and an artist
//
//   songIdFor(relPath) -> the first 16 hex digits of relPath's sha1
//
//   inspectTargets(operations, { log } = {}) -> Promise<[{ path, kind, size? }]>
//     What is in the folders a plan's operations write into (for a mkdir,
//     also in that folder itself): kind 'file' | 'dir' | 'other' (links and
//     the like). size comes with a file sitting exactly where a copy, move
//     or rename would put a song. Missing folders give nothing.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { readSongTags } = require('./tags')
const { DUPLICATES_FOLDER, pathKey } = require('./plan')

const DEFAULT_MAX_DEPTH = 4
// a drive full of other things mustn't hold the page up for minutes
const MAX_SONGS = 20000
// files read at once: on a USB drive most of each read is spent waiting
const TAG_READS_AT_ONCE = 4
const LISTINGS_AT_ONCE = 4
const ID_HEX_DIGITS = 16
const MP3_NAME = /\.mp3$/i
const SONG_OPERATIONS = new Set(['copy', 'move', 'rename'])
const MISSING_FOLDER_CODES = new Set(['ENOENT', 'ENOTDIR'])

function songIdFor (relPath) {
  return crypto.createHash('sha1').update(relPath).digest('hex').slice(0, ID_HEX_DIGITS)
}

// ---------- scanning ----------

async function scanFolder (
  folder,
  {
    maxDepth = DEFAULT_MAX_DEPTH,
    maxSongs = MAX_SONGS,
    readTags = readSongTags,
    onProgress = () => {},
    log = console.log
  } = {}
) {
  const root = await fs.promises.realpath(path.resolve(folder))
  const counts = { found: 0, scanned: 0 }
  const report = (change) => {
    Object.assign(counts, change)
    onProgress({ found: Math.min(counts.found, maxSongs), scanned: counts.scanned })
  }

  // looking for one more than allowed tells whether any were left out
  const walk = { root, maxDepth, limit: maxSongs + 1, files: [], log, report }
  await collectMp3Files(walk, root, 0)
  const truncated = walk.files.length > maxSongs
  if (truncated) log(`Stopped scanning after ${maxSongs} songs in ${root}`)
  const files = walk.files.slice(0, maxSongs)
  report({ found: files.length })

  const songs = await mapWithLimit(files, TAG_READS_AT_ONCE, async (filePath) => {
    const song = await describeSong(filePath, { root, readTags, log })
    report({ scanned: counts.scanned + 1 })
    return song
  })
  return { root, songs: songs.filter(Boolean), truncated }
}

// The *.mp3 files in folder and below, in name order so every scan sees the
// same files. walk.files is filled in place: copying it at every folder would
// be quadratic on a drive with thousands of folders.
async function collectMp3Files (walk, folder, depth) {
  const isRoot = depth === 0
  const entries = (await listFolder(folder, { mustRead: isRoot, log: walk.log }))
    .filter((entry) => isWanted(entry, isRoot))
    .sort(byName)

  for (const entry of entries.filter((e) => e.isFile() && MP3_NAME.test(e.name))) {
    if (walk.files.length >= walk.limit) return
    walk.files.push(path.join(folder, entry.name))
  }
  walk.report({ found: walk.files.length })
  if (depth >= walk.maxDepth) return

  // a link to a folder isn't a directory here, so a link can't lead outside
  for (const entry of entries.filter((e) => e.isDirectory())) {
    if (walk.files.length >= walk.limit) return
    await collectMp3Files(walk, path.join(folder, entry.name), depth + 1)
  }
}

// The scanned folder itself must be readable; an unreadable subfolder (no
// permission, a drive pulled out) is skipped, but said so
async function listFolder (folder, { mustRead, log }) {
  try {
    return await fs.promises.readdir(folder, { withFileTypes: true })
  } catch (err) {
    if (mustRead) throw err
    log(`Skipping unreadable folder ${folder}:`, err.message)
    return []
  }
}

// hidden names: "._" twins, .Trashes, .zipify-organizer…; and the folder
// dedupe sets songs aside in, so they don't come back as duplicates
function isWanted (entry, isRoot) {
  if (entry.name.startsWith('.')) return false
  const isDuplicates = isRoot && entry.isDirectory() && pathKey(entry.name) === pathKey(DUPLICATES_FOLDER)
  return !isDuplicates
}

// plain code-unit order: the same on every machine, unlike localeCompare
function byName (a, b) {
  if (a.name < b.name) return -1
  return a.name > b.name ? 1 : 0
}

async function describeSong (filePath, { root, readTags, log }) {
  const stat = await lstatOrNull(filePath, log)
  if (!stat || !stat.isFile()) return null

  const tags = await readTagsSafely(filePath, readTags, log)
  const relPath = path.relative(root, filePath).split(path.sep).join('/')
  const folder = path.posix.dirname(relPath)
  const title = text(tags.title)
  const artist = text(tags.artist)
  return {
    id: songIdFor(relPath),
    path: filePath,
    relPath,
    folder: folder === '.' ? '' : folder,
    fileName: path.basename(filePath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    title,
    artist,
    album: text(tags.album),
    year: text(tags.year),
    genre: text(tags.genre),
    track: Number.isSafeInteger(tags.track) && tags.track >= 1 ? tags.track : null,
    durationSec: Number.isFinite(tags.durationSec) && tags.durationSec > 0 ? tags.durationSec : null,
    hasCover: tags.hasCover === true,
    tagged: Boolean(title && artist)
  }
}

async function lstatOrNull (filePath, log) {
  try {
    return await fs.promises.lstat(filePath)
  } catch (err) {
    log(`Skipping ${filePath}:`, err.message)
    return null
  }
}

// One unreadable file mustn't sink the scan: it is listed without tags
async function readTagsSafely (filePath, readTags, log) {
  try {
    return (await readTags(filePath)) ?? {}
  } catch (err) {
    log(`Could not read the tags of ${filePath}:`, err.message)
    return {}
  }
}

function text (value) {
  return typeof value === 'string' ? value.trim() : ''
}

// fn over every item, `limit` at a time; results in the items' order
async function mapWithLimit (items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker () {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// ---------- what is already where a plan writes ----------

async function inspectTargets (operations, { log = console.log } = {}) {
  const listed = await mapWithLimit(foldersWrittenBy(operations), LISTINGS_AT_ONCE, (folder) =>
    listEntries(folder, log)
  )
  const songTargets = new Set(operations.filter((op) => SONG_OPERATIONS.has(op.kind)).map((op) => pathKey(op.to)))
  return mapWithLimit(listed.flat(), LISTINGS_AT_ONCE, (entry) =>
    entry.kind === 'file' && songTargets.has(pathKey(entry.path)) ? withSize(entry, log) : entry
  )
}

// each folder an operation writes into, once; a mkdir's own folder too, in
// case it is already there with things in it
function foldersWrittenBy (operations) {
  const byKey = new Map()
  for (const op of operations) {
    const folders = op.kind === 'mkdir' ? [path.dirname(op.to), op.to] : [path.dirname(op.to)]
    folders.forEach((folder) => byKey.set(pathKey(folder), folder))
  }
  return [...byKey.values()]
}

async function listEntries (folder, log) {
  try {
    const entries = await fs.promises.readdir(folder, { withFileTypes: true })
    return entries.map((entry) => ({ path: path.join(folder, entry.name), kind: kindOf(entry) }))
  } catch (err) {
    if (!MISSING_FOLDER_CODES.has(err.code)) log(`Could not look into ${folder}:`, err.message)
    return []
  }
}

function kindOf (entry) {
  if (entry.isDirectory()) return 'dir'
  return entry.isFile() ? 'file' : 'other'
}

async function withSize (entry, log) {
  const stat = await lstatOrNull(entry.path, log)
  return stat ? { ...entry, size: stat.size } : entry
}

module.exports = { scanFolder, songIdFor, inspectTargets }
