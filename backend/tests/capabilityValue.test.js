const { resolveValue } = require('../devices/capabilityValue');

describe('capability value resolver', () => {
  it('reads a property value from the current device snapshot', () => {
    expect(resolveValue({ op: 'prop', key: 'pressure1' }, { pressure1: 42.5 }))
      .toBe(42.5);
  });

  it('maps any matching numeric property to the declared on value', () => {
    const source = {
      op: 'anyEquals',
      keys: ['button0', 'button1'],
      equals: 1,
      on: 200,
      off: 0,
    };

    expect(resolveValue(source, { button0: 0, button1: '1' })).toBe(200);
    expect(resolveValue(source, { button0: '0', button1: 0 })).toBe(0);
  });

  it('treats missing source properties as not triggered', () => {
    const source = {
      op: 'anyEquals',
      keys: ['button0', 'button1'],
      equals: 1,
      on: 200,
      off: 0,
    };

    expect(resolveValue(source, { button0: 0 })).toBe(0);
    expect(resolveValue(source, {})).toBe(0);
  });

  it('does not coerce booleans or blank strings to numbers', () => {
    const source = {
      op: 'anyEquals',
      keys: ['button0', 'button1'],
      equals: 0,
      on: 200,
      off: 0,
    };

    expect(resolveValue(source, { button0: false, button1: '' })).toBe(0);
  });
});
