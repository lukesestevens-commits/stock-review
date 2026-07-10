function localDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

export function createMarketSnapshotCache({
  load,
  ttlMs = 60_000,
  now = Date.now
} = {}) {
  if (typeof load !== 'function') throw new TypeError('market snapshot loader is required');

  let cached = null;
  let expiresAt = 0;
  let inFlight = null;

  async function refresh() {
    try {
      const snapshot = await load();
      cached = snapshot;
      expiresAt = Number(now()) + ttlMs;
      return snapshot;
    } catch (error) {
      const currentDay = localDate(Number(now()));
      if (cached && localDate(cached.updatedAt) === currentDay) {
        return { ...cached, stale: true };
      }
      throw error;
    } finally {
      inFlight = null;
    }
  }

  return {
    get() {
      if (cached && Number(now()) < expiresAt) return Promise.resolve(cached);
      if (!inFlight) inFlight = refresh();
      return inFlight;
    }
  };
}
