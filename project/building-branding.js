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

  function cleanLogoUrl(value) {
    const logo = String(value || '').trim();
    return /^\/files\/\d+$/.test(logo) ? logo : '';
  }

  function extractBuilding(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const cfg = payload.value || payload.baankarn_config_v1 || payload;
    return cfg && typeof cfg === 'object' && cfg.building ? cfg.building : null;
  }

  function applyLogoToMark(el, logo, name, mark) {
    el.setAttribute('title', name);
    el.setAttribute('aria-label', name);
    if (!logo) {
      el.removeAttribute('data-building-logo-active');
      el.querySelectorAll('img[data-building-logo-img]').forEach((img) => img.remove());
      el.style.background = '';
      el.style.padding = '';
      el.style.overflow = '';
      el.style.boxSizing = '';
      el.textContent = mark;
      return;
    }

    el.textContent = '';
    el.setAttribute('data-building-logo-active', '1');
    el.style.background = '#fff';
    el.style.padding = '4px';
    el.style.overflow = 'hidden';
    el.style.boxSizing = 'border-box';

    let img = el.querySelector('img[data-building-logo-img]');
    if (!img) {
      img = document.createElement('img');
      img.setAttribute('data-building-logo-img', '1');
      el.appendChild(img);
    }
    img.src = logo;
    img.alt = `${name} logo`;
    img.loading = 'eager';
    img.decoding = 'async';
    img.style.display = 'block';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'contain';
    img.style.borderRadius = 'inherit';
  }

  function applyBuilding(building) {
    const name = cleanName(building && building.name);
    const mark = initials(name);
    const logo = cleanLogoUrl(building && building.logo);
    document.querySelectorAll('[data-building-name]').forEach((el) => {
      el.textContent = name;
      el.setAttribute('title', name);
    });
    document.querySelectorAll('[data-building-initials]').forEach((el) => {
      applyLogoToMark(el, logo, name, mark);
    });
    document.querySelectorAll('[data-building-logo]').forEach((el) => {
      if (logo) {
        el.src = logo;
        el.alt = `${name} logo`;
        el.style.display = '';
      } else {
        el.removeAttribute('src');
        el.style.display = 'none';
      }
    });
    const template = document.body && document.body.dataset
      ? document.body.dataset.buildingTitleTemplate
      : '';
    if (template) document.title = template.replace(/\{building\}/g, name);
    return { name, initials: mark, logo };
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
    cleanLogoUrl,
  };

  if (!window.AP_DISABLE_AUTO_BRANDING) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', loadBuildingBranding, { once: true });
    } else {
      loadBuildingBranding();
    }
  }
})();
