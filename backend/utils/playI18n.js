function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cloneI18n(value) {
  const src = asObject(value);
  const out = {};
  for (const [locale, pack] of Object.entries(src)) {
    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) continue;
    const paramDesc = asObject(pack.paramDescriptions);
    const paramUnits = asObject(pack.paramUnits);
    out[locale] = {
      title: typeof pack.title === 'string' ? pack.title : undefined,
      description: typeof pack.description === 'string' ? pack.description : undefined,
      howTo: typeof pack.howTo === 'string' ? pack.howTo : undefined,
      devices: asObject(pack.devices),
      params: asObject(pack.params),
      enumLabels: asObject(pack.enumLabels),
      paramDescriptions: Object.keys(paramDesc).length ? paramDesc : undefined,
      paramUnits: Object.keys(paramUnits).length ? paramUnits : undefined,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

function withPlayI18n(play, manifestOrI18n) {
  const i18n = cloneI18n(manifestOrI18n?.i18n || manifestOrI18n);
  if (!i18n) return play;
  return { ...play, i18n };
}

module.exports = {
  cloneI18n,
  withPlayI18n,
};
