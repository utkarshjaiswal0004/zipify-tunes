// Saving MP3s straight into a folder the user picks (e.g. a pen drive)
// instead of handing back a ZIP.

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// "Road Trip (2)", "(3)"… stop somewhere sane rather than loop forever
const MAX_FOLDER_SUFFIX = 1000

// Where removable drives get mounted. Windows isn't listed: type the drive
// letter (e.g. E:\) into the page instead.
function driveRoots () {
  if (process.platform === 'darwin') return ['/Volumes']
  if (process.platform === 'linux') {
    const user = os.userInfo().username
    return [`/media/${user}`, `/run/media/${user}`, '/mnt']
  }
  return []
}

// Connected drives the page can offer as save folders, with their free space.
// The main disk is left out (macOS lists it in /Volumes as "Macintosh HD").
async function listDrives () {
  const rootDevice = (await fs.promises.stat('/')).dev
  const drives = []

  for (const root of driveRoots()) {
    let names
    try {
      names = await fs.promises.readdir(root)
    } catch {
      continue // this system doesn't use that mount point
    }

    for (const name of names) {
      const drivePath = path.join(root, name)
      try {
        const stat = await fs.promises.stat(drivePath)
        if (!stat.isDirectory() || stat.dev === rootDevice) continue
        const { bavail, bsize } = await fs.promises.statfs(drivePath)
        drives.push({ path: drivePath, name, freeBytes: bavail * bsize })
      } catch (err) {
        // an unreadable or half-ejected drive can't be saved to anyway
        console.log(`Skipping ${drivePath}:`, err.message)
      }
    }
  }

  return drives
}

// Check a folder typed into the page before any work starts. Returns a
// message for the page, or null when the folder is usable.
async function checkSaveFolder (dir) {
  if (!path.isAbsolute(dir)) {
    return `Save folder must be a full path, like /Volumes/MyDrive/Music (got "${dir}").`
  }

  let stat
  try {
    stat = await fs.promises.stat(dir)
  } catch {
    return `Save folder not found: ${dir}. Is the drive plugged in?`
  }
  if (!stat.isDirectory()) return `${dir} is not a folder.`

  try {
    await fs.promises.access(dir, fs.constants.W_OK)
  } catch {
    return `Can't write to ${dir}. Is the drive locked or read-only?`
  }

  return null
}

// Create "<parent>/<name>", or "<name> (2)", "<name> (3)"… if that's taken,
// so a second run never mixes into or overwrites an earlier playlist.
async function makeUniqueFolder (parent, name) {
  for (let n = 1; n <= MAX_FOLDER_SUFFIX; n++) {
    const candidate = path.join(parent, n === 1 ? name : `${name} (${n})`)
    try {
      await fs.promises.mkdir(candidate)
      return candidate
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
  throw new Error(`Too many folders named "${name}" in ${parent}`)
}

// Use "<parent>/<name>", creating it if needed. Re-running a playlist with
// "skip songs already saved" continues in its existing folder.
async function openFolder (parent, name) {
  const folder = path.join(parent, name)
  try {
    await fs.promises.mkdir(folder)
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    const stat = await fs.promises.stat(folder)
    if (!stat.isDirectory()) throw new Error(`${folder} is not a folder.`)
  }
  return folder
}

// Every spelling a name may be stored or listed under: as given, composed
// (NFC) and decomposed (NFD). On an exFAT drive macOS lists accented names
// decomposed, but only finds a file there by its composed name.
function nameSpellings (name) {
  return [...new Set([name, name.normalize('NFC'), name.normalize('NFD')])]
}

// Remove `name` from `folder`, whichever spelling it's stored under
async function removeEverySpelling (folder, name, fsImpl) {
  for (const spelling of nameSpellings(name)) {
    await fsImpl.rm(path.join(folder, spelling), { force: true })
  }
}

// macOS can't keep file metadata (e.g. com.apple.provenance) on FAT32/exFAT
// drives, so it writes a hidden "._<name>" twin next to each file. They're
// useless on a pen drive and car stereos list them as broken tracks, so a
// playlist folder (which only holds files we made) is cleared of them.
// fsImpl needs readdir and rm, like fs.promises; tests pass fakes.
async function removeMacMetadataFiles (folder, { fsImpl = fs.promises } = {}) {
  const names = await fsImpl.readdir(folder)
  await Promise.all(
    names
      .filter((name) => name.startsWith('._'))
      .map((name) => removeEverySpelling(folder, name, fsImpl))
  )
}

// Only the "._" twins of the given files (names in `folder`): for a folder
// that may hold other people's files as well as ours
async function removeMacTwinsOf (folder, names, { fsImpl = fs.promises } = {}) {
  await Promise.all(names.map((name) => removeEverySpelling(folder, `._${name}`, fsImpl)))
}

// --- the system's own "choose folder" dialog ---

const PICKER_PROMPT = 'Choose where to save the songs'

// How to open the dialog on this system, or null if there isn't one (the
// page then asks for a typed path). macOS only for now: it starts in
// /Volumes so pen drives are one click away.
function pickerCommand (platform = process.platform) {
  if (platform !== 'darwin') return null
  const script =
    `POSIX path of (choose folder with prompt "${PICKER_PROMPT}" ` +
    'default location (POSIX file "/Volumes"))'
  return ['osascript', ['-e', script]]
}

// osascript prints the folder ("/Volumes/NO NAME/") and exits 0, or exits 1
// with "User canceled. (-128)" when the dialog is cancelled
function parsePickerResult ({ code, stdout, stderr }) {
  if (code === 0) {
    const picked = stdout.trim()
    return { path: picked.length > 1 ? picked.replace(/\/+$/, '') : picked }
  }
  if (/\(-128\)/.test(stderr)) return { cancelled: true }
  throw new Error(stderr.trim() || `Folder picker exited with code ${code}`)
}

// Show the dialog and wait for the person to pick (or cancel).
// Resolves { path } | { cancelled: true } | { unsupported: true }.
async function pickFolder () {
  const command = pickerCommand()
  if (!command) return { unsupported: true }

  const [cmd, args] = command
  const result = await new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => (stdout += d))
    proc.stderr.on('data', (d) => (stderr += d))
    proc.on('error', reject)
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  return parsePickerResult(result)
}

// The same for a whole playlist folder: the ._ files inside it, plus the
// "._<folder name>" twin macOS leaves next to it in the folder above.
async function removeMacMetadataFor (folder, { fsImpl = fs.promises } = {}) {
  await removeMacMetadataFiles(folder, { fsImpl })
  await removeMacTwinsOf(path.dirname(folder), [path.basename(folder)], { fsImpl })
}

module.exports = {
  removeMacMetadataFor,
  listDrives,
  checkSaveFolder,
  makeUniqueFolder,
  openFolder,
  removeMacMetadataFiles,
  removeMacTwinsOf,
  pickerCommand,
  parsePickerResult,
  pickFolder
}
