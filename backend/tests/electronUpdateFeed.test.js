const {
  UPDATE_FEEDS,
  parseLatestYmlVersion,
  pickUpdateFeed,
  isNewerVersion,
} = require('../../electron/updateFeed');

describe('parseLatestYmlVersion', () => {
  it('reads version from latest.yml text', () => {
    expect(parseLatestYmlVersion('version: 1.0.33\npath: a.exe\n')).toBe('1.0.33');
    expect(parseLatestYmlVersion("version: '1.0.34-beta.1'\n")).toBe('1.0.34-beta.1');
  });

  it('returns null for missing or invalid version', () => {
    expect(parseLatestYmlVersion('')).toBeNull();
    expect(parseLatestYmlVersion('path: a.exe\n')).toBeNull();
    expect(parseLatestYmlVersion('version: not-a-version\n')).toBeNull();
  });
});

describe('pickUpdateFeed', () => {
  it('uses only stable feed on stable channel', () => {
    const picked = pickUpdateFeed({
      channel: 'stable',
      testVersion: '1.0.35-beta.1',
      stableVersion: '1.0.33',
    });
    expect(picked).toMatchObject({
      channel: 'stable',
      feedUrl: UPDATE_FEEDS.stable,
      version: '1.0.33',
      reason: 'stable-channel',
    });
  });

  it('keeps test feed when test is newer than stable', () => {
    const picked = pickUpdateFeed({
      channel: 'test',
      testVersion: '1.0.34-beta.1',
      stableVersion: '1.0.33',
    });
    expect(picked).toMatchObject({
      channel: 'test',
      feedUrl: UPDATE_FEEDS.test,
      version: '1.0.34-beta.1',
      reason: 'test-channel',
    });
  });

  it('recommends stable when stable is newer than test', () => {
    const picked = pickUpdateFeed({
      channel: 'test',
      testVersion: '1.0.34-beta.1',
      stableVersion: '1.0.34',
    });
    expect(picked).toMatchObject({
      channel: 'stable',
      feedUrl: UPDATE_FEEDS.stable,
      version: '1.0.34',
      reason: 'stable-newer-than-test',
    });
  });

  it('keeps higher test even if stable exists', () => {
    const picked = pickUpdateFeed({
      channel: 'test',
      testVersion: '1.0.35-beta.1',
      stableVersion: '1.0.34',
    });
    expect(picked.channel).toBe('test');
    expect(picked.version).toBe('1.0.35-beta.1');
  });

  it('falls back to the remaining feed when one side is missing', () => {
    expect(pickUpdateFeed({ channel: 'test', testVersion: null, stableVersion: '1.0.33' }))
      .toMatchObject({ channel: 'stable', reason: 'test-feed-missing', version: '1.0.33' });
    expect(pickUpdateFeed({ channel: 'test', testVersion: '1.0.34-beta.1', stableVersion: null }))
      .toMatchObject({ channel: 'test', reason: 'test-channel', version: '1.0.34-beta.1' });
  });
});

describe('isNewerVersion', () => {
  it('treats stable as newer than the same-number beta', () => {
    expect(isNewerVersion('1.0.34', '1.0.34-beta.1')).toBe(true);
    expect(isNewerVersion('1.0.34-beta.1', '1.0.34-beta.1')).toBe(false);
    expect(isNewerVersion('1.0.33', '1.0.34-beta.1')).toBe(false);
  });
});
