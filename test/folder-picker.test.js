const { test } = require('node:test')
const assert = require('node:assert/strict')

const { pickerCommand, parsePickerResult } = require('../save-folder')

// These only check how the dialog is launched and how its answer is read:
// opening the real dialog would wait for someone to click it.

test('macOS opens the Finder folder dialog, starting at the connected drives', () => {
  const [command, args] = pickerCommand('darwin')

  assert.equal(command, 'osascript')
  assert.match(args.join(' '), /choose folder/)
  assert.match(args.join(' '), /\/Volumes/)
})

test('other systems have no folder dialog (the path is typed instead)', () => {
  assert.equal(pickerCommand('linux'), null)
  assert.equal(pickerCommand('win32'), null)
})

test('a picked folder comes back without the trailing slash', () => {
  const result = parsePickerResult({ code: 0, stdout: '/Volumes/NO NAME/\n', stderr: '' })

  assert.deepEqual(result, { path: '/Volumes/NO NAME' })
})

test('picking the disk root keeps the lone slash', () => {
  assert.deepEqual(parsePickerResult({ code: 0, stdout: '/\n', stderr: '' }), { path: '/' })
})

test('closing the dialog with Cancel is not an error', () => {
  const result = parsePickerResult({
    code: 1,
    stdout: '',
    stderr: '0:111: execution error: User canceled. (-128)\n'
  })

  assert.deepEqual(result, { cancelled: true })
})

test('any other dialog failure is reported', () => {
  assert.throws(
    () => parsePickerResult({ code: 1, stdout: '', stderr: 'execution error: boom (-1700)' }),
    /boom/
  )
})
