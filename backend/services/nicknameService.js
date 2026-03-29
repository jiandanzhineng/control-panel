const fileStorage = require('../utils/fileStorage');

const STORAGE_KEY = 'device_nicknames';

function getNicknames() {
  try {
    const data = fileStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : {};
  } catch (error) {
    console.error('Failed to parse device_nicknames from fileStorage:', error);
    return {};
  }
}

function saveNicknames(nicknames) {
  try {
    fileStorage.setItem(STORAGE_KEY, JSON.stringify(nicknames));
  } catch (error) {
    console.error('Failed to save device_nicknames to fileStorage:', error);
  }
}

function getNickname(id) {
  if (!id) return null;
  const nicknames = getNicknames();
  return nicknames[id] || null;
}

function setNickname(id, nickname) {
  if (!id) return;
  const nicknames = getNicknames();
  if (nickname) {
    nicknames[id] = nickname;
  } else {
    delete nicknames[id];
  }
  saveNicknames(nicknames);
}

module.exports = {
  getNickname,
  setNickname
};
