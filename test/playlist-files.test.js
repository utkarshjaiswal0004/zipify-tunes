const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  trackPrefixWidth,
  numberedFileName,
  stripTrackPrefix,
  songFileNames,
  buildM3u,
  writeM3u
} = require('../playlist-files')

// Two songs as server.js hands them over: already in the playlist's order
const SONGS = [
  { fileName: '001 - Tum Hi Ho.mp3', title: 'Tum Hi Ho', artist: 'Arijit Singh', durationSec: 262 },
  { fileName: '002 - Kesariya.mp3', title: 'Kesariya', artist: 'Pritam, Arijit Singh', durationSec: 268 }
]

// Characters some players also start a new line at. They're built from their
// code points because, typed into this file, they'd be invisible (and one of
// them inside a regex literal ends the line, which is a syntax error).
const NEXT_LINE = String.fromCodePoint(0x85)
const LINE_SEPARATOR = String.fromCodePoint(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029)
// what bytes cut in the middle of a character decode to
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd)

// The file operations writeM3u uses, for tests that make one of them fail
const realFs = {
  writeFile: fs.promises.writeFile,
  rename: fs.promises.rename,
  rm: fs.promises.rm
}

// A fresh folder under the system temp folder, deleted when the test ends
function makeTempFolder (t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'zipify-playlist-'))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  return folder
}

// An error shaped like Node's own fs errors, e.g. ENOSPC for a full drive
function fsError (code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

// The playlist lines a player reads as files (every line not starting with #)
function fileLines (m3u) {
  return m3u.split('\n').filter((line) => line !== '' && !line.startsWith('#'))
}

// The "#EXTINF:<seconds>,<label>" lines of a playlist
function extinfLines (m3u) {
  return m3u.split('\n').filter((line) => line.startsWith('#EXTINF:'))
}

// --- how many digits a track number gets ---

test('track numbers have at least two digits, so 01-09 sort before 10', () => {
  assert.equal(trackPrefixWidth(1), 2)
  assert.equal(trackPrefixWidth(9), 2)
  assert.equal(trackPrefixWidth(99), 2)
})

test('a playlist of 500 songs gets three-digit track numbers', () => {
  assert.equal(trackPrefixWidth(100), 3)
  assert.equal(trackPrefixWidth(500), 3)
  assert.equal(trackPrefixWidth(999), 3)
})

test('a playlist of 1200 songs gets four-digit track numbers', () => {
  assert.equal(trackPrefixWidth(1200), 4)
})

test('an empty playlist still gets the two-digit minimum', () => {
  assert.equal(trackPrefixWidth(0), 2)
})

test('a missing or broken song count is an error, not a guessed width', () => {
  for (const badCount of [undefined, null, NaN, -1, 2.5, '500', Infinity]) {
    assert.throws(() => trackPrefixWidth(badCount), RangeError)
  }
})

// --- numbered file names ---

test('a song is saved as "<number> - <name>.mp3", padded to the playlist size', () => {
  assert.equal(numberedFileName(7, 500, 'Tum Hi Ho'), '007 - Tum Hi Ho.mp3')
  assert.equal(numberedFileName(3, 12, 'Kesariya'), '03 - Kesariya.mp3')
  assert.equal(numberedFileName(1200, 1200, 'Last Song'), '1200 - Last Song.mp3')
})

test('numbered names sort into the playlist order, as car stereos sort them', () => {
  // titles run backwards, so only the numbers can put them in order
  const names = Array.from({ length: 120 }, (_, i) =>
    numberedFileName(i + 1, 120, `Song ${120 - i}`)
  )

  const sorted = [...names].sort()

  assert.deepEqual(sorted, names)
})

test('a number wider than the playlist size is written in full, never cut', () => {
  assert.equal(numberedFileName(150, 99, 'Encore'), '150 - Encore.mp3')
})

test('a song number counts from 1 and the name must not be empty', () => {
  assert.throws(() => numberedFileName(0, 10, 'Song'), RangeError)
  assert.throws(() => numberedFileName(1.5, 10, 'Song'), RangeError)
  assert.throws(() => numberedFileName(undefined, 10, 'Song'), RangeError)
  assert.throws(() => numberedFileName(1, 10, ''), TypeError)
  assert.throws(() => numberedFileName(1, 10, '   '), TypeError)
  assert.throws(() => numberedFileName(1, 10, undefined), TypeError)
})

// --- taking the number off again ---

test('the track number comes off a numbered file name', () => {
  assert.equal(stripTrackPrefix('007 - Tum Hi Ho.mp3'), 'Tum Hi Ho.mp3')
  assert.equal(stripTrackPrefix('1 - Intro.mp3'), 'Intro.mp3')
  assert.equal(stripTrackPrefix('1200 - Last Song.mp3'), 'Last Song.mp3')
})

test('a title that merely starts with a number keeps it', () => {
  assert.equal(stripTrackPrefix('52 Bars.mp3'), '52 Bars.mp3')
  assert.equal(stripTrackPrefix('99 Problems.mp3'), '99 Problems.mp3')
  assert.equal(stripTrackPrefix('2-Step.mp3'), '2-Step.mp3')
  assert.equal(stripTrackPrefix('12345 - Five Digits.mp3'), '12345 - Five Digits.mp3')
})

test('an unnumbered name comes back unchanged', () => {
  assert.equal(stripTrackPrefix('Kesariya.mp3'), 'Kesariya.mp3')
})

test('taking the number off gives back the plain name, whatever the width', () => {
  for (const totalCount of [9, 500, 1200]) {
    const numbered = numberedFileName(7, totalCount, 'Tum Hi Ho')

    assert.equal(stripTrackPrefix(numbered), 'Tum Hi Ho.mp3')
  }
})

test('only the track number comes off, not a number that is part of the title', () => {
  const numbered = numberedFileName(1, 10, '1999 - Remastered')

  assert.equal(stripTrackPrefix(numbered), '1999 - Remastered.mp3')
})

test('taking a number off needs a file name', () => {
  assert.throws(() => stripTrackPrefix(undefined), TypeError)
  assert.throws(() => stripTrackPrefix(7), TypeError)
})

// --- names a song may already be saved under ---

test('a song may already be saved under its numbered name or its plain one', () => {
  assert.deepEqual(songFileNames(7, 500, 'Tum Hi Ho'), ['007 - Tum Hi Ho.mp3', 'Tum Hi Ho.mp3'])
})

test('a song saved before numbering was turned on is still found, so it is skipped', () => {
  const inFolder = new Set(['Tum Hi Ho.mp3', '002 - Kesariya.mp3'])
  const isSaved = (number, baseName) =>
    songFileNames(number, 500, baseName).some((name) => inFolder.has(name))

  assert.equal(isSaved(7, 'Tum Hi Ho'), true)
  assert.equal(isSaved(2, 'Kesariya'), true)
  assert.equal(isSaved(3, 'Apna Bana Le'), false)
})

// --- the .m3u playlist text ---

test('a playlist lists each song as an #EXTINF line and its file, in the given order', () => {
  const m3u = buildM3u(SONGS)

  assert.equal(
    m3u,
    '#EXTM3U\n' +
      '#EXTINF:262,Arijit Singh - Tum Hi Ho\n' +
      '001 - Tum Hi Ho.mp3\n' +
      '#EXTINF:268,Pritam, Arijit Singh - Kesariya\n' +
      '002 - Kesariya.mp3\n'
  )
})

test('the given order is kept even when it is not alphabetical', () => {
  const m3u = buildM3u([SONGS[1], SONGS[0]])

  assert.deepEqual(fileLines(m3u), ['002 - Kesariya.mp3', '001 - Tum Hi Ho.mp3'])
})

test('an empty list is just the header', () => {
  assert.equal(buildM3u([]), '#EXTM3U\n')
})

test('a length is written in whole seconds, and an unknown one as -1', () => {
  const m3u = buildM3u([
    { fileName: 'a.mp3', title: 'A', artist: 'X', durationSec: null },
    { fileName: 'b.mp3', title: 'B', artist: 'X' },
    { fileName: 'c.mp3', title: 'C', artist: 'X', durationSec: 0 },
    { fileName: 'd.mp3', title: 'D', artist: 'X', durationSec: 225.6 }
  ])

  const durations = extinfLines(m3u).map((line) =>
    line.slice('#EXTINF:'.length, line.indexOf(','))
  )

  assert.deepEqual(durations, ['-1', '-1', '-1', '226'])
})

test('songs are listed by file name alone, relative to the playlist file', () => {
  const m3u = buildM3u([
    { ...SONGS[0], fileName: '/Volumes/NO NAME/Road Trip/001 - Tum Hi Ho.mp3' }
  ])

  assert.deepEqual(fileLines(m3u), ['001 - Tum Hi Ho.mp3'])
  assert.doesNotMatch(m3u, /Volumes/)
})

test('line breaks in a title cannot add lines to the playlist', () => {
  const m3u = buildM3u([
    {
      fileName: '001 - Evil.mp3',
      title: 'Evil\r\n#EXTINF:1,Injected\r\n/etc/passwd',
      artist: 'Some\nOne',
      durationSec: 200
    },
    {
      fileName: `002 - Next${LINE_SEPARATOR}Line.mp3`,
      title: `Next${PARAGRAPH_SEPARATOR}Song`,
      artist: `Two${NEXT_LINE}Lines`,
      durationSec: 100
    }
  ])

  const lines = m3u.split('\n')

  assert.deepEqual(lines, [
    '#EXTM3U',
    '#EXTINF:200,Some One - Evil #EXTINF:1,Injected /etc/passwd',
    '001 - Evil.mp3',
    '#EXTINF:100,Two Lines - Next Song',
    '002 - Next Line.mp3',
    '' // after the final newline
  ])
  for (const lineBreak of ['\r', NEXT_LINE, LINE_SEPARATOR, PARAGRAPH_SEPARATOR]) {
    assert.equal(m3u.includes(lineBreak), false)
  }
})

test('a song without an artist is labelled by its title, one with neither by its file', () => {
  const m3u = buildM3u([
    { fileName: '001 - Intro.mp3', title: 'Intro', artist: '', durationSec: 60 },
    { fileName: '002 - Track 2.mp3', durationSec: 90 }
  ])

  assert.deepEqual(extinfLines(m3u), ['#EXTINF:60,Intro', '#EXTINF:90,002 - Track 2'])
})

test('a file name starting with # is not mistaken for a comment line', () => {
  const m3u = buildM3u([
    { fileName: '#thatPOWER.mp3', title: '#thatPOWER', artist: 'will.i.am', durationSec: 279 }
  ])

  assert.deepEqual(fileLines(m3u), ['./#thatPOWER.mp3'])
  assert.deepEqual(extinfLines(m3u), ['#EXTINF:279,will.i.am - #thatPOWER'])
})

test('every song in a playlist needs a file name', () => {
  assert.throws(() => buildM3u([{ title: 'No File' }]), TypeError)
  assert.throws(() => buildM3u([{ fileName: '', title: 'Empty' }]), TypeError)
  assert.throws(() => buildM3u([{ fileName: '\n', title: 'Only A Line Break' }]), TypeError)
  assert.throws(() => buildM3u([null]), TypeError)
  assert.throws(() => buildM3u('001 - Song.mp3'), TypeError)
})

// --- writing the .m3u file into the playlist folder ---

test('writes "<playlist>.m3u" into the folder and returns its path', async (t) => {
  const folder = makeTempFolder(t)

  const m3uPath = await writeM3u(folder, 'Road Trip', SONGS)

  assert.equal(m3uPath, path.join(folder, 'Road Trip.m3u'))
  assert.equal(fs.readFileSync(m3uPath, 'utf8'), buildM3u(SONGS))
})

test('the playlist file is UTF-8 with LF line endings', async (t) => {
  const folder = makeTempFolder(t)
  const songs = [
    { fileName: '01 - तुम ही हो.mp3', title: 'तुम ही हो', artist: 'अरिजीत सिंह', durationSec: 262 }
  ]

  const m3uPath = await writeM3u(folder, 'Hindi Hits', songs)

  const bytes = fs.readFileSync(m3uPath)
  assert.deepEqual(bytes, Buffer.from(buildM3u(songs), 'utf8'))
  assert.equal(bytes.includes(0x0d), false) // no CR anywhere
})

test('the text goes to a .tmp file first and is renamed into place', async (t) => {
  const folder = makeTempFolder(t)
  const writeFile = t.mock.fn(realFs.writeFile)
  const rename = t.mock.fn(realFs.rename)

  await writeM3u(folder, 'Road Trip', SONGS, { fsImpl: { ...realFs, writeFile, rename } })

  const tempPath = path.join(folder, 'Road Trip.m3u.tmp')
  assert.equal(writeFile.mock.callCount(), 1)
  assert.equal(writeFile.mock.calls[0].arguments[0], tempPath)
  assert.deepEqual(rename.mock.calls[0].arguments, [tempPath, path.join(folder, 'Road Trip.m3u')])
  assert.deepEqual(fs.readdirSync(folder), ['Road Trip.m3u']) // no .tmp left behind
})

test('a later run replaces the playlist file of an earlier one', async (t) => {
  const folder = makeTempFolder(t)
  const m3uPath = path.join(folder, 'Road Trip.m3u')
  fs.writeFileSync(m3uPath, '#EXTM3U\nold.mp3\n')

  await writeM3u(folder, 'Road Trip', SONGS)

  assert.equal(fs.readFileSync(m3uPath, 'utf8'), buildM3u(SONGS))
  assert.deepEqual(fs.readdirSync(folder), ['Road Trip.m3u'])
})

test('a .tmp left behind by an earlier crash is replaced', async (t) => {
  const folder = makeTempFolder(t)
  fs.writeFileSync(path.join(folder, 'Road Trip.m3u.tmp'), '#EXTM3U\nhalf a playl')

  const m3uPath = await writeM3u(folder, 'Road Trip', SONGS)

  assert.equal(fs.readFileSync(m3uPath, 'utf8'), buildM3u(SONGS))
  assert.deepEqual(fs.readdirSync(folder), ['Road Trip.m3u'])
})

test('a link left under the .tmp name is replaced, never written through', async (t) => {
  const folder = makeTempFolder(t)
  const otherFile = path.join(folder, 'notes.txt')
  fs.writeFileSync(otherFile, 'keep me')
  fs.symlinkSync(otherFile, path.join(folder, 'Road Trip.m3u.tmp'))

  const m3uPath = await writeM3u(folder, 'Road Trip', SONGS)

  assert.equal(fs.readFileSync(otherFile, 'utf8'), 'keep me')
  assert.equal(fs.lstatSync(m3uPath).isFile(), true)
  assert.equal(fs.readFileSync(m3uPath, 'utf8'), buildM3u(SONGS))
  assert.deepEqual(fs.readdirSync(folder).sort(), ['Road Trip.m3u', 'notes.txt'])
})

test('a drive that fills up mid-write keeps the old playlist and no .tmp', async (t) => {
  const folder = makeTempFolder(t)
  const m3uPath = path.join(folder, 'Road Trip.m3u')
  fs.writeFileSync(m3uPath, '#EXTM3U\nold.mp3\n')
  const fullDrive = {
    ...realFs,
    writeFile: async (file, text) => {
      await realFs.writeFile(file, text.slice(0, 10)) // part of it landed
      throw fsError('ENOSPC', 'no space left on device, write')
    }
  }

  await assert.rejects(writeM3u(folder, 'Road Trip', SONGS, { fsImpl: fullDrive }), {
    code: 'ENOSPC'
  })

  assert.equal(fs.readFileSync(m3uPath, 'utf8'), '#EXTM3U\nold.mp3\n')
  assert.deepEqual(fs.readdirSync(folder), ['Road Trip.m3u'])
})

test('a failed rename is reported and leaves no .tmp behind', async (t) => {
  const folder = makeTempFolder(t)
  const brokenRename = async () => {
    throw fsError('EIO', 'i/o error, rename')
  }

  await assert.rejects(
    writeM3u(folder, 'Road Trip', SONGS, { fsImpl: { ...realFs, rename: brokenRename } }),
    { code: 'EIO' }
  )

  assert.deepEqual(fs.readdirSync(folder), [])
})

test('a failed clean-up is logged and does not hide why the write failed', async (t) => {
  const folder = makeTempFolder(t)
  const warn = t.mock.method(console, 'warn', () => {})
  const brokenDrive = {
    ...realFs,
    rename: async () => {
      throw fsError('EIO', 'i/o error, rename')
    },
    // the drive won't delete anything that is there
    rm: async (file, options) => {
      if (fs.existsSync(file)) throw fsError('EROFS', 'read-only file system, rm')
      return realFs.rm(file, options)
    }
  }

  await assert.rejects(writeM3u(folder, 'Road Trip', SONGS, { fsImpl: brokenDrive }), {
    code: 'EIO'
  })

  assert.equal(warn.mock.callCount(), 1)
  assert.match(warn.mock.calls[0].arguments.join(' '), /Road Trip\.m3u\.tmp.*EROFS/)
})

test('bad songs are refused before anything is written', async (t) => {
  const folder = makeTempFolder(t)

  await assert.rejects(writeM3u(folder, 'Road Trip', [{ title: 'No File' }]), TypeError)

  assert.deepEqual(fs.readdirSync(folder), [])
})

test('writing needs the playlist folder, so it never lands in the app folder', async () => {
  await assert.rejects(writeM3u('', 'Road Trip', SONGS), TypeError)
  await assert.rejects(writeM3u(undefined, 'Road Trip', SONGS), TypeError)
})

// --- the playlist's own file name ---

test('the playlist file name is safe on a FAT32 pen drive', async (t) => {
  const folder = makeTempFolder(t)

  const m3uPath = await writeM3u(folder, '..Hits: 90s/00s? "Best" <Mix> | *Car*\t\\', SONGS)

  const name = path.basename(m3uPath)
  assert.equal(name, 'Hits 90s 00s Best Mix Car.m3u')
  assert.doesNotMatch(name, /[\/\\:*?"<>|\x00-\x1f\x7f]/)
  assert.equal(fs.existsSync(m3uPath), true)
})

test('a playlist name cannot write outside the playlist folder', async (t) => {
  const folder = makeTempFolder(t)

  const m3uPath = await writeM3u(folder, '../../escape', SONGS)

  assert.equal(path.dirname(m3uPath), folder)
  assert.equal(path.basename(m3uPath), 'escape.m3u')
})

test('an empty or dots-only playlist name falls back to "playlist"', async (t) => {
  const folder = makeTempFolder(t)

  for (const playlistName of ['', '...', '   ', '/', null, undefined]) {
    const m3uPath = await writeM3u(folder, playlistName, SONGS)

    assert.equal(path.basename(m3uPath), 'playlist.m3u')
  }
})

test('a very long playlist name is shortened to fit, between whole characters', async (t) => {
  const folder = makeTempFolder(t)

  const m3uPath = await writeM3u(folder, 'गाना 🎵 '.repeat(60), SONGS)

  const name = path.basename(m3uPath)
  assert.ok(Buffer.byteLength(`${name}.tmp`) <= 255, 'drives allow 255 bytes per name')
  assert.ok(name.startsWith('गाना 🎵 गाना 🎵'))
  assert.ok(name.endsWith('.m3u'))
  assert.ok(name.isWellFormed()) // no half emoji
  assert.equal(name.includes(REPLACEMENT_CHARACTER), false) // no half Hindi letter
  assert.equal(fs.existsSync(m3uPath), true)
})
