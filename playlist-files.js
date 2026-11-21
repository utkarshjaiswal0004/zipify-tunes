// "Car-ready" playlist folders: every song numbered in the CSV's order
// ("007 - Tum Hi Ho.mp3") and an .m3u playlist file beside them. Car stereos
// and many players sort a folder by file name, so without the numbers a
// playlist plays alphabetically; players that read the .m3u follow it instead.
//
// Nothing here downloads or spawns anything; only writeM3u touches the disk.
//
// API (called from server.js):
//
//   trackPrefixWidth(totalCount) -> number
//     Digits in a track number, at least 2: 9 -> 2, 99 -> 2, 500 -> 3,
//     1200 -> 4. totalCount is the number of songs in the whole CSV (not only
//     the ones downloaded this run), so a re-run numbers every song the same.
//
//   numberedFileName(number, totalCount, baseName) -> '007 - Tum Hi Ho.mp3'
//     number: the song's place in the CSV, from 1. baseName: the file name
//     without ".mp3", already made safe (what server.js's fileBaseFor gives).
//
//   stripTrackPrefix(fileName) -> fileName without a leading "<1-4 digits> - "
//     '007 - Tum Hi Ho.mp3' -> 'Tum Hi Ho.mp3'; '52 Bars.mp3' stays as it is.
//
//   songFileNames(number, totalCount, baseName) -> [numberedName, plainName]
//     The names a song may already be saved under, numbered or not, for
//     "skip songs already saved".
//
//   buildM3u(entries) -> string
//     entries: [{ fileName, title, artist, durationSec }] in playlist order
//     (sort by song number first: parallel downloads finish out of order).
//     fileName is the song's file in the playlist folder; durationSec may be
//     null when unknown. Gives "#EXTM3U\n" then, for each song,
//     "#EXTINF:<seconds or -1>,<artist> - <title>\n<fileName>\n".
//
//   writeM3u(folder, playlistName, entries, { fsImpl = fs.promises } = {})
//     -> Promise<string>: the path of the .m3u it wrote into folder (UTF-8,
//     LF line endings), replacing an older one. It is named after
//     playlistName made FAT32-safe ("playlist" when nothing is left), and
//     written atomically: to "<name>.m3u.tmp" first, then renamed. fsImpl
//     needs rm, writeFile (called with { encoding: 'utf8', flag: 'wx' }) and
//     rename, like fs.promises; tests pass fakes.
//
// A bad count, number, name or entry throws a RangeError or TypeError (and
// writeM3u rejects with it) instead of producing a wrong file name. Drive
// errors from writeM3u (ENOSPC, EIO…) are passed on unchanged.
//
// Wiring notes for server.js:
//   - songsFromPicks numbers picked songs from 1, so numbering them into a
//     playlist folder needs each song's CSV number and the CSV's song count
//   - write the .m3u only once a song is saved: an empty playlist folder is
//     removed with rmdir, which a lone .m3u would block
//   - in a picked folder (isExactFolder), add the .m3u's name to the files
//     whose "._" twins removeMacLeftovers clears

const fs = require('fs')
const path = require('path')
const { inspect } = require('util')

// "01"-"09" must sort before "10", so a track number never has fewer digits
const MIN_TRACK_DIGITS = 2
// between a track number and the name, and between an artist and a title
const SEPARATOR = ' - '
const SONG_EXTENSION = '.mp3'
// Only a 1-4 digit number before " - " counts as a track number this app
// added, so titles such as "52 Bars" or "99 Problems" keep theirs
const TRACK_PREFIX = /^\d{1,4} - /

const M3U_HEADER = '#EXTM3U'
const M3U_EXTENSION = '.m3u'
// what #EXTINF says when a song's length isn't known
const UNKNOWN_DURATION = -1
// A line break in a title would start a new playlist line, so a title could
// add entries of its own. Some players (e.g. ones built on Python's
// splitlines) also break lines at other control characters and at the
// Unicode line and paragraph separators, so all of those are flattened.
const LINE_BREAKING_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu

// FAT32 (and Windows) refuse these characters in names, and control characters
const UNSAFE_NAME_CHARS = /[\/\\:*?"<>|\p{Cc}]/gu
const FALLBACK_PLAYLIST_NAME = 'playlist'
// Drives allow 255 bytes per name (FAT32: 255 UTF-16 units, never more than
// the UTF-8 bytes); stopping well short leaves room for ".m3u.tmp"
const MAX_PLAYLIST_NAME_BYTES = 200

// A wrong argument is a bug in the caller: failing loudly beats saving a song
// as "NaN - undefined.mp3" or numbering a playlist with the wrong width
function requireWholeNumber (value, name, min) {
  if (Number.isSafeInteger(value) && value >= min) return
  throw new RangeError(`${name} must be a whole number from ${min} up (got ${inspect(value)})`)
}

function requireText (value, name) {
  if (typeof value === 'string' && value.trim() !== '') return
  throw new TypeError(`${name} must be a non-empty string (got ${inspect(value)})`)
}

// --- numbered song files ---

function trackPrefixWidth (totalCount) {
  requireWholeNumber(totalCount, 'totalCount', 0)
  return Math.max(MIN_TRACK_DIGITS, String(totalCount).length)
}

function numberedFileName (number, totalCount, baseName) {
  requireWholeNumber(number, 'number', 1)
  requireText(baseName, 'baseName')
  // padStart never cuts, so a number wider than the count stays whole
  const trackNumber = String(number).padStart(trackPrefixWidth(totalCount), '0')
  return `${trackNumber}${SEPARATOR}${baseName}${SONG_EXTENSION}`
}

function stripTrackPrefix (fileName) {
  if (typeof fileName !== 'string') {
    throw new TypeError(`fileName must be a string (got ${inspect(fileName)})`)
  }
  return fileName.replace(TRACK_PREFIX, '')
}

// Numbered first: that's the name a car-ready run saves under
function songFileNames (number, totalCount, baseName) {
  return [numberedFileName(number, totalCount, baseName), `${baseName}${SONG_EXTENSION}`]
}

// --- the .m3u playlist ---

// Text for one playlist line: line breaks become spaces (see LINE_BREAKING_CHARS)
function singleLine (value) {
  return String(value ?? '').replace(LINE_BREAKING_CHARS, ' ').trim()
}

// #EXTINF lengths are whole seconds, or -1 when unknown
function extinfSeconds (durationSec) {
  const seconds = Math.round(Number(durationSec))
  return Number.isFinite(seconds) && seconds > 0 ? seconds : UNKNOWN_DURATION
}

// The song's file as the playlist names it: just the name, relative to the
// playlist, so it works wherever the drive is mounted ("/Volumes/NO NAME",
// "E:\", the stereo's own path). Players skip lines starting with "#" as
// comments, so "#thatPOWER.mp3" is written as "./#thatPOWER.mp3".
function playlistFileLine (fileName, position) {
  const name = typeof fileName === 'string' ? singleLine(path.basename(fileName)) : ''
  if (!name) throw new TypeError(`Song ${position} in the playlist has no fileName`)
  return name.startsWith('#') ? `./${name}` : name
}

// "Arijit Singh - Tum Hi Ho"; only the title when there's no artist, and the
// file's own name when there's neither
function songLabel ({ title, artist }, fileLine) {
  const label = [singleLine(artist), singleLine(title)].filter(Boolean).join(SEPARATOR)
  return label || path.parse(fileLine).name
}

function m3uEntry (entry, index) {
  const position = index + 1
  if (entry === null || typeof entry !== 'object') {
    throw new TypeError(
      `Song ${position} in the playlist must be a { fileName, title, artist } object`
    )
  }
  const fileLine = playlistFileLine(entry.fileName, position)
  const extinf = `#EXTINF:${extinfSeconds(entry.durationSec)},${songLabel(entry, fileLine)}`
  return `${extinf}\n${fileLine}\n`
}

function buildM3u (entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError(`buildM3u needs an array of songs (got ${inspect(entries)})`)
  }
  return `${M3U_HEADER}\n${entries.map(m3uEntry).join('')}`
}

// --- writing it into the playlist folder ---

// Cut text to at most maxBytes of UTF-8, between whole characters, so an
// emoji or a Hindi letter is never left as half a character
function truncateToBytes (text, maxBytes) {
  let bytes = 0
  let end = 0
  for (const char of text) {
    bytes += Buffer.byteLength(char)
    if (bytes > maxBytes) break
    end += char.length
  }
  return text.slice(0, end)
}

// The playlist's file name without ".m3u", safe on a FAT32 pen drive: no
// characters drives refuse, no leading dot (that hides the file, and a "._"
// name reads as a macOS metadata twin, which the app deletes), short enough
// for any drive, and "playlist" when nothing is left
function playlistFileBase (playlistName) {
  const cleaned = String(playlistName ?? '')
    .replace(UNSAFE_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
  return truncateToBytes(cleaned, MAX_PLAYLIST_NAME_BYTES).trimEnd() || FALLBACK_PLAYLIST_NAME
}

// Remove a leftover file. A failure is logged rather than thrown, so the
// caller sees the error that made the clean-up necessary.
async function removeLeftover (filePath, fsImpl) {
  try {
    await fsImpl.rm(filePath, { force: true })
  } catch (rmErr) {
    console.warn(`Could not remove ${filePath}:`, rmErr instanceof Error ? rmErr.message : rmErr)
  }
}

// Readers see the old file or the new one, never half of one: the text goes
// to "<file>.tmp" first and is then renamed over the file. If either step
// fails (e.g. the pen drive is full), the .tmp is removed again.
async function writeFileAtomically (filePath, text, fsImpl) {
  const tempPath = `${filePath}.tmp`
  // A .tmp left by an earlier crash goes first, so "wx" can then insist on a
  // brand-new file: a link someone put under that name is never written
  // through to the file it points at
  await fsImpl.rm(tempPath, { force: true })
  try {
    await fsImpl.writeFile(tempPath, text, { encoding: 'utf8', flag: 'wx' })
    await fsImpl.rename(tempPath, filePath)
  } catch (err) {
    await removeLeftover(tempPath, fsImpl)
    throw err
  }
}

async function writeM3u (folder, playlistName, entries, { fsImpl = fs.promises } = {}) {
  // an empty folder would resolve to the app's own working folder
  requireText(folder, 'folder')
  // bad songs are refused before the drive is touched
  const text = buildM3u(entries)
  const m3uPath = path.join(folder, `${playlistFileBase(playlistName)}${M3U_EXTENSION}`)
  await writeFileAtomically(m3uPath, text, fsImpl)
  return m3uPath
}

module.exports = {
  trackPrefixWidth,
  numberedFileName,
  stripTrackPrefix,
  songFileNames,
  buildM3u,
  writeM3u
}
