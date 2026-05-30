(function () {
  const DEFAULT_BUILDING_NAME = 'ที่พักของคุณ';

  function cleanName(value) {
    const name = String(value || '').trim();
    return name || DEFAULT_BUILDING_NAME;
  }

  function initials(name) {
    const parts = cleanName(name).split(/\s+/).filter(Boolean);
    const chars = parts.length >= 2
      ? parts.slice(0, 2).map((p) => Array.from(p)[0] || '').join('')
      : Array.from(parts[0] || DEFAULT_BUILDING_NAME).slice(0, 2).join('');
    return (chars || 'ที').toUpperCase();
  }

  function extractBuilding(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const cfg = payload.value || payload.baankarn_config_v1 || payload;
    return cfg && typeof cfg === 'object' && cfg.building ? cfg.building : null;
  }

  function applyBuilding(building) {
    const name = cleanName(building && building.name);
    const mark = initials(name);
    document.querySelectorAll('[data-building-name]').forEach((el) => {
      el.textContent = name;
      el.setAttribute('title', name);
    });
    document.querySelectorAll('[data-building-initials]').forEach((el) => {
      el.textContent = mark;
    });
    const template = document.body && document.body.dataset
      ? document.body.dataset.buildingTitleTemplate
      : '';
    if (template) document.title = template.replace(/\{building\}/g, name);
    return { name, initials: mark };
  }

  async function loadBuildingBranding() {
    try {
      const res = await fetch('/api/data/baankarn_config_v1', { credentials: 'same-origin' });
      if (!res.ok) return null;
      const payload = await res.json().catch(() => null);
      const building = extractBuilding(payload);
      if (!building) return null;
      return applyBuilding(building);
    } catch {
      return null;
    }
  }

  window.ApBuildingBranding = {
    apply: applyBuilding,
    load: loadBuildingBranding,
    initials,
    cleanName,
  };

  if (!window.AP_DISABLE_AUTO_BRANDING) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', loadBuildingBranding, { once: true });
    } else {
      loadBuildingBranding();
    }
  }
})();
