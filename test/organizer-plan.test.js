// organizer/plan.js turns a scan's songs, the person's selection and an
// action (sort, rename, playlist, dedupe) into the file operations the
// organizer will carry out. It never touches the disk, so every rule is
// checked here with plain objects: no folder is read or written.

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const {
  buildPlan,
  planProblem,
  safeName,
  pathKey,
  isInside,
  publicOperation
} = require('../organizer/plan')

const ROOT = path.join(path.sep, 'music')
const OUTSIDE = path.join(path.sep, 'backup')

// a path inside the scanned folder
function m (...segments) {
  return path.join(ROOT, ...segments)
}

// a scanned song, shaped like organizer/scan.js's
function song (relPath, tags = {}) {
  const folder = path.posix.dirname(relPath)
  return {
    id: `id:${relPath}`,
    path: m(...relPath.split('/')),
    relPath,
    folder: folder === '.' ? '' : folder,
    fileName: path.posix.basename(relPath),
    size: 1000,
    mtimeMs: 0,
    title: '',
    artist: '',
    album: '',
    year: '',
    genre: '',
    track: null,
    durationSec: null,
    hasCover: false,
    ...tags,
    tagged: Boolean(tags.title && tags.artist)
  }
}

function plan (action, options, songs, { songIds, existing, root = ROOT } = {}) {
  return buildPlan({
    root,
    songs,
    songIds: songIds ?? songs.map((s) => s.id),
    action,
    options,
    existing
  })
}

function kinds (operations) {
  return operations.map((op) => op.kind)
}

function targets (operations, kind) {
  return operations.filter((op) => op.kind === kind).map((op) => op.to)
}

// Carries the operations out on a pretend disk (a set of taken paths, case
// ignored like FAT32 and macOS), failing if one would land on a taken name
function assertNothingOverwritten (songs, operations, existing = []) {
  const taken = new Set([...songs.map((s) => s.path), ...existing.map((e) => e.path)].map(pathKey))
  for (const op of operations) {
    const toKey = pathKey(op.to)
    const isCaseOnlyRename = op.from && pathKey(op.from) === toKey
    if (!isCaseOnlyRename) assert.ok(!taken.has(toKey), `${op.kind} would overwrite ${op.to}`)
    if (op.kind === 'move' || op.kind === 'rename') taken.delete(pathKey(op.from))
    taken.add(toKey)
  }
}

const tumHiHo = song('Bollywood/Tum Hi Ho.mp3', {
  title: 'Tum Hi Ho',
  artist: 'Arijit Singh,Mithoon',
  album: 'Aashiqui 2',
  year: '2013',
  genre: 'Filmi',
  track: 3,
  durationSec: 262
})
const kesariya = song('Kesariya.mp3', {
  title: 'Kesariya',
  artist: 'Pritam, Arijit Singh',
  album: 'Brahmastra',
  year: '2022',
  genre: 'Filmi',
  track: 1,
  durationSec: 268
})
const untagged = song('Old/track01.mp3')

describe('safeName', () => {
  test('replaces characters FAT32 refuses with spaces and squeezes the spaces', () => {
    assert.equal(safeName('AC/DC'), 'AC DC')
    assert.equal(safeName('Who? / What: "Now" <live> | *'), 'Who What Now live')
    assert.equal(safeName('back\\slash\ttab\nline\u0007bell'), 'back slash tab line bell')
  })

  test('never starts with a dot nor ends with a dot or a space', () => {
    assert.equal(safeName('..hidden'), 'hidden')
    assert.equal(safeName('._Song'), '_Song')
    assert.equal(safeName('Vol. 1.'), 'Vol. 1')
    assert.equal(safeName('Song . . '), 'Song')
  })

  test('falls back when nothing usable is left', () => {
    assert.equal(safeName('..', 'Unknown Artist'), 'Unknown Artist')
    assert.equal(safeName(' ? / : ', 'Unknown Album'), 'Unknown Album')
    assert.equal(safeName(null, 'X'), 'X')
    assert.equal(safeName(''), '')
  })

  test('cuts long names to 200 characters without splitting an emoji', () => {
    assert.equal(safeName('a'.repeat(300)), 'a'.repeat(200))
    const cut = safeName(`${'a'.repeat(199)}😀b`)
    assert.equal(cut, 'a'.repeat(199))
    assert.ok(!/[\uD800-\uDBFF]$/.test(cut))
  })

  test('adds an underscore to names Windows reserves for devices', () => {
    assert.equal(safeName('CON'), 'CON_')
    assert.equal(safeName('lpt1'), 'lpt1_')
    assert.equal(safeName('Console'), 'Console')
  })

  test('composes accents (NFC) so a name always compares the same', () => {
    assert.equal(safeName('Beyoncé'), 'Beyoncé')
  })
})

describe('pathKey and isInside', () => {
  test('pathKey ignores case and accent composition, as FAT32 and macOS do', () => {
    assert.equal(pathKey(m('BeyoncÉ')), pathKey(m('beyoncé')))
    assert.notEqual(pathKey(m('a')), pathKey(m('b')))
  })

  test('isInside accepts the folder itself and what is under it, nothing else', () => {
    assert.equal(isInside(m('a', 'b.mp3'), ROOT), true)
    assert.equal(isInside(ROOT, ROOT), true)
    assert.equal(isInside(path.join(path.sep, 'musicbox', 'a.mp3'), ROOT), false)
    assert.equal(isInside(m('..', 'etc', 'passwd'), ROOT), false)
    assert.equal(isInside(path.join(path.sep, 'etc'), ROOT), false)
  })
})

describe('sort', () => {
  test('copies each song into a folder per main artist under <root>/Organized, each folder made once', () => {
    const result = plan('sort', { groupBy: 'artist', mode: 'copy' }, [tumHiHo, kesariya, untagged])

    assert.deepEqual(result.operations, [
      { kind: 'mkdir', to: m('Organized') },
      { kind: 'mkdir', to: m('Organized', 'Arijit Singh') },
      { kind: 'copy', from: tumHiHo.path, to: m('Organized', 'Arijit Singh', 'Tum Hi Ho.mp3'), songId: tumHiHo.id },
      { kind: 'mkdir', to: m('Organized', 'Pritam') },
      { kind: 'copy', from: kesariya.path, to: m('Organized', 'Pritam', 'Kesariya.mp3'), songId: kesariya.id },
      { kind: 'mkdir', to: m('Organized', 'Unknown Artist') },
      { kind: 'copy', from: untagged.path, to: m('Organized', 'Unknown Artist', 'track01.mp3'), songId: untagged.id }
    ])
    assert.deepEqual(result.conflicts, [])
    assert.deepEqual(result.summary, { copies: 3, moves: 0, renames: 0, folders: 4, skipped: 0 })
    assert.equal(result.targetFolder, m('Organized'))
    assert.deepEqual(result.allowedFolders, [ROOT])
  })

  test('groups by album, artist and album, genre, year, decade or first letter', () => {
    const folderOf = (groupBy, songs = [tumHiHo, kesariya, untagged]) =>
      targets(plan('sort', { groupBy, mode: 'copy' }, songs).operations, 'copy').map((to) =>
        path.relative(m('Organized'), path.dirname(to))
      )

    assert.deepEqual(folderOf('album'), ['Aashiqui 2', 'Brahmastra', 'Unknown Album'])
    assert.deepEqual(folderOf('artist-album'), [
      path.join('Arijit Singh', 'Aashiqui 2'),
      path.join('Pritam', 'Brahmastra'),
      path.join('Unknown Artist', 'Unknown Album')
    ])
    assert.deepEqual(folderOf('genre'), ['Filmi', 'Filmi', 'Unknown Genre'])
    assert.deepEqual(folderOf('year'), ['2013', '2022', 'Unknown Year'])
    assert.deepEqual(folderOf('decade'), ['2010s', '2020s', 'Unknown Year'])
    assert.deepEqual(folderOf('letter'), ['A', 'P', '#'])

    const letters = ['Édith Piaf', '50 Cent', 'the weeknd', 'अरिजीत सिंह'].map((artist, i) =>
      song(`l${i}.mp3`, { title: `t${i}`, artist })
    )
    assert.deepEqual(folderOf('letter', letters), ['E', '#', 'T', '#'])
  })

  test('the main artist is the first one: commas, semicolons and "feat." split, "&" and "/" do not', () => {
    const songs = ['Daft Punk feat. Pharrell Williams', 'Simon & Garfunkel', 'AC/DC', 'Vishal; Shekhar'].map(
      (artist, i) => song(`a${i}.mp3`, { title: `t${i}`, artist })
    )
    const folders = targets(plan('sort', { groupBy: 'artist', mode: 'copy' }, songs).operations, 'copy').map(
      (to) => path.basename(path.dirname(to))
    )

    assert.deepEqual(folders, ['Daft Punk', 'Simon & Garfunkel', 'AC DC', 'Vishal'])
  })

  test('moves instead of copying in move mode', () => {
    const result = plan('sort', { groupBy: 'genre', mode: 'move' }, [tumHiHo, kesariya])

    assert.deepEqual(kinds(result.operations), ['mkdir', 'mkdir', 'move', 'move'])
    assert.deepEqual(result.summary, { copies: 0, moves: 2, renames: 0, folders: 2, skipped: 0 })
  })

  test('same-named songs in one folder become " (2)", " (3)", ignoring case', () => {
    const songs = ['x/Song.mp3', 'y/song.MP3', 'z/SONG.mp3'].map((p) => song(p, { title: 'Song', artist: 'Band' }))
    const result = plan('sort', { groupBy: 'artist', mode: 'move' }, songs)

    assert.deepEqual(targets(result.operations, 'move'), [
      m('Organized', 'Band', 'Song.mp3'),
      m('Organized', 'Band', 'song (2).MP3'),
      m('Organized', 'Band', 'SONG (3).mp3')
    ])
    assertNothingOverwritten(songs, result.operations)
  })

  test('plans 20 000 songs that share one name quickly (album rips are full of "01.mp3")', () => {
    const songs = Array.from({ length: 20000 }, (_, i) => song(`album ${i}/01.mp3`))
    const started = Date.now()
    const result = plan('playlist', { name: 'All', mode: 'copy' }, songs)
    const sorted = plan('sort', { groupBy: 'artist', mode: 'copy' }, songs)

    // ~1–3 s alone, up to ~9 s seen while the other test files run alongside:
    // the limit is there to catch naming that slows down with every song added
    const PLAN_TIME_LIMIT_MS = 20_000
    const tookMs = Date.now() - started
    assert.ok(tookMs < PLAN_TIME_LIMIT_MS, `took ${tookMs} ms`)
    assert.equal(new Set(targets(result.operations, 'copy')).size, 20000)
    assert.equal(targets(result.operations, 'copy').at(-1), m('All', '01 (20000).mp3'))
    assert.equal(targets(sorted.operations, 'copy').at(-1), m('Organized', 'Unknown Artist', '01 (20000).mp3'))
  })

  test('reuses a folder that is already there, in its own spelling, without a mkdir', () => {
    const existing = [
      { path: m('Organized'), kind: 'dir' },
      { path: m('Organized', 'pritam'), kind: 'dir' }
    ]
    const result = plan('sort', { groupBy: 'artist', mode: 'copy' }, [kesariya], { existing })

    assert.deepEqual(result.operations, [
      { kind: 'copy', from: kesariya.path, to: m('Organized', 'pritam', 'Kesariya.mp3'), songId: kesariya.id }
    ])
    assert.equal(result.summary.folders, 0)
  })

  test('skips a song already in its place, or already there with the same name and size', () => {
    const inPlace = song('Pritam/Kesariya.mp3', { title: 'Kesariya', artist: 'Pritam' })
    const here = plan('sort', { groupBy: 'artist', mode: 'move', targetFolder: ROOT }, [inPlace])
    assert.deepEqual(here.operations, [])
    assert.deepEqual(here.conflicts, [{ songId: inPlace.id, reason: 'Already in place' }])
    assert.equal(here.summary.skipped, 1)

    const existing = [
      { path: m('Organized'), kind: 'dir' },
      { path: m('Organized', 'Pritam'), kind: 'dir' },
      { path: m('Organized', 'Pritam', 'kesariya.mp3'), kind: 'file', size: kesariya.size }
    ]
    const copied = plan('sort', { groupBy: 'artist', mode: 'copy' }, [kesariya], { existing })
    assert.deepEqual(copied.operations, [])
    assert.deepEqual(copied.conflicts, [{ songId: kesariya.id, reason: 'Already there (same name and size)' }])
  })

  test('never aims at a different file of the same name: it gets " (2)"', () => {
    const existing = [
      { path: m('Organized'), kind: 'dir' },
      { path: m('Organized', 'Pritam'), kind: 'dir' },
      { path: m('Organized', 'Pritam', 'Kesariya.mp3'), kind: 'file', size: 5 },
      { path: m('Organized', 'Pritam', 'Kesariya (2).mp3'), kind: 'other' }
    ]
    const result = plan('sort', { groupBy: 'artist', mode: 'copy' }, [kesariya], { existing })

    assert.deepEqual(targets(result.operations, 'copy'), [m('Organized', 'Pritam', 'Kesariya (3).mp3')])
    assertNothingOverwritten([kesariya], result.operations, existing)
  })

  test('reports a file standing where a folder is needed', () => {
    const existing = [{ path: m('Organized'), kind: 'file', size: 10 }]
    const result = plan('sort', { groupBy: 'artist', mode: 'copy' }, [kesariya, tumHiHo], { existing })

    assert.deepEqual(result.operations, [])
    assert.deepEqual(result.conflicts, [
      { songId: kesariya.id, reason: '"Organized" is a file, not a folder' },
      { songId: tumHiHo.id, reason: '"Organized" is a file, not a folder' }
    ])
  })

  test('sorts into a folder outside the scanned one, which must already exist', () => {
    const result = plan('sort', { groupBy: 'artist', mode: 'copy', targetFolder: OUTSIDE }, [kesariya])

    assert.deepEqual(result.operations, [
      { kind: 'mkdir', to: path.join(OUTSIDE, 'Pritam') },
      { kind: 'copy', from: kesariya.path, to: path.join(OUTSIDE, 'Pritam', 'Kesariya.mp3'), songId: kesariya.id }
    ])
    assert.equal(result.targetFolder, OUTSIDE)
    assert.deepEqual(result.allowedFolders, [ROOT, OUTSIDE])
  })

  test('creates each missing level of a target folder deep inside the scanned one', () => {
    const result = plan('sort', { groupBy: 'genre', mode: 'copy', targetFolder: m('Car', 'Sorted') }, [kesariya])

    assert.deepEqual(targets(result.operations, 'mkdir'), [m('Car'), m('Car', 'Sorted'), m('Car', 'Sorted', 'Filmi')])
  })
})

describe('rename', () => {
  const one = song('A/one.mp3', { title: 'Tum Hi Ho', artist: 'Arijit Singh', album: 'Aashiqui 2', track: 3 })
  const two = song('A/two.mp3', { title: 'Sun Raha Hai', artist: 'Ankit Tiwari', track: 12 })

  test('renames in place from the pattern, padding track numbers to the selection\'s width', () => {
    const result = plan('rename', { pattern: '{track} - {artist} - {title}' }, [one, two])

    assert.deepEqual(result.operations, [
      { kind: 'rename', from: one.path, to: m('A', '03 - Arijit Singh - Tum Hi Ho.mp3'), songId: one.id },
      { kind: 'rename', from: two.path, to: m('A', '12 - Ankit Tiwari - Sun Raha Hai.mp3'), songId: two.id }
    ])
    assert.deepEqual(result.summary, { copies: 0, moves: 0, renames: 2, folders: 0, skipped: 0 })

    const long = song('A/three.mp3', { title: 'Long', artist: 'X', track: 150 })
    const wide = plan('rename', { pattern: '{track} {title}' }, [one, long])
    assert.deepEqual(targets(wide.operations, 'rename'), [m('A', '003 Tum Hi Ho.mp3'), m('A', '150 Long.mp3')])
  })

  test('fills {album}, {year} and {genre} too', () => {
    const tagged = song('B/x.mp3', { title: 'T', artist: 'A', album: 'Al', year: '1999', genre: 'Pop' })
    const result = plan('rename', { pattern: '{year} {genre} {album} {title}' }, [tagged])

    assert.deepEqual(targets(result.operations, 'rename'), [m('B', '1999 Pop Al T.mp3')])
  })

  test('skips songs missing a tag the pattern needs, and songs already named like that', () => {
    const named = song('B/Tum Hi Ho.mp3', { title: 'Tum Hi Ho', artist: 'X' })
    const result = plan('rename', { pattern: '{album} - {title}' }, [one, two])
    assert.deepEqual(targets(result.operations, 'rename'), [m('A', 'Aashiqui 2 - Tum Hi Ho.mp3')])
    assert.deepEqual(result.conflicts, [{ songId: two.id, reason: 'No album tag' }])
    assert.equal(result.summary.skipped, 1)

    const noTrack = plan('rename', { pattern: '{track} {title}' }, [named])
    assert.deepEqual(noTrack.conflicts, [{ songId: named.id, reason: 'No track number tag' }])

    const same = plan('rename', { pattern: '{title}' }, [named])
    assert.deepEqual(same.operations, [])
    assert.deepEqual(same.conflicts, [{ songId: named.id, reason: 'Already named like that' }])

    const empty = plan('rename', { pattern: '{title}' }, [song('B/q.mp3', { title: '???', artist: 'X' })])
    assert.deepEqual(empty.conflicts, [{ songId: 'id:B/q.mp3', reason: 'The new name would be empty' }])
  })

  test('a name another song already has gets " (2)"; songs swapping names never overwrite each other', () => {
    const renamed = song('C/x.mp3', { title: 'Hello', artist: 'A' })
    const holder = song('C/Hello.mp3', { title: 'Other', artist: 'B' })
    const taken = plan('rename', { pattern: '{title}' }, [renamed, holder], { songIds: [renamed.id] })
    assert.deepEqual(targets(taken.operations, 'rename'), [m('C', 'Hello (2).mp3')])

    const first = song('D/A.mp3', { title: 'B', artist: 'x' })
    const second = song('D/B.mp3', { title: 'A', artist: 'x' })
    const swap = plan('rename', { pattern: '{title}' }, [first, second])
    assert.deepEqual(targets(swap.operations, 'rename'), [m('D', 'B (2).mp3'), m('D', 'A.mp3')])
    assertNothingOverwritten([first, second], swap.operations)
  })

  test('a change of case only is a plain rename', () => {
    const lower = song('E/tum hi ho.mp3', { title: 'Tum Hi Ho', artist: 'x' })
    const result = plan('rename', { pattern: '{title}' }, [lower])

    assert.deepEqual(result.operations, [
      { kind: 'rename', from: lower.path, to: m('E', 'Tum Hi Ho.mp3'), songId: lower.id }
    ])
  })

  test('tag text is made safe for the drive and keeps the song\'s extension', () => {
    const odd = song('F/a.MP3', { title: '...Who? / What: "Now"', artist: 'x' })
    const result = plan('rename', { pattern: '{title}' }, [odd])

    assert.deepEqual(targets(result.operations, 'rename'), [m('F', 'Who What Now.MP3')])
  })
})

describe('playlist', () => {
  test('copies the songs in the order given into a new numbered folder, with an .m3u last', () => {
    const result = plan(
      'playlist',
      { name: 'Road Trip', mode: 'copy', numberTracks: true, writePlaylist: true },
      [tumHiHo, kesariya],
      { songIds: [kesariya.id, tumHiHo.id] }
    )

    assert.deepEqual(result.operations, [
      { kind: 'mkdir', to: m('Road Trip'), fresh: true },
      { kind: 'copy', from: kesariya.path, to: m('Road Trip', '01 - Kesariya.mp3'), songId: kesariya.id },
      { kind: 'copy', from: tumHiHo.path, to: m('Road Trip', '02 - Tum Hi Ho.mp3'), songId: tumHiHo.id },
      {
        kind: 'write-m3u',
        to: m('Road Trip', 'Road Trip.m3u'),
        content:
          '#EXTM3U\n' +
          '#EXTINF:268,Pritam, Arijit Singh - Kesariya\n01 - Kesariya.mp3\n' +
          '#EXTINF:262,Arijit Singh,Mithoon - Tum Hi Ho\n02 - Tum Hi Ho.mp3\n'
      }
    ])
    assert.deepEqual(result.summary, { copies: 2, moves: 0, renames: 0, folders: 1, skipped: 0 })
  })

  test('picks "<name> (2)" when that folder is already there', () => {
    const existing = [
      { path: m('Road Trip'), kind: 'dir' },
      { path: m('road trip (2)'), kind: 'file', size: 1 }
    ]
    const result = plan('playlist', { name: 'Road Trip', mode: 'copy' }, [kesariya], { existing })

    assert.deepEqual(result.operations[0], { kind: 'mkdir', to: m('Road Trip (3)'), fresh: true })
    assert.deepEqual(targets(result.operations, 'copy'), [m('Road Trip (3)', 'Kesariya.mp3')])
  })

  test('numbering replaces an old track number; without numbering names stay, made unique', () => {
    const numbered = song('x/007 - Tum Hi Ho.mp3', { title: 'Tum Hi Ho', artist: 'A' })
    const renumbered = plan('playlist', { name: 'P', mode: 'copy', numberTracks: true }, [numbered])
    assert.deepEqual(targets(renumbered.operations, 'copy'), [m('P', '01 - Tum Hi Ho.mp3')])

    const twins = [song('x/Song.mp3'), song('y/Song.mp3')]
    const plain = plan('playlist', { name: 'P', mode: 'copy', writePlaylist: true }, twins)
    assert.deepEqual(targets(plain.operations, 'copy'), [m('P', 'Song.mp3'), m('P', 'Song (2).mp3')])
    assert.match(plain.operations.at(-1).content, /\nSong\.mp3\n.*\nSong \(2\)\.mp3\n$/s)
  })

  test('moves in move mode, into a parent folder that is made if missing', () => {
    const result = plan('playlist', { name: 'Gym', mode: 'move', targetFolder: m('Playlists') }, [kesariya])

    assert.deepEqual(result.operations, [
      { kind: 'mkdir', to: m('Playlists') },
      { kind: 'mkdir', to: m('Playlists', 'Gym'), fresh: true },
      { kind: 'move', from: kesariya.path, to: m('Playlists', 'Gym', 'Kesariya.mp3'), songId: kesariya.id }
    ])
  })

  test('a name with nothing usable in it becomes "Playlist"', () => {
    const result = plan('playlist', { name: '???', mode: 'copy', writePlaylist: true }, [kesariya])

    assert.deepEqual(targets(result.operations, 'mkdir'), [m('Playlist')])
    assert.deepEqual(targets(result.operations, 'write-m3u'), [m('Playlist', 'Playlist.m3u')])
  })
})

describe('dedupe', () => {
  const d1 = song('A/Song.mp3', { title: 'Song', artist: 'Band', size: 100, durationSec: 200, mtimeMs: 3 })
  const d2 = song('B/Song.mp3', { title: 'song', artist: 'Band feat. Guest', size: 300, durationSec: 205, mtimeMs: 1 })
  const live = song('C/Song live.mp3', { title: 'Song (Live)', artist: 'Band', size: 500, durationSec: 203 })
  const long = song('D/Song.mp3', { title: 'Song', artist: 'Band', size: 400, durationSec: 320 })
  const unknownLength = song('E/Song.mp3', { title: 'Song', artist: 'Band', size: 200, mtimeMs: 5 })
  const other = song('F/Song.mp3', { title: 'Song', artist: 'Someone Else', size: 900, durationSec: 200 })
  const songs = [d1, d2, live, long, unknownLength, other, untagged]

  test('groups by title and main artist, keeps the largest and moves the rest into _Duplicates', () => {
    const result = plan('dedupe', { keep: 'largest' }, songs)

    assert.deepEqual(result.operations, [
      { kind: 'mkdir', to: m('_Duplicates') },
      { kind: 'mkdir', to: m('_Duplicates', 'A') },
      { kind: 'move', from: d1.path, to: m('_Duplicates', 'A', 'Song.mp3'), songId: d1.id },
      { kind: 'mkdir', to: m('_Duplicates', 'E') },
      { kind: 'move', from: unknownLength.path, to: m('_Duplicates', 'E', 'Song.mp3'), songId: unknownLength.id }
    ])
    assert.deepEqual(result.groups, [{ keep: d2.id, move: [d1.id, unknownLength.id] }])
    assert.deepEqual(result.conflicts, [{ songId: untagged.id, reason: 'Needs a title and an artist tag' }])
    assert.deepEqual(result.summary, { copies: 0, moves: 2, renames: 0, folders: 3, skipped: 1 })
  })

  test('keeps the first in the order given, or the newest', () => {
    assert.deepEqual(plan('dedupe', { keep: 'first' }, songs).groups, [
      { keep: d1.id, move: [d2.id, unknownLength.id] }
    ])
    assert.deepEqual(plan('dedupe', { keep: 'newest' }, songs).groups, [
      { keep: unknownLength.id, move: [d1.id, d2.id] }
    ])
    const reordered = plan('dedupe', { keep: 'first' }, songs, { songIds: [d2.id, d1.id] })
    assert.deepEqual(reordered.groups, [{ keep: d2.id, move: [d1.id] }])
  })

  test('a tie keeps the one that comes first', () => {
    const twinA = song('A/x.mp3', { title: 'X', artist: 'Y', size: 10 })
    const twinB = song('B/x.mp3', { title: 'X', artist: 'Y', size: 10 })

    assert.deepEqual(plan('dedupe', { keep: 'largest' }, [twinA, twinB]).groups, [
      { keep: twinA.id, move: [twinB.id] }
    ])
  })

  test('a song in the scanned folder itself goes straight into _Duplicates', () => {
    const top = song('Song.mp3', { title: 'Song', artist: 'Band', size: 1 })
    const result = plan('dedupe', { keep: 'largest' }, [d2, top])

    assert.deepEqual(targets(result.operations, 'move'), [m('_Duplicates', 'Song.mp3')])
  })

  test('nothing to move when there are no duplicates', () => {
    const result = plan('dedupe', { keep: 'largest' }, [tumHiHo, kesariya])

    assert.deepEqual(result.operations, [])
    assert.deepEqual(result.groups, [])
  })
})

describe('safety', () => {
  test('a song outside the scanned folder is refused, whatever the action', () => {
    const outsider = { ...song('x.mp3', { title: 'T', artist: 'A' }), path: path.join(path.sep, 'etc', 'x.mp3') }

    for (const [action, options] of [
      ['sort', { groupBy: 'artist', mode: 'move' }],
      ['rename', { pattern: '{artist}' }],
      ['playlist', { name: 'P', mode: 'move' }],
      ['dedupe', { keep: 'first' }]
    ]) {
      const result = plan(action, options, [outsider])
      assert.deepEqual(targets(result.operations, 'move').concat(targets(result.operations, 'rename')), [])
      assert.deepEqual(result.conflicts, [{ songId: outsider.id, reason: 'Not inside the scanned folder' }])
    }
  })

  test('an unknown song id is reported, a repeated one is planned once', () => {
    const result = plan('sort', { groupBy: 'artist', mode: 'copy' }, [kesariya], {
      songIds: [kesariya.id, 'nope', kesariya.id]
    })

    assert.equal(targets(result.operations, 'copy').length, 1)
    assert.deepEqual(result.conflicts, [{ songId: 'nope', reason: 'Not in this scan' }])
  })

  test('tags such as ".." or "a/../../b" cannot climb out of the folders', () => {
    const sneaky = [
      song('s1.mp3', { title: '..', artist: '..', album: '../..', genre: '/etc' }),
      song('s2.mp3', { title: 'a/../../b', artist: 'a/../../b', album: '..\\..' })
    ]
    const runs = [
      plan('sort', { groupBy: 'artist-album', mode: 'move' }, sneaky),
      plan('sort', { groupBy: 'genre', mode: 'copy', targetFolder: OUTSIDE }, sneaky),
      plan('rename', { pattern: '{artist}{title}' }, sneaky),
      plan('playlist', { name: '../../..', mode: 'move', writePlaylist: true }, sneaky),
      plan('dedupe', { keep: 'first' }, [...sneaky, song('d/s1.mp3', { title: '..', artist: '..' })])
    ]

    for (const result of runs) {
      for (const op of result.operations) {
        assert.ok(
          result.allowedFolders.some((folder) => isInside(op.to, folder) && op.to !== folder),
          `${op.kind} ${op.to} left the allowed folders`
        )
        assert.ok(!path.basename(op.to).startsWith('.'), `${op.to} is hidden`)
      }
    }
    assert.deepEqual(
      targets(runs[0].operations, 'move').map((to) => path.relative(m('Organized'), to)),
      [
        path.join('Unknown Artist', 'Unknown Album', 's1.mp3'),
        path.join('a .. .. b', 'Unknown Album', 's2.mp3')
      ]
    )
  })

  test('buildPlan refuses bad options and a relative root instead of guessing', () => {
    assert.throws(() => plan('shuffle', {}, [kesariya]), /Unknown action/)
    assert.throws(() => plan('sort', { groupBy: 'mood', mode: 'copy' }, [kesariya]), /group/)
    assert.throws(() => plan('sort', { groupBy: 'artist', mode: 'copy' }, [kesariya], { root: 'music' }), /root/)
  })
})

describe('planProblem', () => {
  const problem = (action, options) => planProblem({ action, options })

  test('accepts every action with good options', () => {
    assert.equal(problem('sort', { groupBy: 'decade', mode: 'move' }), null)
    assert.equal(problem('sort', { groupBy: 'letter', mode: 'copy', targetFolder: OUTSIDE }), null)
    assert.equal(problem('rename', { pattern: '{track}. {artist} - {title}' }), null)
    assert.equal(problem('playlist', { name: 'Car', mode: 'copy', numberTracks: true, writePlaylist: false }), null)
    assert.equal(problem('dedupe', { keep: 'newest' }), null)
  })

  test('names what is wrong', () => {
    assert.match(problem('shuffle', {}), /Unknown action/)
    assert.match(problem('sort', null), /options/)
    assert.match(problem('sort', []), /options/)
    assert.match(problem('sort', { mode: 'copy' }), /group/)
    assert.match(problem('sort', { groupBy: 'artist', mode: 'link' }), /copy or move/)
    assert.match(problem('sort', { groupBy: 'artist', mode: 'copy', targetFolder: 'Music' }), /full path/)
    assert.match(problem('sort', { groupBy: 'artist', mode: 'copy', targetFolder: 5 }), /full path/)
    assert.match(
      problem('sort', { groupBy: 'artist', mode: 'copy', targetFolder: `/${'a'.repeat(5000)}` }),
      /too long/
    )
    assert.match(problem('rename', {}), /pattern/)
    assert.match(problem('rename', { pattern: '{artist} - {mood}' }), /\{mood\}/)
    assert.match(problem('rename', { pattern: 'no tags here' }), /at least one tag/)
    assert.match(problem('rename', { pattern: '{artist}/{title}' }), /can't contain/)
    assert.match(problem('rename', { pattern: `{title}${'x'.repeat(300)}` }), /too long/)
    assert.match(problem('playlist', { mode: 'copy' }), /Name the playlist/)
    assert.match(problem('playlist', { name: 'x'.repeat(201), mode: 'copy' }), /too long/)
    assert.match(problem('playlist', { name: 'Car', mode: 'copy', numberTracks: 'yes' }), /numberTracks/)
    assert.match(problem('playlist', { name: 'Car', mode: 'copy', writePlaylist: 1 }), /writePlaylist/)
    assert.match(problem('dedupe', { keep: 'smallest' }), /largest, first or newest/)
  })
})

describe('publicOperation', () => {
  test('shows kind, from, to and songId only', () => {
    assert.deepEqual(publicOperation({ kind: 'mkdir', to: m('P'), fresh: true }), { kind: 'mkdir', to: m('P') })
    assert.deepEqual(publicOperation({ kind: 'write-m3u', to: m('P', 'P.m3u'), content: '#EXTM3U\n' }), {
      kind: 'write-m3u',
      to: m('P', 'P.m3u')
    })
    assert.deepEqual(publicOperation({ kind: 'copy', from: m('a.mp3'), to: m('b.mp3'), songId: 'x' }), {
      kind: 'copy',
      from: m('a.mp3'),
      to: m('b.mp3'),
      songId: 'x'
    })
  })
})
