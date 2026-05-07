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

const pin = z.string().trim()
  .regex(/^\d{4,8}$/, 'PIN ต้องเป็นตัวเลข 4-8 หลัก');

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
  pin: pin,
});

schemas.tenantSetPin = z.object({
  phone: phoneStr,
  citizenIdTail: z.string().regex(/^\d{4}$/, '4 ตัวท้ายของเลขบัตร'),
  newPin: pin,
});

schemas.tenantChangePin = z.object({
  oldPin: pin,
  newPin: pin,
});

// --- tenants --------------------------------------------------------------
schemas.createTenant = z.object({
  fullName: z.string().trim().min(1).max(200),
  phone: phoneStr,
  citizenId: citizenId.optional(),
  email: z.string().email('อีเมลไม่ถูกต้อง').max(200).optional().or(z.literal('').transform(() => undefined)),
  lineUserId: z.string().max(64).optional(),
  pin: pin.optional(),
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
});

schemas.checkOut = z.object({
  reason: z.string().max(500).optional(),
  finalDepositReturn: z.coerce.number().nonnegative().max(1_000_000).optional(),
});

// --- rooms ----------------------------------------------------------------
schemas.createRoom = z.object({
  floor: z.coerce.number().int().min(1).max(99),
  roomNo: z.coerce.number().int().min(1).max(999),
  roomCode: z.string().max(32).optional(),
  roomType: z.enum(['standard', 'deluxe', 'suite', 'studio']),
  rentPrice: z.coerce.number().positive().max(1_000_000),
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
});

// --- tickets --------------------------------------------------------------
schemas.createTicket = z.object({
  roomId: z.string().min(1).max(32),
  tenantName: z.string().max(120).optional(),
  tenantPhone: z.string().max(32).optional(),
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
