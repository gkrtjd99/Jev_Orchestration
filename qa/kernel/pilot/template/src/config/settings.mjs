function toInt(raw, fallback) {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadSettings(env = process.env) {
  return {
    port: toInt(env.PORT, 8080),
    storePath: env.PARCELDESK_STORE_PATH ?? 'data',
    locale: env.PARCELDESK_LOCALE ?? 'ko',
    pickupCodeTtlHours: toInt(env.PARCELDESK_CODE_TTL_HOURS, 72),
  };
}
