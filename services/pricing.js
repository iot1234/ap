// services/pricing.js
// Single source of truth for "what rent does this room cost?". Eliminates
// the drift that built up when admin set rates in three places:
//   1. /admin#pricing            → config.rates[type].rent (template)
//   2. /admin#rooms              → rooms[id].rent (snapshot per room)
//   3. checkin → contracts       → contracts.monthly_rent (legal lock)
//
// Without a resolver, callers picked their own source and bills came out
// inconsistent with the admin's intent. The resolver enforces priority:
//
//   1. contract.monthly_rent     — locked at signing, immutable for the
//                                   life of that contract (legal binding,
//                                   tenant-rights compliance)
//   2. room.rent_override        — admin set a special rate for THIS room
//                                   (damaged unit, loyalty deal, etc.)
//                                   only used when there's no active
//                                   contract — vacant rooms preview
//   3. computeFromFormula(...)   — derive from config.rates[type] +
//                                   floor/view/feature premiums. Reflects
//                                   admin's CURRENT pricing intent.
//   4. legacy fallback           — room.rent (the static field that pre-
//                                   resolver code wrote). Only used when
//                                   the room has nothing else. Lets us
//                                   ship this resolver without breaking
//                                   the legacy room blob.
//
// The function is PURE — no DB, no I/O. Caller assembles the inputs.

const ROOM_TYPE_DEFAULTS = Object.freeze({
  standard: { rent: 4500, ac: false },
  deluxe:   { rent: 5800, ac: true },
  suite:    { rent: 7500, ac: true },
  studio:   { rent: 6800, ac: true },
});

const MIN_SENSIBLE_RENT = 100;
const MIN_SENSIBLE_CONTRACT_RENT = 1000;
const CONTRACT_RENT_REFERENCE_RATIO = 0.5;

function roomTypeOf(room) {
  return String(room?.type || room?.room_type || room?.roomType || 'standard');
}

function roomViewOf(room) {
  return room?.view ?? room?.view_type ?? room?.viewType;
}

function positiveNumberOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nonNegativeNumberOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function isImplausiblyLowRent(v, min = MIN_SENSIBLE_RENT) {
  if (v === undefined || v === null || v === '') return false;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < min;
}

function hasImplausiblyLowConfiguredRate(config, type) {
  const r = config?.rates?.[type];
  return !!(r && Object.prototype.hasOwnProperty.call(r, 'rent')
    && isImplausiblyLowRent(r.rent, MIN_SENSIBLE_RENT));
}

function getConfiguredBaseRent(config, type, typeDefault) {
  const r = config?.rates?.[type];
  if (!r || !Object.prototype.hasOwnProperty.call(r, 'rent') || r.rent === null || r.rent === '') {
    return typeDefault.rent;
  }
  const n = Number(r.rent);
  if (!Number.isFinite(n)) return typeDefault.rent;
  if (isImplausiblyLowRent(n, MIN_SENSIBLE_RENT)) return typeDefault.rent;
  return n;
}

/**
 * Compute the formula-derived rent for a room from current config.
 * Mirrors project/admin/shared.jsx#computeRoomRent so the server-side
 * and client-side preview produce identical numbers.
 *
 * @param {object} room    - { type, floor, view, balcony?, parking?, kitchen?, has_ac? }
 * @param {object} config  - app_data['baankarn_config_v1'] shape
 * @returns {number}       - rounded to 2 decimals
 */
function computeFromFormula(room, config) {
  if (!room || typeof room !== 'object') return 0;
  const cfg = config || {};
  const type = roomTypeOf(room);
  const rates = cfg.rates || {};
  const r = rates[type];
  // Distinguish "admin explicitly set rate (even to 0)" from "type not in
  // config at all". Explicit 0 means admin's intent — honor it (caller can
  // fall back to legacy room.rent if 0 isn't billable). The hardcoded
  // type-default acts as a safety net ONLY when admin hasn't configured
  // this type yet (fresh deploy day 1).
  const typeDefault = ROOM_TYPE_DEFAULTS[type] || ROOM_TYPE_DEFAULTS.standard;
  const base = getConfiguredBaseRent(cfg, type, typeDefault);

  const floor = (cfg.floorPremium || {})[room.floor] || 0;
  const view  = (cfg.viewPremium  || {})[roomViewOf(room)]  || 0;
  const fp    = cfg.featurePremium || {};

  // Feature flags can be named either room.balcony (legacy blob) or
  // room.has_balcony (rooms_v2 column) — accept both.
  const has = (...keys) => keys.some((k) => !!room[k]);
  const firstPresent = (...keys) => {
    for (const k of keys) {
      if (room[k] !== undefined && room[k] !== null) return room[k];
    }
    return undefined;
  };
  const acRaw = firstPresent('ac', 'hasAc', 'has_ac');
  const balcony = has('balcony', 'hasBalcony', 'has_balcony') ? (Number(fp.balcony) || 0) : 0;
  const ac      = (acRaw === undefined ? !!typeDefault.ac : !!acRaw) ? (Number(fp.ac) || 0) : 0;
  const parking = has('parking', 'hasParking', 'has_parking') ? (Number(fp.parking) || 0) : 0;
  const kitchen = has('kitchen', 'hasKitchen', 'has_kitchen') ? (Number(fp.kitchen) || 0) : 0;

  const total = Number(base) + Number(floor) + Number(view) + balcony + ac + parking + kitchen;
  return Math.round(total * 100) / 100;
}

/**
 * Resolve the rent to put on a generated bill. Returns BOTH the number
 * and the source — callers can audit-log the source so a tenant dispute
 * "why was my bill X?" has an answer six months later.
 *
 * @param {object} opts
 * @param {object} opts.room     - room from JSONB blob or rooms_v2 row
 * @param {object} [opts.contract] - active contract row (optional)
 * @param {object} [opts.config]   - app_data['baankarn_config_v1']
 * @returns {{ rent: number, source: 'contract'|'override'|'formula'|'legacy', contractId?: number, reason?: string }}
 */
function resolveBillingRent({ room, contract, config, expiredContract = null }) {
  // 1. Contract lock — highest priority. A signed contract's rent is
  //    immutable; even if admin "fixes" the rate in /admin#pricing,
  //    existing tenants keep paying the rate they signed for.
  if (contract && contract.status === 'active' && Number(contract.monthly_rent) > 0) {
    return {
      rent: Number(contract.monthly_rent),
      source: 'contract',
      contractId: contract.id,
    };
  }

  // 1.5 Expired-contract continuation — a tenant who stays past a fixed term
  //     (no renewal signed yet) is, by Thai rental convention, on an implied
  //     month-to-month continuation at the SAME rent they signed, NOT the
  //     current /admin#pricing formula. Without this, the day a contract
  //     expires the bill silently jumps to the formula rate while the tenant
  //     is still living there — breaking the locked-rate guarantee. Only the
  //     caller (scheduler/bulk-gen) decides this applies, by passing the most-
  //     recent expired contract for a room whose tenant is still resident.
  if (expiredContract && Number(expiredContract.monthly_rent) > 0) {
    return {
      rent: Number(expiredContract.monthly_rent),
      source: 'contract_expired_continuation',
      contractId: expiredContract.id,
    };
  }

  // 2. Per-room override — admin marked this specific room as having a
  //    special rate (damaged, smaller, promo). Used for vacant rooms +
  //    the rate that gets snapshotted into the NEXT contract.
  const snakeOverride = positiveNumberOrNull(room?.rent_override);
  if (snakeOverride !== null) {
    return {
      rent: snakeOverride,
      source: 'override',
      reason: room.rent_override_reason || null,
    };
  }
  // Same field, JSONB blob shape (camelCase)
  const camelOverride = positiveNumberOrNull(room?.rentOverride);
  if (camelOverride !== null) {
    return {
      rent: camelOverride,
      source: 'override',
      reason: room.rentOverrideReason || null,
    };
  }

  // 3. Formula — derived from current config.rates + premiums. Reflects
  //    the admin's CURRENT pricing intent. Used for vacant rooms +
  //    new-contract proposals.
  //
  //    Only attempt formula when the room has a concrete `type` AND the
  //    config has the matching rates entry. Otherwise we'd silently bill
  //    the hardcoded type default (4500 etc.) when the admin's intent
  //    might be a different static rate already in room.rent. This rule
  //    also keeps legacy data (rooms without type from older blobs)
  //    working without surprise: they fall through to the legacy branch.
  const type = roomTypeOf(room);
  const hasUsableType = !!(room && (room.type || room.room_type || room.roomType));
  const hasConfiguredRate = !!(config && config.rates && config.rates[type]);
  if (hasUsableType && hasConfiguredRate) {
    const formula = computeFromFormula(room, config);
    if (formula > 0) {
      return {
        rent: formula,
        source: 'formula',
        warning: hasImplausiblyLowConfiguredRate(config, type)
          ? {
              code: 'CONFIG_RENT_TOO_LOW_IGNORED',
              type,
              configuredRent: Number(config.rates[type].rent),
              fallbackBaseRent: (ROOM_TYPE_DEFAULTS[type] || ROOM_TYPE_DEFAULTS.standard).rent,
            }
          : undefined,
      };
    }
  }

  // 4. Legacy / static fallback — old room.rent field, or the type
  //    default when admin hasn't configured the rate yet. Reached when:
  //    - no contract, no override
  //    - AND no config.rates entry for the room's type (fresh deploy)
  //      OR room has no `type` at all (very old data)
  //    Keeps the resolver safe to ship without breaking unmigrated
  //    deployments. If room.rent is also 0 we last-resort the type
  //    default so day-1 deploys don't bill ฿0 by accident.
  const legacy = room ? Number(room.rent ?? room.rentPrice ?? room.rent_price) : 0;
  if (legacy > 0) {
    return { rent: legacy, source: 'legacy' };
  }
  if (hasUsableType) {
    const fallback = computeFromFormula(room, config);
    if (fallback > 0) return { rent: fallback, source: 'formula' };
  }
  return { rent: 0, source: 'legacy' };
}

function resolveExpectedRoomRent({ room, config }) {
  return resolveBillingRent({ room, config });
}

function resolveContractDeposit({ room, config, rent } = {}) {
  const type = roomTypeOf(room);
  const configured = nonNegativeNumberOrNull(config?.rates?.[type]?.deposit);
  if (configured !== null) {
    return { deposit: roundMoney(configured), source: 'pricing_config' };
  }

  const roomDeposit = nonNegativeNumberOrNull(
    room?.deposit ?? room?.depositPrice ?? room?.deposit_price
  );
  if (roomDeposit !== null) {
    return { deposit: roundMoney(roomDeposit), source: 'room' };
  }

  const monthlyRent = nonNegativeNumberOrNull(rent);
  if (monthlyRent !== null) {
    return { deposit: roundMoney(monthlyRent * 2), source: 'rent_x2' };
  }

  return { deposit: 0, source: 'none' };
}

function assessContractRent({ monthlyRent, room = null, config = null } = {}) {
  const rent = Number(monthlyRent);
  if (!Number.isFinite(rent) || rent <= 0) {
    return {
      ok: false,
      code: 'CONTRACT_RENT_INVALID',
      field: 'monthlyRent',
      rent: Number.isFinite(rent) ? rent : null,
      message: 'monthlyRent must be a positive number',
      hint: 'Enter the real monthly rent before creating or approving the contract.',
    };
  }

  const reference = room ? resolveExpectedRoomRent({ room, config }) : { rent: 0, source: 'none' };
  const referenceRent = Number(reference.rent) || 0;
  const referenceFloor = referenceRent > 0
    ? Math.round(referenceRent * CONTRACT_RENT_REFERENCE_RATIO * 100) / 100
    : 0;
  const minimumRent = Math.max(MIN_SENSIBLE_CONTRACT_RENT, referenceFloor);

  if (rent < minimumRent) {
    return {
      ok: false,
      code: 'CONTRACT_RENT_TOO_LOW',
      field: 'monthlyRent',
      rent,
      minimumRent,
      referenceRent,
      referenceSource: reference.source || null,
      message: referenceRent > 0
        ? `monthlyRent ${rent} is suspiciously low for this room; expected at least ${minimumRent} from ${reference.source} rent ${referenceRent}`
        : `monthlyRent ${rent} is suspiciously low; expected at least ${minimumRent}`,
      hint: 'Check for missing zeros or stale pricing config. Use force only for a deliberate legacy migration.',
    };
  }

  return {
    ok: true,
    rent,
    minimumRent,
    referenceRent,
    referenceSource: reference.source || null,
  };
}

/**
 * Find the impact of changing config.rates. Useful for the
 * /admin#pricing "preview impact before saving" UI.
 *
 * @param {Array<object>} rooms     - all rooms (blob shape)
 * @param {object} oldConfig
 * @param {object} newConfig
 * @returns {{ unchanged: number, willChange: Array<{roomId, oldRent, newRent}> }}
 */
function previewImpact(rooms, oldConfig, newConfig) {
  const list = Array.isArray(rooms) ? rooms : Object.values(rooms || {});
  const willChange = [];
  let unchanged = 0;
  for (const room of list) {
    if (!room || typeof room !== 'object') continue;
    const oldR = resolveBillingRent({ room, config: oldConfig }).rent;
    const newR = resolveBillingRent({ room, config: newConfig }).rent;
    if (oldR !== newR) {
      willChange.push({ roomId: room.id || room.room_code || room.roomCode, oldRent: oldR, newRent: newR });
    } else {
      unchanged++;
    }
  }
  return { unchanged, willChange };
}

function roomIdOf(room) {
  return room?.id || room?.room_code || room?.roomCode || room?.roomId || null;
}

function makeRoomMap(rooms) {
  const list = Array.isArray(rooms) ? rooms : Object.values(rooms || {});
  const map = new Map();
  for (const room of list) {
    if (!room || typeof room !== 'object') continue;
    const id = roomIdOf(room);
    if (!id) continue;
    map.set(String(id), room);
  }
  return map;
}

function statusIsExistingTenancy(status) {
  return ['occupied', 'overdue'].includes(String(status || '').toLowerCase());
}

/**
 * Authoritative preview for /admin#pricing saves. It separates:
 *   - active contracts: locked today, can be updated only by explicit choice
 *   - future rooms: vacant/reserved/maintenance rooms that will feed the next
 *     contract/check-in price
 *
 * This stays pure so backend and tests can share the same money math.
 */
function previewPricingChangeImpact({ rooms, contracts = [], oldConfig, newConfig } = {}) {
  const roomMap = makeRoomMap(rooms);
  const activeRoomIds = new Set(
    (Array.isArray(contracts) ? contracts : [])
      .map((c) => c && c.room_id)
      .filter(Boolean)
      .map(String)
  );

  const activeContractChanges = [];
  const futureRoomChanges = [];

  for (const contract of Array.isArray(contracts) ? contracts : []) {
    if (!contract || !contract.room_id) continue;
    const room = roomMap.get(String(contract.room_id));
    if (!room) {
      activeContractChanges.push({
        type: 'missing_room',
        roomId: String(contract.room_id),
        contractId: contract.id || null,
        contractNo: contract.contract_no || null,
        tenantName: contract.tenant_name || contract.full_name || null,
        currentRent: roundMoney(contract.monthly_rent),
        currentDeposit: roundMoney(contract.deposit),
      });
      continue;
    }

    const oldRent = resolveExpectedRoomRent({ room, config: oldConfig });
    const newRent = resolveExpectedRoomRent({ room, config: newConfig });
    const oldDeposit = resolveContractDeposit({ room, config: oldConfig, rent: oldRent.rent });
    const newDeposit = resolveContractDeposit({ room, config: newConfig, rent: newRent.rent });
    const rentSettingChanged = Math.abs(roundMoney(oldRent.rent) - roundMoney(newRent.rent)) >= 0.01;
    const depositSettingChanged = Math.abs(oldDeposit.deposit - newDeposit.deposit) >= 0.01;
    if (!rentSettingChanged && !depositSettingChanged) continue;

    const currentRent = roundMoney(contract.monthly_rent);
    const currentDeposit = roundMoney(contract.deposit);
    activeContractChanges.push({
      type: 'active_contract',
      roomId: String(contract.room_id),
      contractId: contract.id || null,
      contractNo: contract.contract_no || null,
      tenantId: contract.tenant_id || null,
      tenantName: contract.tenant_name || contract.full_name || null,
      status: contract.status || 'active',
      currentRent,
      currentDeposit,
      oldSettingRent: roundMoney(oldRent.rent),
      newSettingRent: roundMoney(newRent.rent),
      oldSettingDeposit: oldDeposit.deposit,
      newSettingDeposit: newDeposit.deposit,
      rentSourceBefore: oldRent.source || null,
      rentSourceAfter: newRent.source || null,
      depositSourceBefore: oldDeposit.source,
      depositSourceAfter: newDeposit.source,
      rentDelta: roundMoney(roundMoney(newRent.rent) - currentRent),
      depositDelta: roundMoney(newDeposit.deposit - currentDeposit),
      willUpdateRent: Math.abs(roundMoney(newRent.rent) - currentRent) >= 0.01,
      willUpdateDeposit: Math.abs(newDeposit.deposit - currentDeposit) >= 0.01,
    });
  }

  for (const room of roomMap.values()) {
    const roomId = String(roomIdOf(room));
    if (!roomId || activeRoomIds.has(roomId) || statusIsExistingTenancy(room.status)) continue;
    const oldRent = resolveExpectedRoomRent({ room, config: oldConfig });
    const newRent = resolveExpectedRoomRent({ room, config: newConfig });
    const oldDeposit = resolveContractDeposit({ room, config: oldConfig, rent: oldRent.rent });
    const newDeposit = resolveContractDeposit({ room, config: newConfig, rent: newRent.rent });
    const rentChanged = Math.abs(roundMoney(oldRent.rent) - roundMoney(newRent.rent)) >= 0.01;
    const depositChanged = Math.abs(oldDeposit.deposit - newDeposit.deposit) >= 0.01;
    if (!rentChanged && !depositChanged) continue;
    futureRoomChanges.push({
      roomId,
      status: room.status || 'unknown',
      type: roomTypeOf(room),
      oldRent: roundMoney(oldRent.rent),
      newRent: roundMoney(newRent.rent),
      oldDeposit: oldDeposit.deposit,
      newDeposit: newDeposit.deposit,
      rentSourceBefore: oldRent.source || null,
      rentSourceAfter: newRent.source || null,
      depositSourceBefore: oldDeposit.source,
      depositSourceAfter: newDeposit.source,
      rentDelta: roundMoney(roundMoney(newRent.rent) - roundMoney(oldRent.rent)),
      depositDelta: roundMoney(newDeposit.deposit - oldDeposit.deposit),
    });
  }

  const activeRentDelta = roundMoney(activeContractChanges.reduce(
    (sum, item) => sum + (item.type === 'active_contract' ? Number(item.rentDelta || 0) : 0), 0
  ));
  const activeDepositDelta = roundMoney(activeContractChanges.reduce(
    (sum, item) => sum + (item.type === 'active_contract' ? Number(item.depositDelta || 0) : 0), 0
  ));

  return {
    summary: {
      activeContractChanges: activeContractChanges.length,
      futureRoomChanges: futureRoomChanges.length,
      activeRentDelta,
      activeDepositDelta,
      requiresReview: activeContractChanges.length > 0 || futureRoomChanges.length > 0,
    },
    activeContractChanges,
    futureRoomChanges,
  };
}

module.exports = {
  resolveBillingRent,
  resolveExpectedRoomRent,
  resolveContractDeposit,
  assessContractRent,
  computeFromFormula,
  previewImpact,
  previewPricingChangeImpact,
  isImplausiblyLowRent,
  hasImplausiblyLowConfiguredRate,
  MIN_SENSIBLE_RENT,
  MIN_SENSIBLE_CONTRACT_RENT,
  CONTRACT_RENT_REFERENCE_RATIO,
  ROOM_TYPE_DEFAULTS,
};
