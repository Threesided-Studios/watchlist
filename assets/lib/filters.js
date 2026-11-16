export function applyFilters(items, { q = '', type = '', status = '' } = {}) {
  const needle = q.trim().toLowerCase();
  return items.filter(it => {
    if (type && it.type !== type) return false;
    if (status && it.status !== status) return false;
    if (needle) {
      const tags = Array.isArray(it.tags) ? it.tags.join(' ') : '';
      const hay = [it.title, it.blurb, it.summary, tags, it.notes, it.author, it.recommended_by].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}
