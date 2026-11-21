// Reusing songs already on the drive. Playlists overlap (the same song in
// World, Hollywood and India), so before downloading a song a folder job can
// look for it in the other playlist folders and copy it instead.
//
// Meant to be used by server.js for folder jobs, roughly:
//   const library = await buildLibraryIndex(path.dirname(job.outputFolder), {
//     excludeFolder: job.outputFolder
//   })
//   // then for each song ({ title, artist, durationSec, ... }), before YouTube:
//   const hit = findInLibrary(library, song)
//   if (hit) await copyIntoPlaylist(hit.path, path.join(songsFolder, `${fileBase}.mp3`))
//
// API
//   readId3Tags(filePath) -> Promise<{ title, artist, durationSec|null } | null>
//     A song file's tags; see id3-reader.js. Never rejects.
//
//   buildLibraryIndex(rootFolder, { maxDepth = 2, excludeFolder = null,
//       readTags = readId3Tags, maxFiles = 20000, log = console.log } = {})
//     -> Promise<Index>
//     Reads the tags of every *.mp3 in rootFolder (depth 0) and its
//     subfolders down to maxDepth (2 reaches rootFolder/a/b/*.mp3), in name
//     order. Skips hidden files and folders ("._x.mp3", ".zipify-work-…",
//     .Trashes) and excludeFolder (the playlist being filled) with all that's
//     inside it; folders are compared ignoring case, as FAT32 and macOS do,
//     so excluding rootFolder itself leaves nothing to index. Stops after
//     maxFiles MP3s. A folder or file that can't be read is skipped with a
//     log line, so a missing or unplugged drive gives an empty index rather
//     than an error. readTags(filePath, { log }) may be swapped for a fake.
//
//   Index = {
//     rootFolder,   the absolute path that was scanned
//     fileCount,    MP3s looked at
//     songCount,    of those, songs with a title to match on
//     isTruncated,  true when maxFiles cut the scan short
//     byTitle       Map looseText(title) -> [{ path, title, artist, durationSec }],
//                   each list in path order
//   }
//
//   findInLibrary(index, { title, artist, durationSec }) -> { path, title, artist } | null
//     Only a confident match: the same looseText(title); at least one of
//     splitArtists(artist) found, as whole words, among the song's artists
//     (featured ones count); not another version of it (live, remix,
//     slowed… on one side only); and lengths within 10 s when both are
//     known. Several matches: the first by path. A missing index (e.g. a
//     ZIP job), title or artist finds nothing.
//
//   copyIntoPlaylist(sourcePath, targetPath, { fsImpl = fs.promises,
//       log = console.log } = {}) -> Promise<void>
//     Copies to "<target>.part" (COPYFILE_EXCL), then renames that into
//     place, so a half-copied song never sits under a song's name. Never
//     overwrites anything: rejects with code 'EEXIST' when targetPath (or a
//     .part this call didn't write) is already there. On any failure its own
//     .part is removed and the error passed on.

const fs = require('fs')
const path = require('path')
const { looseText, splitArtists, scoreCandidate } = require('./matching')
const { readId3Tags } = require('./id3-reader')

// a drive full of other things mustn't hold a job up for minutes
const MAX_LIBRARY_FILES = 20000
// playlist folders sit right under the chosen folder; one level more is spare
const DEFAULT_MAX_DEPTH = 2
// how far apart the two lengths may be, when both are known
const MAX_DURATION_DIFF_SEC = 10
// files read at once: on a USB drive most of each read is spent waiting
const TAG_READS_AT_ONCE = 4
const PART_SUFFIX = '.part'
const MP3_NAME = /\.mp3$/i

// ---------- building the index ----------

async function buildLibraryIndex (
  rootFolder,
  {
    maxDepth = DEFAULT_MAX_DEPTH,
    excludeFolder = null,
    readTags = readId3Tags,
    maxFiles = MAX_LIBRARY_FILES,
    log = console.log
  } = {}
) {
  const root = path.resolve(rootFolder)
  const scan = { maxDepth, excludedKey: excludeFolder ? folderKey(excludeFolder) : null, log }

  // looking for one more than allowed tells whether any were left out
  const found = await findMp3Files(root, 0, maxFiles + 1, scan)
  const isTruncated = found.length > maxFiles
  if (isTruncated) log(`Stopped looking for songs to reuse after ${maxFiles} MP3s in ${root}`)

  const files = found.slice(0, maxFiles)
  const songs = await readSongs(files, readTags, log)
  return {
    rootFolder: root,
    fileCount: files.length,
    songCount: songs.length,
    isTruncated,
    byTitle: groupByTitle(songs)
  }
}

// The *.mp3 files in `folder` and its subfolders down to maxDepth, at most
// `budget` of them, in name order so every run sees the same files
async function findMp3Files (folder, depth, budget, scan) {
  if (folderKey(folder) === scan.excludedKey) return []

  const entries = (await listFolder(folder, scan.log))
    .filter((entry) => !entry.name.startsWith('.')) // "._" twins, .zipify-work-…, .Trashes
    .sort(byName)
  const here = entries
    .filter((entry) => entry.isFile() && MP3_NAME.test(entry.name))
    .map((entry) => path.join(folder, entry.name))
    .slice(0, budget)
  if (depth >= scan.maxDepth) return here

  // symlinked folders aren't directories here, so a link loop can't trap the scan
  let found = here
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    if (found.length >= budget) break
    const subfolder = path.join(folder, entry.name)
    found = [...found, ...(await findMp3Files(subfolder, depth + 1, budget - found.length, scan))]
  }
  return found
}

// An unreadable folder (no permission, a drive pulled out) shouldn't stop
// the songs elsewhere being reused: skip it, but say so
async function listFolder (folder, log) {
  try {
    return await fs.promises.readdir(folder, { withFileTypes: true })
  } catch (err) {
    log(`Skipping unreadable folder ${folder}:`, err.message)
    return []
  }
}

// FAT32 drives and macOS ignore case in names, and may hand accented names
// back decomposed, so folders are compared the same way
function folderKey (folder) {
  return path.resolve(folder).normalize('NFC').toLowerCase()
}

// plain code-unit order: the same on every machine, unlike localeCompare
function compareText (a, b) {
  if (a < b) return -1
  return a > b ? 1 : 0
}

function byName (a, b) {
  return compareText(a.name, b.name)
}

// The files' tags as library songs; files with no title to match on are left out
async function readSongs (files, readTags, log) {
  const tags = await mapWithLimit(files, TAG_READS_AT_ONCE, (file) =>
    readTagsSafely(file, readTags, log)
  )
  return files.map((file, i) => toSong(file, tags[i])).filter(Boolean)
}

// readId3Tags never throws, but a stand-in might: one bad file mustn't sink
// the whole index
async function readTagsSafely (file, readTags, log) {
  try {
    return await readTags(file, { log })
  } catch (err) {
    log(`Could not read the tags of ${file}:`, err.message)
    return null
  }
}

function toSong (file, tags) {
  const title = String(tags?.title ?? '').trim()
  if (!looseText(title)) return null
  return {
    path: file,
    title,
    artist: String(tags.artist ?? '').trim(),
    durationSec: positiveOrNull(tags.durationSec)
  }
}

// looseText(title) -> its songs, in path order so the first match is the
// same every run
function groupByTitle (songs) {
  return [...songs]
    .sort((a, b) => compareText(a.path, b.path))
    .reduce((byTitle, song) => {
      const key = looseText(song.title)
      return byTitle.set(key, [...(byTitle.get(key) ?? []), song])
    }, new Map())
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

// ---------- finding a song ----------

function findInLibrary (index, { title, artist, durationSec } = {}) {
  const key = looseText(title ?? '')
  const wantedArtists = splitArtists(artist ?? '')
  if (!index || !key || wantedArtists.length === 0) return null

  const match = (index.byTitle.get(key) ?? []).find(
    (song) =>
      sharesAnArtist(wantedArtists, song.artist) &&
      isSameVersion(title, song.title) &&
      isCloseInLength(durationSec, song.durationSec)
  )
  return match ? { path: match.path, title: match.title, artist: match.artist } : null
}

// One of the wanted artists among the song's, as whole words ("ali" is not
// "alicia keys"). Every name counts, featured ones too: "A feat. B" has B.
function sharesAnArtist (wantedArtists, songArtist) {
  const songArtists = ` ${splitArtists(songArtist).join(' ')} `
  return wantedArtists.some((name) => songArtists.includes(` ${name} `))
}

// looseText drops bracketed words, so "Song (Live)" and "Song (Remix)" both
// read as "song". matching.js knows the words that mark another version; one
// on one side only means a different recording, which mustn't be copied in
// silently in place of the song.
function isSameVersion (wantedTitle, songTitle) {
  const onlyInSong = scoreCandidate({ title: songTitle }, { title: wantedTitle }).variant
  const onlyInWanted = scoreCandidate({ title: wantedTitle }, { title: songTitle }).variant
  return onlyInSong.length === 0 && onlyInWanted.length === 0
}

function isCloseInLength (wantedSec, songSec) {
  const wanted = positiveOrNull(wantedSec)
  const song = positiveOrNull(songSec)
  return wanted === null || song === null || Math.abs(wanted - song) <= MAX_DURATION_DIFF_SEC
}

function positiveOrNull (value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

// ---------- copying a song into the playlist ----------

async function copyIntoPlaylist (
  sourcePath,
  targetPath,
  { fsImpl = fs.promises, log = console.log } = {}
) {
  const partPath = `${targetPath}${PART_SUFFIX}`

  try {
    await fsImpl.copyFile(sourcePath, partPath, fs.constants.COPYFILE_EXCL)
  } catch (err) {
    // EEXIST: that .part is another copy's (or a crashed run's), not ours to remove
    if (err.code !== 'EEXIST') await removePart(partPath, fsImpl, log)
    throw err
  }

  try {
    // rename would silently replace a file that's already there, so look first
    await failIfExists(targetPath, fsImpl)
    await fsImpl.rename(partPath, targetPath)
  } catch (err) {
    await removePart(partPath, fsImpl, log)
    throw err
  }
}

// Rejects with code 'EEXIST', as fs itself would, when something is already
// at filePath
async function failIfExists (filePath, fsImpl) {
  try {
    await fsImpl.lstat(filePath)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  throw Object.assign(new Error(`EEXIST: file already exists, ${filePath}`), {
    code: 'EEXIST',
    path: filePath
  })
}

// The error the caller hears about is the copy's. If even removing the .part
// fails (the drive was pulled out), that is only logged.
async function removePart (partPath, fsImpl, log) {
  try {
    await fsImpl.rm(partPath, { force: true })
  } catch (err) {
    log(`Could not remove ${partPath}:`, err.message)
  }
}

module.exports = {
  readId3Tags,
  buildLibraryIndex,
  findInLibrary,
  copyIntoPlaylist
}
