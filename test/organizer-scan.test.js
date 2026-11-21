// organizer/tags.js reads what the organizer sorts and renames by from an
// MP3: its ID3 tags, whether it has a cover, and its length (TLEN, or worked
// out from the MPEG audio). organizer/scan.js walks a folder and lists its
// songs with those tags. These tests write small fake MP3s (real ID3 tags and
// MPEG frame headers around silent audio) into temp folders; no real drive
// is touched.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { readSongTags, parseId3v2, parseId3v1, estimateDurationSec } = require('../organizer/tags')
const { scanFolder, songIdFor, inspectTargets } = require('../organizer/scan')

// ---------- hand-made ID3 tags ----------

// text encodings (a text frame's first byte)
const LATIN1 = 0
const UTF16_WITH_BOM = 1
const UTF8 = 3
const TAG_UNSYNC = 0x80
const KB = 1024

function syncsafe (n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
}

function uint32 (n) {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(n)
  return bytes
}

function uint24 (n) {
  return Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
}

function encodeText (text, encoding) {
  if (encoding === UTF16_WITH_BOM) {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  }
  if (encoding === UTF8) return Buffer.from(text, 'utf8')
  return Buffer.from(text, 'latin1')
}

// v2.2: 3-letter name, 3-byte size; v2.3: 4 letters, plain 32-bit size;
// v2.4: 4 letters, syncsafe size. v2.3 and v2.4 add two flag bytes.
function frame (version, id, content) {
  if (version === 2) return Buffer.concat([Buffer.from(id, 'latin1'), uint24(content.length), content])
  const size = version === 4 ? syncsafe(content.length) : uint32(content.length)
  return Buffer.concat([Buffer.from(id, 'latin1'), size, Buffer.from([0, 0]), content])
}

function textFrame (version, id, text, encoding = LATIN1) {
  return frame(version, id, Buffer.concat([Buffer.from([encoding]), encodeText(text, encoding)]))
}

// a front cover: APIC (PIC in v2.2) around imageBytes
function coverFrame (version, imageBytes) {
  const format = version === 2 ? 'JPG' : 'image/jpeg\u0000'
  const head = Buffer.concat([Buffer.from([LATIN1]), Buffer.from(format, 'latin1'), Buffer.from([3, 0])])
  return frame(version, version === 2 ? 'PIC' : 'APIC', Buffer.concat([head, imageBytes]))
}

function unsync (bytes) {
  return Buffer.from([...bytes].flatMap((byte) => (byte === 0xff ? [0xff, 0x00] : [byte])))
}

function id3Tag (version, frames, { flags = 0, padding = 64 } = {}) {
  const plain = Buffer.concat([...frames, Buffer.alloc(padding)])
  const body = flags & TAG_UNSYNC ? unsync(plain) : plain
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([version, 0, flags]), syncsafe(body.length), body])
}

// the frames ffmpeg writes for this app (ID3v2.3), cover last
function songTag ({ title, artist, album, genre, year, track, lengthMs, cover }) {
  const frames = [
    title != null && textFrame(3, 'TIT2', title),
    artist != null && textFrame(3, 'TPE1', artist),
    album != null && textFrame(3, 'TALB', album),
    genre != null && textFrame(3, 'TCON', genre),
    year != null && textFrame(3, 'TYER', year),
    track != null && textFrame(3, 'TRCK', track),
    lengthMs != null && textFrame(3, 'TLEN', String(lengthMs)),
    cover && coverFrame(3, cover)
  ]
  return id3Tag(3, frames.filter(Boolean))
}

function id3v1Tag ({ title = '', artist = '', album = '', year = '', track = 0, genre = 255 }) {
  const tag = Buffer.alloc(128)
  tag.write('TAG', 0, 'latin1')
  tag.write(title, 3, 30, 'latin1')
  tag.write(artist, 33, 30, 'latin1')
  tag.write(album, 63, 30, 'latin1')
  tag.write(year, 93, 4, 'latin1')
  tag[126] = track // ID3v1.1: a zero, then the track number, end the comment
  tag[127] = genre
  return tag
}

// ---------- hand-made MPEG audio ----------

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, joint stereo, no padding: 417 bytes a
// frame, 1152 samples each
const FRAME_HEADER = Buffer.from([0xff, 0xfb, 0x90, 0x64])
const FRAME_BYTES = 417
// 384 frames are 160 128 bytes: 10.008 s at 128 kbps
const TEN_SECONDS = 384
// a stereo MPEG-1 frame's side information ends 4 + 32 bytes in
const VBR_HEADER_OFFSET = 36

function audioFrames (count) {
  const one = Buffer.concat([FRAME_HEADER, Buffer.alloc(FRAME_BYTES - FRAME_HEADER.length)])
  return Buffer.concat(Array.from({ length: count }, () => one))
}

// The first frame of a VBR file says how many frames there are: LAME writes
// "Xing" (or "Info"), Fraunhofer encoders "VBRI"
function xingFrame (frameCount) {
  const first = audioFrames(1)
  first.write('Xing', VBR_HEADER_OFFSET, 'latin1')
  first.writeUInt32BE(0x0001, VBR_HEADER_OFFSET + 4) // flags: the frame count is there
  first.writeUInt32BE(frameCount, VBR_HEADER_OFFSET + 8)
  return first
}

function vbriFrame (frameCount) {
  const first = audioFrames(1)
  first.write('VBRI', VBR_HEADER_OFFSET, 'latin1')
  first.writeUInt32BE(frameCount, VBR_HEADER_OFFSET + 14)
  return first
}

// ---------- temp files ----------

function makeTempFolder (t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'organizer-scan-'))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  return fs.realpathSync(folder)
}

function writeFile (filePath, ...parts) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, Buffer.concat(parts))
  return filePath
}

function writeSong (filePath, tags, seconds = 10) {
  return writeFile(filePath, songTag(tags), audioFrames(Math.round((TEN_SECONDS * seconds) / 10)))
}

function sha1Id (relPath) {
  return crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 16)
}

function quietLog () {
  const lines = []
  return { lines, log: (...parts) => lines.push(parts.join(' ')) }
}

// ---------- tags ----------

describe('readSongTags', () => {
  test('reads every tag of an ID3v2.3 tag as ffmpeg writes it, cover and length included', async (t) => {
    const file = writeSong(path.join(makeTempFolder(t), 'Tum Hi Ho.mp3'), {
      title: 'Tum Hi Ho',
      artist: 'Arijit Singh, Mithoon',
      album: 'Aashiqui 2',
      genre: 'Filmi',
      year: '2013',
      track: '3/12',
      cover: Buffer.alloc(2 * KB, 0xd8)
    })

    assert.deepEqual(await readSongTags(file), {
      title: 'Tum Hi Ho',
      artist: 'Arijit Singh, Mithoon',
      album: 'Aashiqui 2',
      year: '2013',
      genre: 'Filmi',
      track: 3,
      durationSec: 10,
      hasCover: true
    })
  })

  test('reads ID3v2.4 (TDRC dates, UTF-8, several values) and ID3v2.2 (three-letter frames)', async (t) => {
    const folder = makeTempFolder(t)
    const v24 = writeFile(
      path.join(folder, 'v24.mp3'),
      id3Tag(4, [
        textFrame(4, 'TIT2', 'Déjà Vu', UTF8),
        textFrame(4, 'TPE1', 'Pritam\u0000Arijit Singh', UTF8),
        textFrame(4, 'TALB', 'तुम ही हो', UTF16_WITH_BOM),
        textFrame(4, 'TCON', 'Rock\u0000Pop', UTF8),
        textFrame(4, 'TDRC', '2013-05-01', UTF8),
        textFrame(4, 'TRCK', '07', UTF8),
        coverFrame(4, Buffer.alloc(100))
      ]),
      audioFrames(TEN_SECONDS)
    )
    const v22 = writeFile(
      path.join(folder, 'v22.mp3'),
      id3Tag(2, [
        textFrame(2, 'TT2', 'Old Tag'),
        textFrame(2, 'TP1', 'Old Band'),
        textFrame(2, 'TAL', 'Old Album'),
        textFrame(2, 'TCO', '(17)'),
        textFrame(2, 'TYE', '1987'),
        textFrame(2, 'TRK', '5'),
        coverFrame(2, Buffer.alloc(100))
      ]),
      audioFrames(TEN_SECONDS)
    )

    assert.deepEqual(await readSongTags(v24), {
      title: 'Déjà Vu',
      artist: 'Pritam, Arijit Singh',
      album: 'तुम ही हो',
      year: '2013',
      genre: 'Rock',
      track: 7,
      durationSec: 10,
      hasCover: true
    })
    assert.deepEqual(await readSongTags(v22), {
      title: 'Old Tag',
      artist: 'Old Band',
      album: 'Old Album',
      year: '1987',
      genre: 'Rock',
      track: 5,
      durationSec: 10,
      hasCover: true
    })
  })

  test('turns ID3v1 genre numbers into names and keeps a refinement\'s own words', () => {
    const genreOf = (text) => parseId3v2(id3Tag(3, [textFrame(3, 'TIT2', 't'), textFrame(3, 'TCON', text)])).tags.genre

    assert.equal(genreOf('(17)'), 'Rock')
    assert.equal(genreOf('17'), 'Rock')
    assert.equal(genreOf('(13)(17)'), 'Pop')
    assert.equal(genreOf('(4)Eurodisco'), 'Eurodisco')
    assert.equal(genreOf('(RX)'), 'Remix')
    assert.equal(genreOf('((Brackets) Rock'), '(Brackets) Rock')
    assert.equal(genreOf('(80)'), 'Folk')
    assert.equal(genreOf('(147)'), 'Synthpop')
    assert.equal(genreOf('(151)'), 'Bhangra')
    assert.equal(genreOf('(191)'), 'Psybient')
    assert.equal(genreOf('(250)'), '')
    assert.equal(genreOf('Filmi'), 'Filmi')
  })

  test('the length comes from TLEN, else a Xing or VBRI frame count, else the bitrate and size', async (t) => {
    const folder = makeTempFolder(t)
    const withTlen = writeSong(path.join(folder, 'tlen.mp3'), { title: 'a', lengthMs: 215000 })
    const xing = writeFile(path.join(folder, 'xing.mp3'), songTag({ title: 'b' }), xingFrame(5000), audioFrames(3))
    const vbri = writeFile(path.join(folder, 'vbri.mp3'), songTag({ title: 'c' }), vbriFrame(2000), audioFrames(3))
    const cbr = writeSong(path.join(folder, 'cbr.mp3'), { title: 'd' }, 30)

    assert.equal((await readSongTags(withTlen)).durationSec, 215)
    // 5000 frames of 1152 samples at 44 100 Hz
    assert.equal((await readSongTags(xing)).durationSec, 131)
    assert.equal((await readSongTags(vbri)).durationSec, 52)
    assert.equal((await readSongTags(cbr)).durationSec, 30)
  })

  test('finds a cover whose picture runs past the first 256 KB, and the length after it', async (t) => {
    const file = writeSong(path.join(makeTempFolder(t), 'big cover.mp3'), {
      title: 'Big',
      artist: 'Cover',
      cover: Buffer.alloc(300 * KB, 0x11)
    })

    const tags = await readSongTags(file)
    assert.equal(tags.hasCover, true)
    assert.equal(tags.durationSec, 10)
    assert.equal(tags.title, 'Big')
  })

  test('falls back to the ID3v1 tag at the end, and fills in what ID3v2 left out', async (t) => {
    const folder = makeTempFolder(t)
    const v1Only = writeFile(
      path.join(folder, 'v1.mp3'),
      audioFrames(TEN_SECONDS),
      id3v1Tag({ title: 'Old Song', artist: 'Old Band', album: 'Old Album', year: '1987', track: 5, genre: 17 })
    )
    const both = writeFile(
      path.join(folder, 'both.mp3'),
      songTag({ title: 'A much longer title than ID3v1 can hold', artist: 'Band' }),
      audioFrames(TEN_SECONDS),
      id3v1Tag({ title: 'A much longer title than ID3v', artist: 'Band', album: 'From v1', genre: 13 })
    )

    assert.deepEqual(await readSongTags(v1Only), {
      title: 'Old Song',
      artist: 'Old Band',
      album: 'Old Album',
      year: '1987',
      genre: 'Rock',
      track: 5,
      durationSec: 10,
      hasCover: false
    })
    assert.deepEqual(await readSongTags(both), {
      title: 'A much longer title than ID3v1 can hold',
      artist: 'Band',
      album: 'From v1',
      year: '',
      genre: 'Pop',
      track: null,
      durationSec: 10,
      hasCover: false
    })
  })

  test('a file without tags still gets its length; one without audio gets none', async (t) => {
    const folder = makeTempFolder(t)
    const bare = writeFile(path.join(folder, 'bare.mp3'), audioFrames(TEN_SECONDS))
    const junk = writeFile(path.join(folder, 'junk.mp3'), Buffer.from('not an mp3 at all'))
    const empty = { title: '', artist: '', album: '', year: '', genre: '', track: null, hasCover: false }

    assert.deepEqual(await readSongTags(bare), { ...empty, durationSec: 10 })
    assert.deepEqual(await readSongTags(junk), { ...empty, durationSec: null })
  })

  test('steps over bytes that only look like the start of a frame', () => {
    const fake = Buffer.concat([FRAME_HEADER, Buffer.alloc(96, 0x22)])
    const audio = Buffer.concat([fake, audioFrames(TEN_SECONDS)])

    assert.equal(estimateDurationSec(audio.subarray(0, 16 * KB), audio.length), 10)
    assert.equal(estimateDurationSec(Buffer.alloc(4 * KB), 4 * KB), null)
  })

  test('undoes unsynchronisation and reads UTF-16 text', () => {
    const tag = id3Tag(3, [textFrame(3, 'TIT2', 'ÿes ÿ'), textFrame(3, 'TPE1', 'तुम', UTF16_WITH_BOM)], {
      flags: TAG_UNSYNC
    })

    const { tags, tagEnd } = parseId3v2(tag)
    assert.equal(tags.title, 'ÿes ÿ')
    assert.equal(tags.artist, 'तुम')
    assert.equal(tagEnd, tag.length)
  })

  test('parse helpers say null for bytes that are not tags', () => {
    assert.equal(parseId3v2(Buffer.from('RIFF....')), null)
    assert.equal(parseId3v1(Buffer.alloc(128)), null)
    assert.equal(parseId3v1(Buffer.alloc(10)), null)
  })

  test('rejects when the file cannot be read', async () => {
    await assert.rejects(readSongTags(path.join(os.tmpdir(), 'organizer-no-such-file.mp3')), { code: 'ENOENT' })
  })
})

// ---------- scanning a folder ----------

describe('scanFolder', () => {
  function makeLibrary (t) {
    const root = makeTempFolder(t)
    writeSong(path.join(root, 'A Song.mp3'), { title: 'A Song', artist: 'Band', year: '1999', track: '2' })
    writeFile(path.join(root, '._A Song.mp3'), Buffer.from('macOS metadata twin'))
    writeSong(path.join(root, '.hidden.mp3'), { title: 'Hidden', artist: 'Band' })
    writeFile(path.join(root, 'notes.txt'), Buffer.from('not a song'))
    writeSong(path.join(root, 'UPPER.MP3'), { title: 'Upper' })
    writeSong(path.join(root, 'Bollywood', 'Tum Hi Ho.mp3'), {
      title: 'Tum Hi Ho',
      artist: 'Arijit Singh',
      album: 'Aashiqui 2',
      genre: 'Filmi',
      cover: Buffer.alloc(KB)
    })
    writeSong(path.join(root, 'Bollywood', 'Deep', 'Deeper', 'Down.mp3'), { title: 'Down', artist: 'X' })
    writeSong(path.join(root, '_Duplicates', 'Set Aside.mp3'), { title: 'Set Aside', artist: 'X' })
    writeFile(path.join(root, '.zipify-organizer', 'journal-1.json'), Buffer.from('{}'))
    return root
  }

  test('lists every MP3 with its tags, folder by folder, skipping hidden files and _Duplicates', async (t) => {
    const root = makeLibrary(t)
    const result = await scanFolder(root, { log: quietLog().log })

    assert.equal(result.root, root)
    assert.equal(result.truncated, false)
    assert.deepEqual(
      result.songs.map((s) => s.relPath),
      ['A Song.mp3', 'UPPER.MP3', 'Bollywood/Tum Hi Ho.mp3', 'Bollywood/Deep/Deeper/Down.mp3']
    )

    const tumHiHo = result.songs[2]
    const filePath = path.join(root, 'Bollywood', 'Tum Hi Ho.mp3')
    assert.deepEqual(tumHiHo, {
      id: sha1Id('Bollywood/Tum Hi Ho.mp3'),
      path: filePath,
      relPath: 'Bollywood/Tum Hi Ho.mp3',
      folder: 'Bollywood',
      fileName: 'Tum Hi Ho.mp3',
      size: fs.statSync(filePath).size,
      mtimeMs: fs.statSync(filePath).mtimeMs,
      title: 'Tum Hi Ho',
      artist: 'Arijit Singh',
      album: 'Aashiqui 2',
      year: '',
      genre: 'Filmi',
      track: null,
      durationSec: 10,
      hasCover: true,
      tagged: true
    })
    assert.equal(result.songs[0].folder, '')
    assert.equal(result.songs[0].track, 2)
    assert.equal(result.songs[1].tagged, false) // a title but no artist
  })

  test('goes maxDepth folders down at most', async (t) => {
    const root = makeLibrary(t)
    const shallow = await scanFolder(root, { maxDepth: 1, log: quietLog().log })

    assert.deepEqual(
      shallow.songs.map((s) => s.relPath),
      ['A Song.mp3', 'UPPER.MP3', 'Bollywood/Tum Hi Ho.mp3']
    )
  })

  test('stops after maxSongs MP3s and says it did', async (t) => {
    const root = makeLibrary(t)
    const { lines, log } = quietLog()
    const result = await scanFolder(root, { maxSongs: 2, log })

    assert.equal(result.truncated, true)
    assert.deepEqual(result.songs.map((s) => s.relPath), ['A Song.mp3', 'UPPER.MP3'])
    assert.ok(lines.some((line) => line.includes('2')))
  })

  test('a song id depends only on its path inside the folder', () => {
    assert.equal(songIdFor('Bollywood/Tum Hi Ho.mp3'), sha1Id('Bollywood/Tum Hi Ho.mp3'))
    assert.match(songIdFor('a.mp3'), /^[0-9a-f]{16}$/)
    assert.notEqual(songIdFor('a.mp3'), songIdFor('b.mp3'))
  })

  test('reports progress: found as MP3s turn up, scanned as their tags are read', async (t) => {
    const root = makeLibrary(t)
    const updates = []
    await scanFolder(root, { log: quietLog().log, onProgress: (p) => updates.push(p) })

    assert.deepEqual(updates.at(-1), { found: 4, scanned: 4 })
    assert.ok(updates.some((p) => p.found === 4 && p.scanned === 0))
    assert.ok(updates.every((p, i) => i === 0 || p.scanned >= updates[i - 1].scanned))
  })

  test('a song whose tags cannot be read is still listed, untagged', async (t) => {
    const root = makeLibrary(t)
    const { lines, log } = quietLog()
    const readTags = async (filePath) => {
      if (filePath.endsWith('UPPER.MP3')) throw new Error('disk hiccup')
      return readSongTags(filePath)
    }
    const result = await scanFolder(root, { readTags, log })

    const upper = result.songs.find((s) => s.fileName === 'UPPER.MP3')
    assert.equal(upper.title, '')
    assert.equal(upper.tagged, false)
    assert.ok(lines.some((line) => line.includes('disk hiccup')))
  })

  test('does not follow links, and answers with the folder\'s real path', async (t) => {
    const root = makeLibrary(t)
    const elsewhere = makeTempFolder(t)
    writeSong(path.join(elsewhere, 'Outside.mp3'), { title: 'Outside', artist: 'X' })
    fs.symlinkSync(path.join(elsewhere, 'Outside.mp3'), path.join(root, 'Linked.mp3'))
    fs.symlinkSync(elsewhere, path.join(root, 'Linked Folder'))
    const viaLink = path.join(elsewhere, 'link to library')
    fs.symlinkSync(root, viaLink)

    const result = await scanFolder(viaLink, { log: quietLog().log })
    assert.equal(result.root, root)
    assert.ok(result.songs.every((s) => s.path.startsWith(root + path.sep)))
    assert.ok(!result.songs.some((s) => s.fileName === 'Linked.mp3' || s.fileName === 'Outside.mp3'))
  })

  test('rejects a folder that is not there', async (t) => {
    const root = makeTempFolder(t)
    await assert.rejects(scanFolder(path.join(root, 'missing'), { log: quietLog().log }), { code: 'ENOENT' })
  })
})

describe('inspectTargets', () => {
  test('lists what is already where a plan writes, with the size of a file in the way', async (t) => {
    const root = makeTempFolder(t)
    writeFile(path.join(root, 'Organized', 'Pritam', 'Kesariya.mp3'), Buffer.alloc(5))
    writeFile(path.join(root, 'Organized', 'Pritam', 'Other.mp3'), Buffer.alloc(7))
    const operations = [
      { kind: 'mkdir', to: path.join(root, 'Organized') },
      { kind: 'mkdir', to: path.join(root, 'Organized', 'Pritam') },
      { kind: 'copy', from: path.join(root, 'k.mp3'), to: path.join(root, 'Organized', 'Pritam', 'Kesariya.mp3') },
      { kind: 'mkdir', to: path.join(root, 'Organized', 'New') },
      { kind: 'copy', from: path.join(root, 'n.mp3'), to: path.join(root, 'Organized', 'New', 'n.mp3') }
    ]

    const entries = await inspectTargets(operations, { log: quietLog().log })
    const byPath = new Map(entries.map((e) => [e.path, e]))

    assert.deepEqual(byPath.get(path.join(root, 'Organized')), { path: path.join(root, 'Organized'), kind: 'dir' })
    assert.deepEqual(byPath.get(path.join(root, 'Organized', 'Pritam', 'Kesariya.mp3')), {
      path: path.join(root, 'Organized', 'Pritam', 'Kesariya.mp3'),
      kind: 'file',
      size: 5
    })
    // only a file a song would land on needs its size
    assert.deepEqual(byPath.get(path.join(root, 'Organized', 'Pritam', 'Other.mp3')), {
      path: path.join(root, 'Organized', 'Pritam', 'Other.mp3'),
      kind: 'file'
    })
    assert.ok(![...byPath.keys()].some((p) => p.includes(`${path.sep}New`)))
  })
})
