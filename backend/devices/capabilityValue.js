function toNumber(value) {
  if (typeof value === 'number') return Number.isNaN(value) ? null : value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function resolveValue(source, props = {}) {
  if (!source || typeof source !== 'object') return null;

  switch (source.op) {
    case 'prop':
      return props?.[source.key] ?? null;

    case 'anyEquals': {
      const expected = toNumber(source.equals);
      const matched = (source.keys || []).some((key) => {
        const value = toNumber(props?.[key]);
        return value !== null && expected !== null && value === expected;
      });
      return matched ? source.on : source.off;
    }

    default:
      return null;
  }
}

module.exports = { resolveValue };
