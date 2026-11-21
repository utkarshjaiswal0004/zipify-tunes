// Planning a reorganisation of the songs in a folder (usually a pen drive):
// sort them into folders by a tag, rename them from a pattern, gather some
// into a new playlist folder, or set duplicates aside. This file only decides
// WHAT to do; organizer/apply.js does it, one operation at a time, with an
// undo journal. Nothing here touches the disk, so the page can show the plan
// before anything changes, and every rule can be tested with plain objects.
//
// API (used by organizer/routes.js):
//
//   buildPlan({ root, songs, songIds, action, options, existing = [] }) -> Plan
//     root      the scanned folder: absolute, already resolved (realpath)
//     songs     every song of the scan (organizer/scan.js's Song objects);
//               those not selected still hold their names
//     songIds   the selected songs' ids, in the order the person sees them;
//               an unknown id is reported, a repeated one planned once
//     action    'sort' | 'rename' | 'playlist' | 'dedupe' (see planProblem)
//     existing  what is already on the disk where the plan writes, as
//               [{ path, kind: 'file' | 'dir' | 'other', size? }]
//               (organizer/scan.js's inspectTargets): those names are never
//               aimed at, and folders among them are reused as they are spelt
//   Plan = {
//     action, root,
//     targetFolder    where sort / playlist write (null for rename, dedupe)
//     allowedFolders  root, plus targetFolder when that is outside root: no
//                     operation writes anywhere else
//     operations      in order: { kind: 'mkdir', to, fresh? } |
//                     { kind: 'copy' | 'move' | 'rename', from, to, songId } |
//                     { kind: 'write-m3u', to, content }
//                     "fresh" marks a folder that must be new (a playlist's):
//                     apply.js picks "<name> (2)"… if one appeared meanwhile
//     conflicts       [{ songId, reason }]: selected songs left alone, and why
//     summary         { copies, moves, renames, folders, skipped }
//     groups          dedupe only: [{ keep: songId, move: [songId] }]
//   }
//   Throws a TypeError (with planProblem's message) for bad input.
//
//   planProblem({ action, options }) -> what's wrong, for the page, or null
//     sort      { groupBy: GROUP_BY, mode: 'copy' | 'move', targetFolder? }
//               targetFolder defaults to "<root>/Organized"
//     rename    { pattern } using {artist} {title} {album} {year} {genre}
//               {track}; renames in place
//     playlist  { name, mode, targetFolder? (the parent; default root),
//                 numberTracks?, writePlaylist? (both default false) }
//     dedupe    { keep: 'largest' | 'first' | 'newest' }
//
//   safeName(text, fallback = '') -> a file or folder name a FAT32 drive takes
//   suffixedFileName('Song.mp3', 2) -> 'Song (2).mp3' (1 gives the name back)
//   suffixedFolderName('Vol. 1', 2) -> 'Vol. 1 (2)'
//   pathKey(absPath) -> the path as FAT32 and macOS compare names (no case)
//   isInside(child, parent) -> true for parent itself and anything under it
//   publicOperation(op) -> { kind, from?, to, songId? } for the page
//
// Inside buildPlan, lists and the map of taken names are filled in place:
// they never leave it unfinished, and copying them for each of up to 20 000
// songs would make planning quadratic.

const path = require('path')
const { looseText, scoreCandidate } = require('../matching')
const {
  buildM3u,
  numberedFileName,
  stripTrackPrefix,
  trackPrefixWidth
} = require('../playlist-files')

const ACTIONS = ['sort', 'rename', 'playlist', 'dedupe']
const GROUP_BY = ['artist', 'album', 'artist-album', 'genre', 'year', 'decade', 'letter']
const MODES = ['copy', 'move']
const KEEP_RULES = ['largest', 'first', 'newest']
const PATTERN_TOKENS = ['artist', 'title', 'album', 'year', 'genre', 'track']
const TOKEN_LABELS = {
  artist: 'artist',
  title: 'title',
  album: 'album',
  year: 'year',
  genre: 'genre',
  track: 'track number'
}

const SORT_FOLDER = 'Organized'
const DUPLICATES_FOLDER = '_Duplicates'
const PLAYLIST_FALLBACK = 'Playlist'
const FILE_FALLBACK = 'Untitled'
const TRACK_FALLBACK = 'Track'
const UNKNOWN = {
  artist: 'Unknown Artist',
  album: 'Unknown Album',
  genre: 'Unknown Genre',
  year: 'Unknown Year'
}
const OTHER_LETTER = '#'
const SONG_EXTENSION = '.mp3'
const M3U_EXTENSION = '.m3u'
const TRACK_SEPARATOR = ' - '

// Drives allow 255 characters per name; staying well short leaves room for
// " (2)" and the ".part" a copy is written under first
const MAX_NAME_CHARS = 200
const MAX_PATH_CHARS = 4096
// "Song (2).mp3" and on: more than a scan can hold, so every song of one
// name fits in one folder (past that the song is reported instead)
const MAX_SUFFIX = 100000
// two copies of a song may differ this much in length (encoder padding)
const DUPLICATE_LENGTH_DIFF_SEC = 10

// FAT32 (and Windows) refuse these in names, and control characters
const UNSAFE_NAME_CHARS = /[/\\:*?"<>|\p{Cc}]/gu
const HAS_UNSAFE_CHAR = /[/\\:*?"<>|\p{Cc}]/u
// Windows keeps these names for devices, so a drive used there can't hold them
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const TOKEN = /\{([^{}]*)\}/g
// "Pritam,Arijit Singh" and "Daft Punk feat. Pharrell" start with their main
// artist. "&" and "/" are left alone: "Simon & Garfunkel", "AC/DC" are one act.
const MAIN_ARTIST_SPLIT = /\s*[,;]\s*|\s+[([]?(?:feat\.?|ft\.?|featuring)\s+/i
const YEAR = /^\d{4}$/

// ---------- names ----------

function safeName (text, fallback = '') {
  const cleaned = String(text ?? '')
    .normalize('NFC')
    .replace(UNSAFE_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    // a leading dot hides the file ("._" even reads as macOS metadata, which
    // the app deletes) and "." or ".." would mean another folder
    .replace(/^[.\s]+/, '')
  const name = trimName(cutToChars(cleaned, MAX_NAME_CHARS))
  if (!name) return fallback
  return RESERVED_NAME.test(name) ? `${name}_` : name
}

// Windows drops trailing dots and spaces, so "Song." and "Song" would clash
function trimName (name) {
  return name.replace(/[.\s]+$/, '')
}

// Cut to at most maxChars UTF-16 units (what FAT32 counts), never between
// the two halves of an emoji
function cutToChars (text, maxChars) {
  if (text.length <= maxChars) return text
  let end = 0
  for (const char of text) {
    if (end + char.length > maxChars) break
    end += char.length
  }
  return text.slice(0, end)
}

// a safe "<base><ext>", or '' when nothing of base is usable
function fileNameFrom (base, ext, fallback = '') {
  const name = safeName(base, fallback)
  return name ? `${trimName(cutToChars(name, MAX_NAME_CHARS - ext.length))}${ext}` : ''
}

// scan.js only lists *.mp3 files, whatever the case of the extension
function extensionOf (fileName) {
  return path.extname(fileName) || SONG_EXTENSION
}

function baseOf (fileName) {
  return fileName.slice(0, fileName.length - path.extname(fileName).length)
}

// the song's own file name, made safe for the drive it goes to
function songFileName (song) {
  const ext = extensionOf(song.fileName)
  return fileNameFrom(baseOf(song.fileName), ext, FILE_FALLBACK)
}

// "Song.mp3" -> "Song (2).mp3"; the extension always survives the cut
function suffixedFileName (fileName, n) {
  if (n === 1) return fileName
  const ext = path.extname(fileName)
  const suffix = ` (${n})`
  const base = trimName(cutToChars(baseOf(fileName), MAX_NAME_CHARS - ext.length - suffix.length))
  return `${base}${suffix}${ext}`
}

// folders have no extension: "Vol. 1" -> "Vol. 1 (2)", not "Vol (2). 1"
function suffixedFolderName (name, n) {
  if (n === 1) return name
  const suffix = ` (${n})`
  return `${trimName(cutToChars(name, MAX_NAME_CHARS - suffix.length))}${suffix}`
}

// ---------- paths ----------

function pathKey (absPath) {
  return String(absPath).normalize('NFC').toLowerCase()
}

function isInside (child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

function isStrictlyInside (child, parent) {
  return isInside(child, parent) && path.relative(parent, child) !== ''
}

// The folders from root (left out) down to folder: "a", "a/b"…
function foldersBetween (root, folder) {
  const rel = path.relative(root, folder)
  if (!rel) return []
  const parts = rel.split(path.sep)
  return parts.map((_, i) => path.join(root, ...parts.slice(0, i + 1)))
}

// A folder as one that exists (root, or a target the route checked) plus the
// names to go down from it
function folderChain (root, folder) {
  if (!isInside(folder, root)) return { base: folder, segments: [] }
  const rel = path.relative(root, folder)
  return { base: root, segments: rel ? rel.split(path.sep) : [] }
}

// ---------- what is on the disk ----------

// Every name the plan must not aim at: the scanned songs and their folders,
// what the route found where the plan writes, and what the plan itself puts
// there (a move frees its old name). Kept up to date operation by operation,
// so each one is checked against everything planned before it.
function createDiskModel ({ root, songs, existing }) {
  const entries = new Map()
  // name -> the suffix to try first. Album rips are full of "01.mp3": trying
  // " (2)", " (3)"… from the start for each would make planning quadratic.
  // A name freed later (by a move) is merely skipped, never reused wrongly.
  const nextSuffix = new Map()
  const note = (entryPath, kind, size = null, isPlanned = false) =>
    entries.set(pathKey(entryPath), { path: entryPath, kind, size, isPlanned })

  note(root, 'dir')
  for (const song of songs.filter((s) => songPathProblem(s, root) === null)) {
    foldersBetween(root, path.dirname(song.path)).forEach((folder) => note(folder, 'dir'))
    note(song.path, 'file', song.size)
  }
  for (const entry of existing.filter(isExistingEntry)) {
    note(path.resolve(entry.path), entry.kind, Number.isFinite(entry.size) ? entry.size : null)
  }

  // "<name>", or "<name> (2)", "(3)"… whichever is free; null when none is
  function freePath (folder, name, suffixed) {
    const nameKey = pathKey(path.join(folder, name))
    for (let n = nextSuffix.get(nameKey) ?? 1; n <= MAX_SUFFIX; n++) {
      const candidate = path.join(folder, suffixed(name, n))
      if (!entries.has(pathKey(candidate))) {
        nextSuffix.set(nameKey, n)
        return candidate
      }
    }
    return null
  }

  return {
    get: (entryPath) => entries.get(pathKey(entryPath)) ?? null,
    freeFilePath: (folder, fileName) => freePath(folder, fileName, suffixedFileName),
    freeFolderPath: (parent, folderName) => freePath(parent, folderName, suffixedFolderName),
    addFile: (filePath, size) => note(filePath, 'file', size, true),
    addFolder: (folder) => note(folder, 'dir', null, true),
    remove: (entryPath) => entries.delete(pathKey(entryPath))
  }
}

function isExistingEntry (entry) {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.path === 'string' &&
    path.isAbsolute(entry.path) &&
    ['file', 'dir', 'other'].includes(entry.kind)
  )
}

// The folder base/segments…: the folders already there, in their own
// spelling, and the ones still to make. Changes nothing, so a song that turns
// out to be skipped never leaves an empty folder planned.
function resolveFolder (disk, base, segments) {
  const missing = []
  let folder = base
  for (const segment of segments) {
    const candidate = path.join(folder, segment)
    const entry = missing.length ? null : disk.get(candidate)
    if (entry && entry.kind !== 'dir') return { problem: `"${segment}" is a file, not a folder` }
    folder = entry ? entry.path : candidate
    if (!entry) missing.push(candidate)
  }
  return { folder, missing }
}

function makeFolders (disk, folders) {
  folders.forEach((folder) => disk.addFolder(folder))
  return folders.map((folder) => ({ kind: 'mkdir', to: folder }))
}

function tooManyNamed (name) {
  return `Too many files named "${name}" already`
}

// A copy or move of a song to `to`, noted on the disk model
function fileOperation (disk, kind, song, to) {
  disk.addFile(to, song.size)
  if (kind !== 'copy') disk.remove(song.path)
  return { kind, from: song.path, to, songId: song.id }
}

// ---------- tags ----------

function tagText (value) {
  return String(value ?? '').trim()
}

function mainArtistName (artist) {
  return (
    tagText(artist)
      .split(MAIN_ARTIST_SPLIT)
      .map((name) => name.trim())
      .find(Boolean) ?? ''
  )
}

function isTrackNumber (value) {
  return Number.isSafeInteger(value) && value >= 1
}

// "Édith Piaf" -> "E"; digits, other scripts and no artist at all -> "#"
function letterOf (name) {
  const first = name.normalize('NFKD').replace(/\p{M}+/gu, '').charAt(0).toUpperCase()
  return /^[A-Z]$/.test(first) ? first : OTHER_LETTER
}

function decadeOf (year) {
  return YEAR.test(year) ? `${Math.floor(Number(year) / 10) * 10}s` : ''
}

function artistFolder (song) {
  return safeName(mainArtistName(song.artist), UNKNOWN.artist)
}

const GROUPERS = {
  artist: (song) => [artistFolder(song)],
  album: (song) => [safeName(song.album, UNKNOWN.album)],
  'artist-album': (song) => [artistFolder(song), safeName(song.album, UNKNOWN.album)],
  genre: (song) => [safeName(song.genre, UNKNOWN.genre)],
  year: (song) => [safeName(song.year, UNKNOWN.year)],
  decade: (song) => [decadeOf(tagText(song.year)) || UNKNOWN.year],
  letter: (song) => [letterOf(mainArtistName(song.artist))]
}

// ---------- sort ----------

function planSort (songs, settings, { root, disk }) {
  const { base, segments } = folderChain(root, settings.targetFolder)
  return collect(songs, (song) => sortOne(song, settings, { disk, base, segments }))
}

function sortOne (song, settings, { disk, base, segments }) {
  const resolved = resolveFolder(disk, base, [...segments, ...GROUPERS[settings.groupBy](song)])
  if (resolved.problem) return { conflict: resolved.problem }

  const wanted = path.join(resolved.folder, songFileName(song))
  if (pathKey(wanted) === pathKey(song.path)) return { conflict: 'Already in place' }
  // Sorting again shouldn't fill the folders with "(2)" copies, so a file
  // already on the drive with this name and size counts as this song. One
  // planned in this same run is another song: that gets a "(2)".
  const there = disk.get(wanted)
  if (there && there.kind === 'file' && !there.isPlanned && there.size === song.size) {
    return { conflict: 'Already there (same name and size)' }
  }

  const to = disk.freeFilePath(resolved.folder, path.basename(wanted))
  if (!to) return { conflict: tooManyNamed(path.basename(wanted)) }
  return {
    operations: [...makeFolders(disk, resolved.missing), fileOperation(disk, settings.mode, song, to)]
  }
}

// Plan each song with planOne -> { operations } | { conflict }, in order
function collect (songs, planOne) {
  const operations = []
  const conflicts = []
  for (const song of songs) {
    const result = planOne(song)
    if (result.conflict) conflicts.push({ songId: song.id, reason: result.conflict })
    else operations.push(...result.operations)
  }
  return { operations, conflicts }
}

// ---------- rename ----------

function planRename (songs, settings, { disk }) {
  const highestTrack = songs.reduce((max, s) => (isTrackNumber(s.track) ? Math.max(max, s.track) : max), 0)
  const width = trackPrefixWidth(highestTrack)
  return collect(songs, (song) => renameOne(song, settings.pattern, { disk, width }))
}

function renameOne (song, pattern, { disk, width }) {
  const filled = fillPattern(pattern, song, width)
  if (filled.missing) return { conflict: `No ${TOKEN_LABELS[filled.missing]} tag` }

  const fileName = fileNameFrom(filled.text, extensionOf(song.fileName))
  if (!fileName) return { conflict: 'The new name would be empty' }
  if (fileName === song.fileName) return { conflict: 'Already named like that' }

  const folder = path.dirname(song.path)
  const wanted = path.join(folder, fileName)
  // only the case changes: the same name to the drive, so not a clash
  const isCaseOnly = pathKey(wanted) === pathKey(song.path)
  const to = isCaseOnly ? wanted : disk.freeFilePath(folder, fileName)
  if (!to) return { conflict: tooManyNamed(fileName) }
  return { operations: [fileOperation(disk, 'rename', song, to)] }
}

function tokensIn (pattern) {
  return [...pattern.matchAll(TOKEN)].map((match) => match[1])
}

// The pattern with the song's tags in it, or the first tag it lacks
function fillPattern (pattern, song, width) {
  const values = {
    artist: tagText(song.artist),
    title: tagText(song.title),
    album: tagText(song.album),
    year: tagText(song.year),
    genre: tagText(song.genre),
    track: isTrackNumber(song.track) ? String(song.track).padStart(width, '0') : ''
  }
  const missing = tokensIn(pattern).find((token) => !values[token])
  if (missing) return { missing }
  return { text: pattern.replace(TOKEN, (_, token) => values[token]) }
}

// ---------- playlist ----------

function planPlaylist (songs, settings, { root, disk }) {
  const refuseAll = (reason) => ({ operations: [], conflicts: songs.map((s) => ({ songId: s.id, reason })) })
  const { base, segments } = folderChain(root, settings.targetFolder)
  const parent = resolveFolder(disk, base, segments)
  if (parent.problem) return refuseAll(parent.problem)
  const folderName = safeName(settings.name, PLAYLIST_FALLBACK)
  const folder = disk.freeFolderPath(parent.folder, folderName)
  if (!folder) return refuseAll(`Too many folders named "${folderName}" already`)

  // the new folder is noted first, so the songs' names are checked inside it
  disk.addFolder(folder)
  const placed = []
  const conflicts = []
  songs.forEach((song, i) => {
    const fileName = settings.numberTracks ? numberedName(song, i + 1, songs.length) : songFileName(song)
    const to = disk.freeFilePath(folder, fileName)
    if (to) placed.push({ song, operation: fileOperation(disk, settings.mode, song, to) })
    else conflicts.push({ songId: song.id, reason: tooManyNamed(fileName) })
  })
  if (placed.length === 0) return { operations: [], conflicts }

  const operations = [
    ...makeFolders(disk, parent.missing),
    { kind: 'mkdir', to: folder, fresh: true },
    ...placed.map(({ operation }) => operation)
  ]
  if (settings.writePlaylist) operations.push(playlistFileOperation(disk, folder, settings.name, placed))
  return { operations, conflicts }
}

// "07 - <the song's file name without its old number>.mp3"
function numberedName (song, number, count) {
  const prefixChars = trackPrefixWidth(count) + TRACK_SEPARATOR.length
  const base = safeName(baseOf(stripTrackPrefix(song.fileName)), TRACK_FALLBACK)
  const fitted = trimName(cutToChars(base, MAX_NAME_CHARS - prefixChars - SONG_EXTENSION.length))
  return numberedFileName(number, count, fitted)
}

// "<name>.m3u" listing the songs by the names they get in the folder. The
// folder is new and holds only .mp3 files, so that name is always free.
function playlistFileOperation (disk, folder, name, placed) {
  const entries = placed.map(({ song, operation }) => ({
    fileName: path.basename(operation.to),
    title: song.title,
    artist: song.artist,
    durationSec: song.durationSec
  }))
  const to = disk.freeFilePath(folder, fileNameFrom(name, M3U_EXTENSION, PLAYLIST_FALLBACK))
  disk.addFile(to, null)
  return { kind: 'write-m3u', to, content: buildM3u(entries) }
}

// ---------- dedupe ----------

function planDedupe (songs, settings, { root, disk }) {
  const keyed = songs.map((song) => ({ song, key: duplicateKey(song) }))
  const conflicts = keyed
    .filter(({ key }) => key === null)
    .map(({ song }) => ({ songId: song.id, reason: 'Needs a title and an artist tag' }))
  const operations = []
  const groups = []

  for (const cluster of duplicateClusters(keyed.filter(({ key }) => key !== null))) {
    const keep = keeperOf(cluster, settings.keep)
    const others = cluster.filter((song) => song !== keep)
    const setAside = collect(others, (song) => setAsideOne(song, { root, disk }))
    const failed = new Set(setAside.conflicts.map((c) => c.songId))
    operations.push(...setAside.operations)
    conflicts.push(...setAside.conflicts)
    groups.push({ keep: keep.id, move: others.map((s) => s.id).filter((id) => !failed.has(id)) })
  }
  return { operations, conflicts, groups }
}

// What makes two songs the same: their title and main artist, compared
// loosely ("Tum Hi Ho (From "Aashiqui 2")" is "tum hi ho"), and the words
// that mark another version of a song. looseText drops "(Live)" and
// "(Remix)", so those words (matching.js knows them) must match too. null
// when the title or artist is missing: two untagged songs aren't duplicates.
function duplicateKey (song) {
  const title = looseText(tagText(song.title))
  const artist = looseText(mainArtistName(song.artist))
  return title && artist ? [title, artist, versionWords(song.title)].join('\u0000') : null
}

// "Song (Live) [Remix]" -> "live remix"; '' for the song itself
function versionWords (title) {
  return scoreCandidate({ title: tagText(title) }, { title: '' }).variant.sort().join(' ')
}

// Songs sharing a key, split into clusters whose members all match one
// another; only clusters of two or more are duplicates
function duplicateClusters (keyed) {
  const byKey = new Map()
  for (const { song, key } of keyed) {
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(song)
  }
  return [...byKey.values()].flatMap(splitByLength).filter((cluster) => cluster.length > 1)
}

// The same song at a clearly different length is another recording. A song
// joins the first cluster whose every member is close to it in length.
function splitByLength (songs) {
  const clusters = []
  for (const song of songs) {
    const cluster = clusters.find((members) => members.every((member) => isCloseInLength(member, song)))
    if (cluster) cluster.push(song)
    else clusters.push([song])
  }
  return clusters
}

// within 10 s, when both lengths are known
function isCloseInLength (a, b) {
  const aSec = positiveOrNull(a.durationSec)
  const bSec = positiveOrNull(b.durationSec)
  return aSec === null || bSec === null || Math.abs(aSec - bSec) <= DUPLICATE_LENGTH_DIFF_SEC
}

function positiveOrNull (value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

// The copy to keep; a tie keeps the one the person sees first
function keeperOf (cluster, rule) {
  if (rule === 'first') return cluster[0]
  const score = rule === 'largest' ? (song) => Number(song.size) || 0 : (song) => Number(song.mtimeMs) || 0
  return cluster.reduce((best, song) => (score(song) > score(best) ? song : best))
}

// "<root>/_Duplicates/<the song's folder>/<its name>": nothing is deleted,
// and the folder says where it came from
function setAsideOne (song, { root, disk }) {
  const rel = path.relative(root, path.dirname(song.path))
  const resolved = resolveFolder(disk, root, [DUPLICATES_FOLDER, ...(rel ? rel.split(path.sep) : [])])
  if (resolved.problem) return { conflict: resolved.problem }
  const fileName = songFileName(song)
  const to = disk.freeFilePath(resolved.folder, fileName)
  if (!to) return { conflict: tooManyNamed(fileName) }
  return { operations: [...makeFolders(disk, resolved.missing), fileOperation(disk, 'move', song, to)] }
}

// ---------- checking the request ----------

function isPlainObject (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function choiceProblem (value, choices, message) {
  return choices.includes(value) ? null : message
}

function modeProblem (mode) {
  return choiceProblem(mode, MODES, 'Choose copy or move.')
}

function folderProblem (folder) {
  if (folder == null || folder === '') return null
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) {
    return 'The target folder must be a full path, like /Volumes/MyDrive/Music.'
  }
  if (folder.length > MAX_PATH_CHARS) return 'The target folder path is too long.'
  return null
}

function booleanProblem (value, name) {
  return value == null || typeof value === 'boolean' ? null : `${name} must be true or false.`
}

function patternProblem (pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return 'Type a name pattern, like {artist} - {title}.'
  if (pattern.length > MAX_NAME_CHARS) return `The pattern is too long (at most ${MAX_NAME_CHARS} characters).`
  if (HAS_UNSAFE_CHAR.test(pattern.replace(TOKEN, ''))) {
    return 'The pattern can\'t contain / \\ : * ? " < > | or control characters.'
  }
  const tokens = tokensIn(pattern)
  const unknown = tokens.find((token) => !PATTERN_TOKENS.includes(token))
  if (unknown !== undefined) {
    return `Unknown tag {${unknown}} in the pattern. Use {artist}, {title}, {album}, {year}, {genre} or {track}.`
  }
  return tokens.length ? null : 'The pattern needs at least one tag, like {title}.'
}

function playlistNameProblem (name) {
  if (typeof name !== 'string' || !name.trim()) return 'Name the playlist.'
  if (name.trim().length > MAX_NAME_CHARS) {
    return `The playlist name is too long (at most ${MAX_NAME_CHARS} characters).`
  }
  return null
}

const OPTION_PROBLEMS = {
  sort: (options) =>
    choiceProblem(
      options.groupBy,
      GROUP_BY,
      'Choose how to group the songs: artist, album, artist-album, genre, year, decade or letter.'
    ) ||
    modeProblem(options.mode) ||
    folderProblem(options.targetFolder),
  rename: (options) => patternProblem(options.pattern),
  playlist: (options) =>
    playlistNameProblem(options.name) ||
    modeProblem(options.mode) ||
    folderProblem(options.targetFolder) ||
    booleanProblem(options.numberTracks, 'numberTracks') ||
    booleanProblem(options.writePlaylist, 'writePlaylist'),
  dedupe: (options) =>
    choiceProblem(options.keep, KEEP_RULES, 'Choose which copy to keep: largest, first or newest.')
}

function planProblem ({ action, options } = {}) {
  if (!ACTIONS.includes(action)) {
    return `Unknown action "${String(action).slice(0, 40)}". Choose sort, rename, playlist or dedupe.`
  }
  if (!isPlainObject(options)) return 'The options must be an object.'
  return OPTION_PROBLEMS[action](options)
}

function inputProblem ({ root, songs, songIds, action, options }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    return `The scanned folder (root) must be a full path (got ${JSON.stringify(root)}).`
  }
  if (!Array.isArray(songs) || !Array.isArray(songIds)) return 'songs and songIds must be lists.'
  return planProblem({ action, options })
}

// A song's path must be a plain absolute path under root: anything else is
// refused rather than trusted
function songPathProblem (song, root) {
  const songPath = song?.path
  const isPlainPath =
    typeof songPath === 'string' && path.isAbsolute(songPath) && path.resolve(songPath) === songPath
  return isPlainPath && isStrictlyInside(songPath, root) ? null : 'Not inside the scanned folder'
}

function selectSongs (songs, songIds, root) {
  const byId = new Map(songs.map((song) => [song?.id, song]))
  const seen = new Set()
  const selected = []
  const conflicts = []
  for (const id of songIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const song = byId.get(id)
    const problem = song ? songPathProblem(song, root) : 'Not in this scan'
    if (problem) conflicts.push({ songId: id, reason: problem })
    else selected.push(song)
  }
  return { selected, conflicts }
}

// ---------- the plan ----------

const PLANNERS = { sort: planSort, rename: planRename, playlist: planPlaylist, dedupe: planDedupe }

function settingsFor (action, options, root) {
  const chosen = options.targetFolder ? path.resolve(options.targetFolder) : null
  if (action === 'sort') return { ...options, targetFolder: chosen ?? path.join(root, SORT_FOLDER) }
  if (action === 'playlist') {
    return {
      ...options,
      targetFolder: chosen ?? root,
      numberTracks: options.numberTracks === true,
      writePlaylist: options.writePlaylist === true
    }
  }
  return { ...options, targetFolder: null }
}

function summarize (operations, conflicts) {
  const count = (kind) => operations.filter((op) => op.kind === kind).length
  return {
    copies: count('copy'),
    moves: count('move'),
    renames: count('rename'),
    folders: count('mkdir'),
    skipped: conflicts.length
  }
}

function buildPlan ({ root, songs, songIds, action, options, existing = [] }) {
  const problem = inputProblem({ root, songs, songIds, action, options })
  if (problem) throw new TypeError(problem)

  const settings = settingsFor(action, options, root)
  const picked = selectSongs(songs, songIds, root)
  const disk = createDiskModel({ root, songs, existing: Array.isArray(existing) ? existing : [] })
  const planned = PLANNERS[action](picked.selected, settings, { root, disk })
  const conflicts = [...picked.conflicts, ...planned.conflicts]
  const target = settings.targetFolder

  return {
    action,
    root,
    targetFolder: target,
    allowedFolders: target && !isInside(target, root) ? [root, target] : [root],
    operations: planned.operations,
    conflicts,
    summary: summarize(planned.operations, conflicts),
    ...(planned.groups ? { groups: planned.groups } : {})
  }
}

function publicOperation ({ kind, from, to, songId }) {
  return {
    kind,
    ...(from !== undefined ? { from } : {}),
    to,
    ...(songId !== undefined ? { songId } : {})
  }
}

module.exports = {
  ACTIONS,
  GROUP_BY,
  MODES,
  KEEP_RULES,
  PATTERN_TOKENS,
  DUPLICATES_FOLDER,
  buildPlan,
  planProblem,
  safeName,
  suffixedFileName,
  suffixedFolderName,
  pathKey,
  isInside,
  publicOperation
}
