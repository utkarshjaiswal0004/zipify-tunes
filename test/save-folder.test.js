const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { removeMacMetadataFiles, removeMacMetadataFor, removeMacTwinsOf } = require('../save-folder')

// Stands in for fs.promises on an exFAT pen drive under macOS: the drive
// keeps names composed (NFC), readdir hands accented names back decomposed
// (NFD), and rm only finds a file by its composed name. (rm's `force` hides
// the miss, which is how the "._" twins of accented songs used to stay.)
function exfatDrive (filePaths) {
  let files = filePaths.map((filePath) => filePath.normalize('NFC'))
  return {
    left: () => [...files].sort(),
    readdir: async (folder) =>
      files
        .filter((filePath) => path.dirname(filePath) === folder.normalize('NFC'))
        .map((filePath) => path.basename(filePath).normalize('NFD')),
    rm: async (filePath, { force = false } = {}) => {
      if (files.includes(filePath)) {
        files = files.filter((other) => other !== filePath)
        return
      }
      if (!force) throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' })
    }
  }
}

test('the ._ twins of songs with accented names are removed on an exFAT drive too', async () => {
  const drive = exfatDrive([
    '/drive/World/Tití Me Preguntó.mp3',
    '/drive/World/._Tití Me Preguntó.mp3',
    '/drive/World/LA CANCIÓN.mp3',
    '/drive/World/._LA CANCIÓN.mp3',
    '/drive/World/Stay.mp3',
    '/drive/World/._Stay.mp3'
  ])

  await removeMacMetadataFiles('/drive/World', { fsImpl: drive })

  assert.deepEqual(drive.left(), [
    '/drive/World/LA CANCIÓN.mp3',
    '/drive/World/Stay.mp3',
    '/drive/World/Tití Me Preguntó.mp3'
  ].map((filePath) => filePath.normalize('NFC')))
})

test("an accented playlist folder's own ._ twin next to it is removed too", async () => {
  const drive = exfatDrive([
    '/drive/._Canción',
    '/drive/Canción/Señorita.mp3',
    '/drive/Canción/._Señorita.mp3'
  ])

  await removeMacMetadataFor('/drive/Canción', { fsImpl: drive })

  assert.deepEqual(drive.left(), ['/drive/Canción/Señorita.mp3'.normalize('NFC')])
})

test('in a folder that holds other files, only the ._ twins of the given songs go', async () => {
  const drive = exfatDrive([
    '/drive/Mix/Señorita.mp3',
    '/drive/Mix/._Señorita.mp3',
    '/drive/Mix/Old Song.mp3',
    '/drive/Mix/._Old Song.mp3'
  ])

  await removeMacTwinsOf('/drive/Mix', ['Señorita.mp3'], { fsImpl: drive })

  assert.deepEqual(drive.left(), [
    '/drive/Mix/._Old Song.mp3',
    '/drive/Mix/Old Song.mp3',
    '/drive/Mix/Señorita.mp3'.normalize('NFC')
  ])
})
