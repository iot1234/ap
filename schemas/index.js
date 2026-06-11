// schemas/index.js
// Single entry-point for every Zod schema used by request validators. Each
// section is grouped by domain for grep-ability. Error messages are in Thai
// because they bubble up to end users on validation failure.

const { z } = require('zod');

// --- primitives -----------------------------------------------------------
const phoneStr = z.string().trim()
  .regex(/^[\d\-\s+]{8,20}$/, 'เบอร์โทรไม่ถูกต้อง')
  .transform((s) => s.replace(/[\s-]/g, ''));

const thaiPhone = z.string().trim()
  .regex(/^0\d{9}$/, 'ต้องเป็นเบอร์โทรไทย 10 หลักขึ้นต้นด้วย 0');

const citizenId = z.string().trim()
  .regex(/^\d{13}$/, 'เลขบัตร ปชช. ต้อง 13 หลัก');

const promptpayTarget = z.string().trim()
  .transform((s) => s.replace(/-/g, ''))
  .refine((s) => /^0\d{9}$/.test(s) || /^\d{13}$/.test(s),
    'PromptPay ต้องเป็นเบอร์โทร 10 หลัก หรือ เลขบัตร 13 หลัก');

const idParam = z.coerce.number().int().positive();

// --- auth -----------------------------------------------------------------
const schemas = {};

schemas.login = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});

schemas.changePassword = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12, 'รหัสผ่านใหม่ต้อง ≥ 12 ตัว').max(128),
});

schemas.tenantLogin = z.object({
  phone: phoneStr,
}).strict();

// --- tenants --------------------------------------------------------------
schemas.createTenant = z.object({
  fullName: z.string().trim().min(1).max(200),
  phone: phoneStr,
  citizenId: citizenId.optional(),
  email: z.string().email('อีเมลไม่ถูกต้อง').max(200).optional().or(z.literal('').transform(() => undefined)),
  lineUserId: z.string().max(64).optional(),
  roomId: z.string().max(32).optional(),
  status: z.enum(['active', 'moved_out', 'blacklist']).optional(),
  notes: z.string().max(1000).optional(),
  locale: z.enum(['th', 'en']).optional(),
});

schemas.updateTenant = schemas.createTenant.partial().extend({
  blacklistReason: z.string().max(500).optional(),
});

schemas.checkIn = z.object({
  roomId: z.string().min(1).max(32),
  moveInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'วันที่ต้องเป็น YYYY-MM-DD'),
  depositAmount: z.coerce.number().nonnegative().max(1_000_000),
  monthlyRent: z.coerce.number().positive().max(1_000_000),
  // Contract length in months — used to derive the rent discount tier
  // (config.discounts.{sixMonth,twelveMonth,twentyFourMonth}). Either
  // termMonths (we resolve % from config) or discountPct (explicit) wins.
  // Cap at 60 months (5 years) — the previous 120-month cap let admins
  // accidentally type "120 years" and get a contract ending in 2146.
  termMonths: z.coerce.number().int().min(1).max(60).optional(),
  // Optional explicit end date. If supplied without termMonths, server keeps
  // the date and stores term_months only when it exactly matches a month span.
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'วันสิ้นสุดต้องเป็น YYYY-MM-DD').optional(),
  discountPct: z.coerce.number().nonnegative().max(50).optional(),
  waterStartReading: z.coerce.number().nonnegative().max(9_999_999).optional(),
  elecStartReading: z.coerce.number().nonnegative().max(9_999_999).optional(),
  // Legal trail: client surfaces the terms-and-conditions text version so
  // we can store WHICH wording the tenant agreed to. Optional in the
  // schema (open contracts can predate the feature) but checked at
  // server-level when features.contractTerms.enforce is on.
  agreedTermsVersion: z.string().max(64).optional(),
  // Bypass safety guards (existing tenant migration, retroactive checkins)
  // — every set bypass is audit-logged.
  force: z.boolean().optional(),
});

schemas.contractSign = z.object({
  signatureDataUrl: z.string().min(20).max(3_000_000),
  agreedTermsVersion: z.string().max(64).optional(),
  force: z.boolean().optional(),
});

schemas.uploadIdentity = z.object({
  citizenId: citizenId.optional(),
  frontDataUrl: z.string().min(20).max(3_000_000).optional(),
  backDataUrl: z.string().min(20).max(3_000_000).optional(),
  force: z.boolean().optional(),
}).refine(
  (v) => v.frontDataUrl || v.backDataUrl || v.citizenId,
  { message: 'ต้องส่งภาพหน้า/หลังของบัตร หรือเลขบัตร 13 หลัก อย่างน้อยหนึ่งอย่าง' },
);

schemas.checkOut = z.object({
  // Handler re-enforces >=5 chars (CONTRACT_CLOSE_REASON_REQUIRED) — declared
  // here too so the schema doesn't advertise reason as optional when it isn't.
  reason: z.string({ required_error: 'ระบุเหตุผลการย้ายออกอย่างน้อย 5 ตัวอักษร' })
    .trim().min(5, 'ระบุเหตุผลการย้ายออกอย่างน้อย 5 ตัวอักษร').max(500),
  finalDepositReturn: z.coerce.number().nonnegative().max(1_000_000).optional(),
  // Admin opts out of the auto-generated pro-rated closing bill (e.g. when
  // checkout falls on the last day of the month and the regular monthly
  // bill already covers everything). Without this field declared, zod's
  // default .strip() removes it and `req.body.generateClosingBill !== false`
  // is always true — the opt-out becomes dead code.
  generateClosingBill: z.boolean().optional(),
  // Final meter readings at move-out. Metered water/elec consumption since
  // the last recorded reading is charged on the closing bill; without these
  // the final partial period's usage is never billed (the next tenant's
  // baseline absorbs it). Flat-mode utilities ignore them.
  waterEndReading: z.coerce.number().nonnegative().max(9_999_999).optional(),
  elecEndReading: z.coerce.number().nonnegative().max(9_999_999).optional(),
  // Escape hatch mirroring check-in's force path: a reading BELOW the last
  // recorded one is rejected (METER_END_BACKWARD) unless the admin confirms
  // the meter was physically replaced/reset.
  allowMeterRollback: z.boolean().optional(),
});

// --- rooms ----------------------------------------------------------------
const optionalPositiveMoney = z.preprocess(
  (v) => (v === '' ? null : v),
  z.coerce.number().positive().max(1_000_000).nullable().optional(),
);
const optionalTextOrNull = (max) => z.preprocess(
  (v) => (v === '' ? null : v),
  z.string().max(max).nullable().optional(),
);
const optionalIsoDateOrNull = z.preprocess(
  (v) => (v === '' ? null : v),
  z.string().datetime({ offset: true }).nullable().optional(),
);

schemas.createRoom = z.object({
  floor: z.coerce.number().int().min(1).max(99),
  roomNo: z.coerce.number().int().min(1).max(999),
  roomCode: z.string().max(32).optional(),
  roomType: z.enum(['standard', 'deluxe', 'suite', 'studio']),
  rentPrice: z.coerce.number().positive().max(1_000_000),
  rentOverride: optionalPositiveMoney,
  rentOverrideReason: optionalTextOrNull(500),
  rentOverrideAt: optionalIsoDateOrNull,
  rentOverrideBy: optionalTextOrNull(64),
  depositPrice: z.coerce.number().nonnegative().max(1_000_000),
  wifiFee: z.coerce.number().nonnegative().max(10_000).optional(),
  viewType: z.string().max(64).optional(),
  hasBalcony: z.boolean().optional(),
  hasParking: z.boolean().optional(),
  hasKitchen: z.boolean().optional(),
  hasAc: z.boolean().optional(),
  sizeSqm: z.coerce.number().nonnegative().max(1000).optional(),
  bedCount: z.coerce.number().int().nonnegative().max(20).optional(),
  notes: z.string().max(1000).optional(),
});
schemas.updateRoom = schemas.createRoom.partial();

// --- bills ----------------------------------------------------------------
schemas.generateBill = z.object({
  roomId: z.string().min(1).max(32),
  period: z.string().regex(/^\d{4}-\d{2}$/, 'รอบบิลต้องเป็น YYYY-MM'),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'กำหนดชำระต้องเป็น YYYY-MM-DD').optional(),
  compute: z.boolean().optional(),
  recurring: z.array(z.object({
    label: z.string().max(80),
    amount: z.coerce.number().nonnegative().max(1_000_000),
  })).optional(),
  other: z.array(z.object({
    label: z.string().max(80),
    amount: z.coerce.number().nonnegative().max(1_000_000),
  })).optional(),
});

const billMoney = z.coerce.number().nonnegative().max(10_000_000);
const billUnits = z.coerce.number().nonnegative().max(9_999_999);
const billReading = z.coerce.number().nonnegative().max(999_999_999);
const billLineItems = z.array(z.object({
  label: z.string().trim().min(1).max(80),
  qty: z.coerce.string().max(80).optional(),
  detail: z.coerce.string().max(240).optional(),
  amount: billMoney,
})).max(100);

schemas.generateBill = schemas.generateBill.extend({
  period: z.string().regex(/^\d{4}-\d{2}$/, 'รอบบิลต้องเป็น YYYY-MM').optional(),
  tenantId: z.coerce.number().int().positive().optional().nullable(),
  billNo: z.string().trim().min(1).max(80).optional(),
  rent: billMoney.optional(),
  waterPrevReading: billReading.optional().nullable(),
  waterCurrentReading: billReading.optional().nullable(),
  waterUnits: billUnits.optional(),
  waterRate: billMoney.optional(),
  waterAmount: billMoney.optional(),
  elecPrevReading: billReading.optional().nullable(),
  elecCurrentReading: billReading.optional().nullable(),
  elecUnits: billUnits.optional(),
  elecRate: billMoney.optional(),
  elecAmount: billMoney.optional(),
  wifi: billMoney.optional(),
  subtotal: billMoney.optional(),
  vat: billMoney.optional(),
  lateFee: billMoney.optional(),
  total: billMoney.optional(),
  recurring: billLineItems.optional(),
  other: billLineItems.optional(),
}).superRefine((v, ctx) => {
  // Computed bills derive these fields from room/config. Fully-formed
  // manual bills must provide the fields the ledger cannot infer safely.
  if (v.compute) return;
  for (const key of ['billNo', 'period', 'dueDate', 'total']) {
    if (v[key] == null || v[key] === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required when compute=false`,
      });
    }
  }
  if (v.total != null && Number(v.total) <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['total'],
      message: 'total must be greater than 0',
    });
  }
});

schemas.recordPayment = z.object({
  billId: z.coerce.number().int().positive(),
  amount: z.coerce.number().positive().max(10_000_000),
  method: z.enum(['cash', 'transfer', 'promptpay']).optional(),
  ref: z.string().max(120).optional(),
  slip: z.string().max(2_500_000).optional(),  // base64 data URL
});

schemas.verifyPayment = z.object({
  accept: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});

schemas.voidBill = z.object({
  reason: z.string().max(500).optional(),
});

// --- bookings -------------------------------------------------------------
schemas.publicBooking = z.object({
  roomId: z.string().max(32).optional(),
  tenantName: z.string().trim().min(1).max(120),
  phone: phoneStr.optional().or(z.literal('').transform(() => undefined)),
  email: z.string().email().max(200).optional().or(z.literal('').transform(() => undefined)),
  checkInDate: z.string().max(16).optional(),
  floor: z.string().max(4).optional(),
  roomType: z.enum(['standard', 'deluxe', 'suite', 'studio']).optional(),
  message: z.string().max(500).optional(),
  // Optional pre-screening so the booking already carries identity + the
  // T&C acceptance audit trail. Only the citizen ID TAIL (last 4 digits)
  // is persisted on the bookings row — the full number is uploaded later
  // at admin tenant creation. The optional photo is stored under
  // category='citizen_id_image' with side='front'.
  citizenIdTail: z.string().regex(/^\d{4}$/, '4 ตัวท้ายของบัตร').optional(),
  citizenIdImageFront: z.string().min(20).max(3_000_000).optional(),
  expectedDeposit: z.coerce.number().nonnegative().max(1_000_000).optional(),
  holdToken: z.string().max(200).optional(),
  depositSlip: z.string().min(20).max(3_000_000).optional(),
  // Legal trail: when the applicant ticks the "I agree to terms" checkbox,
  // the client sends the version string of the displayed T&C document.
  // Version is just an opaque label — a future revision can still match
  // historical bookings to the wording they actually saw.
  agreedTermsVersion: z.string().max(64).optional(),
});

// Admin books on a customer's behalf (walk-in / phone booking). Mirrors
// publicBooking but: phone is REQUIRED (the booking must be reachable +
// dedupable + blacklist-checkable — the public form can rely on the person
// standing in front of the screen, a phone booking can't), no hold-token /
// slip fields (admin collects the fee in person and attests via
// depositCollected), and months is adjustable up-front.
schemas.adminBooking = z.object({
  // min(1) makes '' fail the first union branch and fall through to the
  // ''→undefined normaliser (a bare .max() accepts '' and would keep it).
  roomId: z.string().min(1).max(32).optional().or(z.literal('').transform(() => undefined)),
  tenantName: z.string().trim().min(1).max(120),
  phone: phoneStr,
  email: z.string().email().max(200).optional().or(z.literal('').transform(() => undefined)),
  checkInDate: z.string().min(1).max(16).optional().or(z.literal('').transform(() => undefined)),
  floor: z.coerce.string().min(1).max(4).optional().or(z.literal('').transform(() => undefined)),
  roomType: z.enum(['standard', 'deluxe', 'suite', 'studio']).optional(),
  months: z.coerce.number().int().min(1).max(60).optional(),
  message: z.string().max(500).optional(),
  // true = admin already received the booking fee (cash / transfer seen on
  // their own banking app). Recorded as depositStatus='verified' with
  // provider='manual' + the admin's username in the audit log.
  depositCollected: z.boolean().optional(),
  depositPaymentMethod: z.enum(['cash', 'transfer', 'promptpay']).optional(),
});

// --- tickets --------------------------------------------------------------
schemas.createTicket = z.object({
  roomId: z.string().min(1).max(32),
  tenantName: z.string().max(120).optional(),
  // Use the same phone validator as the rest of the system so a malformed
  // phone (e.g. "abc123") can't be saved on a ticket and break later
  // lookup / notification flows. Empty string is normalised to undefined.
  tenantPhone: phoneStr.optional().or(z.literal('').transform(() => undefined)),
  category: z.enum(['electrical', 'plumbing', 'aircon', 'furniture', 'appliance', 'door_lock', 'wifi', 'other']),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
});

schemas.updateTicket = z.object({
  status: z.enum(['open', 'assigned', 'in_progress', 'awaiting_parts', 'completed', 'cancelled']).optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  assignedTo: z.string().max(120).optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  cost: z.coerce.number().nonnegative().max(1_000_000).optional(),
});

schemas.rateTicket = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
  phone: phoneStr,
});

// --- meters ---------------------------------------------------------------
schemas.recordMeter = z.object({
  meterType: z.enum(['water', 'elec']),
  reading: z.coerce.number().nonnegative().max(9_999_999),
  source: z.enum(['manual', 'simulator', 'mqtt']).optional(),
});

// --- access ---------------------------------------------------------------
schemas.accessLog = z.object({
  device: z.string().min(1).max(64),
  method: z.enum(['rfid', 'qr', 'ble', 'manual']).optional(),
  result: z.enum(['granted', 'denied']).optional(),
  roomId: z.string().max(32).optional(),
  tenantId: z.coerce.number().int().positive().optional(),
  cardId: z.string().max(64).optional(),
  reason: z.string().max(200).optional(),
});

// --- backup restore -------------------------------------------------------
// Strict shape check + sanitisation for the JSON file an admin uploads via
// the Settings → Restore flow. Reject anything that doesn't look like our
// own backup format so an attacker can't craft a payload that swaps in
// their own PromptPay number or owner email.
schemas.backupImport = z.object({
  schemaVersion: z.literal(1).optional(),
  version: z.literal(1).optional(),
  rooms: z.record(z.string().max(32), z.record(z.string(), z.any())).optional(),
  config: z.object({
    building: z.record(z.string(), z.any()).optional(),
    payment: z.object({
      promptpayTarget: promptpayTarget.optional(),
      promptpayDisplayName: z.string().max(120).optional(),
    }).passthrough().optional(),
    utilities: z.record(z.string(), z.any()).optional(),
    notify: z.record(z.string(), z.any()).optional(),
    automation: z.record(z.string(), z.any()).optional(),
  }).passthrough().optional(),
  bookings: z.array(z.record(z.string(), z.any())).optional(),
  activities: z.array(z.record(z.string(), z.any())).optional(),
}).passthrough();

// --- features -------------------------------------------------------------
schemas.featureUpdate = z.record(z.string(), z.record(z.string(), z.any()));

// --- system settings ------------------------------------------------------
schemas.systemSettingPut = z.object({
  value: z.any(),
  description: z.string().max(500).optional(),
});

// --- user mgmt (admin) ----------------------------------------------------
schemas.adminCreateUser = z.object({
  username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/, 'อักษรอนุญาต a-z 0-9 _.-'),
  password: z.string().min(12).max(128),
  role: z.enum(['owner', 'manager', 'staff', 'readonly']).optional(),
});

schemas.adminUpdateUser = z.object({
  password: z.string().min(12).max(128).optional(),
  // Required ONLY when caller is changing their OWN password — server
  // enforces this so a hijacked session can't lock out the legit owner
  // without also knowing the current password.
  currentPassword: z.string().min(1).max(128).optional(),
  role: z.enum(['owner', 'manager', 'staff', 'readonly']).optional(),
});

module.exports = { z, schemas, idParam, phoneStr, thaiPhone, citizenId, promptpayTarget };
