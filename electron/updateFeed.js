const semver = require('semver');

const UPDATE_FEEDS = {
  stable: 'http://firmware.undersilicon.cn/control-panel/stable/',
  test: 'http://firmware.undersilicon.cn/control-panel/test/',
};

function parseLatestYmlVersion(text) {
  const match = String(text || '').match(/^version:\s*['"]?([^'"\r\n]+)['"]?\s*$/m);
  if (!match) return null;
  const version = match[1].trim();
  return semver.valid(version) ? version : null;
}

function pickUpdateFeed({ channel, testVersion, stableVersion } = {}) {
  if (channel !== 'test') {
    return {
      channel: 'stable',
      feedUrl: UPDATE_FEEDS.stable,
      version: stableVersion || null,
      reason: 'stable-channel',
    };
  }

  if (stableVersion && testVersion && semver.gt(stableVersion, testVersion)) {
    return {
      channel: 'stable',
      feedUrl: UPDATE_FEEDS.stable,
      version: stableVersion,
      reason: 'stable-newer-than-test',
    };
  }
  if (testVersion) {
    return {
      channel: 'test',
      feedUrl: UPDATE_FEEDS.test,
      version: testVersion,
      reason: 'test-channel',
    };
  }
  if (stableVersion) {
    return {
      channel: 'stable',
      feedUrl: UPDATE_FEEDS.stable,
      version: stableVersion,
      reason: 'test-feed-missing',
    };
  }
  return {
    channel: 'test',
    feedUrl: UPDATE_FEEDS.test,
    version: null,
    reason: 'fallback-test',
  };
}

function isNewerVersion(latestVersion, currentVersion) {
  if (!latestVersion || !currentVersion) return false;
  if (!semver.valid(latestVersion) || !semver.valid(currentVersion)) return false;
  return semver.gt(latestVersion, currentVersion);
}

module.exports = {
  UPDATE_FEEDS,
  parseLatestYmlVersion,
  pickUpdateFeed,
  isNewerVersion,
};
