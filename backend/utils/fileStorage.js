const fs = require('fs')
const path = require('path')

const fallbackDir = path.resolve(__dirname, '../data')
const dataDir = process.env.BACKEND_DATA_DIR ? path.resolve(process.env.BACKEND_DATA_DIR) : fallbackDir

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
}

function sanitizeKey(key) {
  if (typeof key !== 'string') throw new TypeError('key must be a string')
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    throw new Error('Invalid key: only [a-zA-Z0-9_-] allowed')
  }
  return key
}

function getFilePathForKey(key) {
  const safeKey = sanitizeKey(key)
  return path.join(dataDir, `${safeKey}.json`)
}

function getItem(key) {
  try {
    ensureDataDir()
    const filePath = getFilePathForKey(key)
    if (!fs.existsSync(filePath)) return null
    const content = fs.readFileSync(filePath, 'utf-8')
    return content
  } catch (err) {
    // Align with localStorage: return null on read failure
    return null
  }
}

function setItem(key, value) {
  ensureDataDir()
  const filePath = getFilePathForKey(key)
  let content = value
  try {
    if (typeof value !== 'string') {
      content = JSON.stringify(value)
    }
    fs.writeFileSync(filePath, content, 'utf-8')
  } catch (err) {
    // Propagate error to caller for handling
    throw err
  }
}

module.exports = { getItem, setItem }