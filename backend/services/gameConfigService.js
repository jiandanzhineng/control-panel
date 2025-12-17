const fileStorage = require('../utils/fileStorage')

function keyFor(id) {
  return `gamecfg_${id}`
}

function getParametersForGame(id) {
  const raw = fileStorage.getItem(keyFor(id))
  if (!raw) return null
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object' && obj.parameters && typeof obj.parameters === 'object') return obj.parameters
  } catch (_) {}
  return null
}

function saveParametersForGame(id, params) {
  const record = { parameters: params || {}, savedAt: Date.now() }
  fileStorage.setItem(keyFor(id), JSON.stringify(record))
}

function deleteParametersForGame(id) {
  fileStorage.setItem(keyFor(id), '')
}

module.exports = { getParametersForGame, saveParametersForGame, deleteParametersForGame }

