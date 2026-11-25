function toInt(raw, fallback) {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadSettings(env = process.env) {
  const warnings = [];
  const seconds = (name, fallback) => {
    if (env[name] === undefined) return fallback;
    const n = Number(env[name]);
    if (Number.isFinite(n) && n > 0) return n;
    warnings.push(`${name}:invalid`);
    return fallback;
  };
  return {
    port: toInt(env.PORT, 8080),
    storePath: env.PARCELDESK_STORE_PATH ?? 'data',
    locale: env.PARCELDESK_LOCALE ?? 'ko',
    pickupCodeTtlHours: toInt(env.PARCELDESK_CODE_TTL_HOURS, 72),
    lockers: { doorAlertMs: seconds('PDESK_LOCKERS__DOOR_ALERT_SEC', 120) * 1000 },
    warnings,
  };
}
