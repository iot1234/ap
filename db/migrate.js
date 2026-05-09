// db/migrate.js
// Single idempotent migration block: every CREATE statement uses IF NOT
// EXISTS so re-running on an already-migrated database is a no-op. Splitting
// this out of server.js keeps the boot sequence readable and lets tests run
// migrations without spinning up an HTTP server.

const bcrypt = require('bcryptjs');

async function migrate(pool, opts = {}) {
  const ADMIN_USERNAME = opts.adminUsername || process.env.ADMIN_USERNAME || 'admin';
  const ADMIN_PASSWORD = opts.adminPassword || process.env.ADMIN_PASSWORD;

  await pool.query(`
    -- === v1 (existing) =================================================
    CREATE TABLE IF NOT EXISTS app_data (
      key         TEXT PRIMARY KEY,
      value       JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by  TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'admin',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid    VARCHAR NOT NULL PRIMARY KEY,
      sess   JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions(expire);

    CREATE TABLE IF NOT EXISTS maintenance_tickets (
      id              BIGSERIAL PRIMARY KEY,
      ticket_no       TEXT UNIQUE NOT NULL,
      room_id         TEXT NOT NULL,
      tenant_name     TEXT,
      tenant_phone    TEXT,
      category        TEXT NOT NULL,
      priority        TEXT NOT NULL DEFAULT 'medium',
      status          TEXT NOT NULL DEFAULT 'open',
      title           TEXT NOT NULL,
      description     TEXT,
      assigned_to     TEXT,
      scheduled_at    TIMESTAMPTZ,
      completed_at    TIMESTAMPTZ,
      rating          SMALLINT,
      rating_comment  TEXT,
      cost            NUMERIC(10,2) DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON maintenance_tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_room ON maintenance_tickets(room_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_created ON maintenance_tickets(created_at DESC);
    -- tenant_id added so /api/tenant/maintenance can keep showing a tenant's
    -- past tickets even after they change phone numbers. Public ticket
    -- submissions still come in anonymously (no session) — server.js stamps
    -- tenant_id when phone matches an existing tenants row at create time.
    ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS tenant_id BIGINT;
    CREATE INDEX IF NOT EXISTS idx_tickets_tenant_id ON maintenance_tickets(tenant_id);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id          BIGSERIAL PRIMARY KEY,
      user_id     TEXT,
      action      TEXT NOT NULL,
      entity_type TEXT,
      entity_id   TEXT,
      detail      JSONB,
      ip          TEXT,
      ua          TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

    -- === v2 ============================================================
    CREATE TABLE IF NOT EXISTS tenants (
      id                    BIGSERIAL PRIMARY KEY,
      full_name             TEXT NOT NULL,
      phone                 TEXT NOT NULL,
      citizen_id_encrypted  TEXT,
      citizen_id_tail       TEXT,
      citizen_id_key_ver    SMALLINT DEFAULT 1,
      email                 TEXT,
      line_user_id          TEXT,
      pin_hash              TEXT,
      current_room_id       TEXT,
      status                TEXT NOT NULL DEFAULT 'active',
      blacklist_reason      TEXT,
      notes                 TEXT,
      locale                TEXT DEFAULT 'th',
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at            TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_tenants_phone ON tenants(phone) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_tenants_room ON tenants(current_room_id) WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS contracts (
      id              BIGSERIAL PRIMARY KEY,
      contract_no     TEXT UNIQUE NOT NULL,
      tenant_id       BIGINT REFERENCES tenants(id),
      room_id         TEXT NOT NULL,
      start_date      DATE NOT NULL,
      end_date        DATE,
      monthly_rent    NUMERIC(10,2) NOT NULL,
      deposit         NUMERIC(10,2) DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'active',
      signature_url   TEXT,
      signed_at       TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_contracts_tenant ON contracts(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_contracts_room ON contracts(room_id);

    CREATE TABLE IF NOT EXISTS bills (
      id            BIGSERIAL PRIMARY KEY,
      bill_no       TEXT UNIQUE NOT NULL,
      tenant_id     BIGINT REFERENCES tenants(id),
      room_id       TEXT NOT NULL,
      period        TEXT NOT NULL,
      rent          NUMERIC(10,2) NOT NULL DEFAULT 0,
      water_units   NUMERIC(10,2) DEFAULT 0,
      water_rate    NUMERIC(10,2) DEFAULT 0,
      water_amount  NUMERIC(10,2) DEFAULT 0,
      elec_units    NUMERIC(10,2) DEFAULT 0,
      elec_rate     NUMERIC(10,2) DEFAULT 0,
      elec_amount   NUMERIC(10,2) DEFAULT 0,
      wifi          NUMERIC(10,2) DEFAULT 0,
      other         JSONB DEFAULT '[]'::jsonb,
      subtotal      NUMERIC(10,2) NOT NULL,
      vat           NUMERIC(10,2) DEFAULT 0,
      late_fee      NUMERIC(10,2) DEFAULT 0,
      total         NUMERIC(10,2) NOT NULL,
      due_date      DATE NOT NULL,
      paid_at       TIMESTAMPTZ,
      status        TEXT NOT NULL DEFAULT 'pending',
      void_reason   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_bills_tenant ON bills(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_bills_room_period ON bills(room_id, period);
    CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status);
    -- A7 — at most one non-deleted bill per (room, period) so the scheduler's
    -- auto-gen and admin's manual generate can't both insert. ON CONFLICT
    -- (bill_no) handles bill_no collisions; this catches the case where the
    -- two paths compute different bill_nos for the same logical period.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_bills_room_period_active
      ON bills(room_id, period) WHERE deleted_at IS NULL AND status <> 'void';

    CREATE TABLE IF NOT EXISTS payments (
      id             BIGSERIAL PRIMARY KEY,
      bill_id        BIGINT REFERENCES bills(id),
      tenant_id      BIGINT REFERENCES tenants(id),
      amount         NUMERIC(10,2) NOT NULL,
      method         TEXT NOT NULL,
      ref            TEXT,
      slip_url       TEXT,
      slip_hash      TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      verified_by    TEXT,
      verified_at    TIMESTAMPTZ,
      rejected_reason TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_payments_bill ON payments(bill_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

    -- Auto-verify columns. transaction_ref is the BANK's transaction id
    -- pulled from the slip QR (PromptPay slip carries transRef in EMV
    -- payload). Uniquely identifies one real bank transaction — different
    -- from slip_hash which only catches a re-uploaded byte-identical image.
    -- A tenant who edits the slip image (crops, recompresses, screenshots
    -- the screenshot) gets a different slip_hash but the same transaction_ref;
    -- the partial-unique index below blocks that replay attack.
    --
    -- verify_provider records WHICH service confirmed the slip (slipok,
    -- easyslip, manual) so admin can audit the auto-verify pipeline +
    -- spot which slips bypassed it.
    --
    -- verify_payload stores the raw provider response for forensics —
    -- helpful when a tenant disputes "I paid 5000 but you marked 500".
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS transaction_ref TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS verify_provider TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS verify_payload  JSONB;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_tx_ref
      ON payments(transaction_ref) WHERE transaction_ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_payments_provider
      ON payments(verify_provider) WHERE verify_provider IS NOT NULL;
    -- The slip queue listing query (GET /api/payments?status=pending)
    -- ORDER BYs created_at DESC. Without this composite, Postgres has to
    -- sort the entire matching set on every page load — slow on busy
    -- buildings and was implicated in the renderer-hung complaint when
    -- combined with no client-side fetch timeout. The composite lets the
    -- planner satisfy WHERE+ORDER BY in a single index scan.
    CREATE INDEX IF NOT EXISTS idx_payments_status_created
      ON payments(status, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_slip_hash ON payments(slip_hash) WHERE slip_hash IS NOT NULL;

    CREATE TABLE IF NOT EXISTS meter_readings (
      id          BIGSERIAL PRIMARY KEY,
      room_id     TEXT NOT NULL,
      meter_type  TEXT NOT NULL,
      reading     NUMERIC(10,2) NOT NULL,
      source      TEXT DEFAULT 'manual',
      created_by  TEXT,
      reading_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_meter_room_at ON meter_readings(room_id, meter_type, reading_at DESC);

    CREATE TABLE IF NOT EXISTS access_logs (
      id           BIGSERIAL PRIMARY KEY,
      room_id      TEXT,
      tenant_id    BIGINT,
      device       TEXT NOT NULL,
      method       TEXT NOT NULL,
      card_id      TEXT,
      result       TEXT NOT NULL,
      reason       TEXT,
      occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_access_at ON access_logs(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_access_room ON access_logs(room_id);

    CREATE TABLE IF NOT EXISTS access_cards (
      id            BIGSERIAL PRIMARY KEY,
      card_id       TEXT UNIQUE NOT NULL,
      tenant_id     BIGINT REFERENCES tenants(id),
      room_id       TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      issued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at    TIMESTAMPTZ,
      revoke_reason TEXT
    );

    -- Per-device API token for hardware (RFID readers, ESP32) so they can
    -- POST access events without an admin session. Tokens are hashed at rest.
    CREATE TABLE IF NOT EXISTS access_devices (
      id              BIGSERIAL PRIMARY KEY,
      device_id       TEXT UNIQUE NOT NULL,
      api_token_hash  TEXT NOT NULL,
      enabled         BOOLEAN NOT NULL DEFAULT TRUE,
      description     TEXT,
      last_seen       TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications_log (
      id          BIGSERIAL PRIMARY KEY,
      channel     TEXT NOT NULL,
      recipient   TEXT NOT NULL,
      subject     TEXT,
      body        TEXT,
      status      TEXT NOT NULL,
      error       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notif_at ON notifications_log(created_at DESC);

    -- Persistent retry queue for outbound notifications. Successful sends
    -- still get a row in notifications_log; the queue handles pending +
    -- failed-but-retriable items.
    CREATE TABLE IF NOT EXISTS notifications_queue (
      id            BIGSERIAL PRIMARY KEY,
      channel       TEXT NOT NULL,
      recipient     TEXT NOT NULL,
      subject       TEXT,
      body          TEXT,
      payload       JSONB,
      status        TEXT NOT NULL DEFAULT 'pending',
      retry_count   INT NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error    TEXT,
      sent_at       TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notifq_due ON notifications_queue(status, next_attempt_at);

    CREATE TABLE IF NOT EXISTS file_uploads (
      id            BIGSERIAL PRIMARY KEY,
      category      TEXT NOT NULL,
      ref_id        TEXT,
      filename      TEXT NOT NULL,
      mime_type     TEXT,
      size_bytes    BIGINT,
      storage       TEXT NOT NULL DEFAULT 'local',
      url           TEXT,
      uploaded_by   TEXT,
      uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_files_ref ON file_uploads(category, ref_id);

    CREATE TABLE IF NOT EXISTS tenant_sessions (
      sid     TEXT PRIMARY KEY,
      tenant_id BIGINT NOT NULL REFERENCES tenants(id),
      expire  TIMESTAMPTZ NOT NULL,
      ip      TEXT,
      ua      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- sid stored hashed (sha256) so a DB-only leak doesn't yield directly
    -- replayable session cookies. Older deployments used plaintext sid;
    -- post-migration, those rows fail lookup and tenants re-login (sessions
    -- are 30-day max, opt-in flag — acceptable churn).
    ALTER TABLE tenant_sessions ADD COLUMN IF NOT EXISTS sid_hash TEXT;
    CREATE INDEX IF NOT EXISTS idx_tsess_sid_hash ON tenant_sessions(sid_hash);
    CREATE INDEX IF NOT EXISTS idx_tsess_expire ON tenant_sessions(expire);
    CREATE INDEX IF NOT EXISTS idx_tsess_tenant ON tenant_sessions(tenant_id);

    -- Per-account login lockout (admin and tenant). Tracks consecutive
    -- failures + temporary lockouts so brute-force is rate-limited per
    -- credential, not just per IP.
    CREATE TABLE IF NOT EXISTS login_lockouts (
      principal      TEXT PRIMARY KEY,
      kind           TEXT NOT NULL,
      fail_count     INT NOT NULL DEFAULT 0,
      locked_until   TIMESTAMPTZ,
      first_fail_at  TIMESTAMPTZ,
      last_fail_at   TIMESTAMPTZ
    );

    -- Generic key/value system_settings for new code paths (DB-backed,
    -- replaces ad-hoc localStorage config).
    CREATE TABLE IF NOT EXISTS system_settings (
      key         TEXT PRIMARY KEY,
      value       JSONB NOT NULL,
      description TEXT,
      updated_by  TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- LINE OA binding codes. Admin issues a short code per tenant; tenant
    -- adds the OA as a friend and sends the code in chat. The webhook
    -- matches the code → records source.userId on tenant.line_user_id.
    CREATE TABLE IF NOT EXISTS line_bindings (
      id              BIGSERIAL PRIMARY KEY,
      tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code            TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      line_user_id    TEXT,
      expires_at      TIMESTAMPTZ NOT NULL,
      bound_at        TIMESTAMPTZ,
      blocked_at      TIMESTAMPTZ,
      blocked_reason  TEXT,
      notes           TEXT,
      created_by      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_line_bindings_code ON line_bindings(code);
    CREATE INDEX IF NOT EXISTS idx_line_bindings_tenant ON line_bindings(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_line_bindings_status ON line_bindings(status);
    -- One pending code per tenant; admin must revoke first to issue another.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_line_bindings_pending_per_tenant
      ON line_bindings(tenant_id) WHERE status = 'pending';
    -- A given LINE userId can only be bound to one tenant at a time.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_line_bindings_active_user
      ON line_bindings(line_user_id) WHERE status = 'bound';

    -- Per-tenant block flag — when true, no new binding codes can be issued.
    -- Use this when an ex-tenant abuses the OA after move-out, separately
    -- from blacklisting them for portal login.
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS line_binding_blocked BOOLEAN DEFAULT FALSE;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS line_binding_blocked_at TIMESTAMPTZ;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS line_binding_blocked_reason TEXT;

    -- Multi-OA support. Operator can register N LINE Official Accounts;
    -- tenant can be bound through any of them, and notifications are routed
    -- back through whichever OA they bound on. Each OA has its own webhook
    -- URL (slug-based) so signature verification stays isolated per channel.
    --
    -- Tokens are stored encrypted (services/encryption.js handles versioned
    -- keys). The legacy single-OA env vars (LINE_CHANNEL_ACCESS_TOKEN +
    -- LINE_CHANNEL_SECRET) are still honoured by services/lineOa.js as a
    -- "virtual env OA" with id = 0, so existing deployments keep working.
    CREATE TABLE IF NOT EXISTS line_oas (
      id                              BIGSERIAL PRIMARY KEY,
      slug                            TEXT NOT NULL,
      name                            TEXT NOT NULL,
      description                     TEXT,
      bot_basic_id                    TEXT,
      channel_id                      TEXT,
      channel_secret_encrypted        TEXT,
      channel_access_token_encrypted  TEXT,
      enabled                         BOOLEAN NOT NULL DEFAULT TRUE,
      is_default                      BOOLEAN NOT NULL DEFAULT FALSE,
      owner_user_id                   TEXT,
      bound_count                     INTEGER NOT NULL DEFAULT 0,
      last_seen_at                    TIMESTAMPTZ,
      last_error                      TEXT,
      created_by                      TEXT,
      created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at                      TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_line_oas_slug
      ON line_oas(slug) WHERE deleted_at IS NULL;
    -- Only one OA can be flagged default at a time.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_line_oas_default
      ON line_oas((is_default)) WHERE is_default = TRUE AND deleted_at IS NULL;

    -- Track which OA a binding was created through. NULL = legacy env-OA.
    ALTER TABLE line_bindings ADD COLUMN IF NOT EXISTS oa_id BIGINT;
    ALTER TABLE line_bindings ADD COLUMN IF NOT EXISTS target_oa_id BIGINT;
    -- The active-user uniqueness must be scoped per OA — a single human has
    -- a different LINE userId in each OA they're friends with, so the same
    -- userId across two OAs would collide on the old global index.
    DROP INDEX IF EXISTS uq_line_bindings_active_user;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_line_bindings_active_user_per_oa
      ON line_bindings(COALESCE(oa_id, 0), line_user_id)
      WHERE status = 'bound' AND line_user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_line_bindings_oa ON line_bindings(oa_id);

    -- Cache the binding's OA on the tenant row too, so notifier doesn't have
    -- to JOIN every push. Updated by lineBinding.tryBind / revoke / block.
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS line_oa_id BIGINT;
  `);

  // === FK cascade hardening (idempotent) ===================================
  // access_cards + tenant_sessions previously referenced tenants(id) without
  // an ON DELETE action. Hard-deleting a tenant (rare per soft-delete
  // policy, but possible via DELETE /api/tenants/:id when softDelete flag
  // is off) would either fail with FK violation or orphan the rows.
  // Switch both to ON DELETE CASCADE. Wrapped in DO blocks so the migration
  // is safe to re-run on databases where the constraint already has the
  // right action — the "duplicate_object" / "no such constraint" branches
  // are caught silently.
  for (const stmt of [
    `DO $$ BEGIN
       BEGIN
         ALTER TABLE access_cards DROP CONSTRAINT IF EXISTS access_cards_tenant_id_fkey;
         ALTER TABLE access_cards
           ADD CONSTRAINT access_cards_tenant_id_fkey
           FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
       EXCEPTION WHEN others THEN NULL;
       END;
     END $$;`,
    `DO $$ BEGIN
       BEGIN
         ALTER TABLE tenant_sessions DROP CONSTRAINT IF EXISTS tenant_sessions_tenant_id_fkey;
         ALTER TABLE tenant_sessions
           ADD CONSTRAINT tenant_sessions_tenant_id_fkey
           FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
       EXCEPTION WHEN others THEN NULL;
       END;
     END $$;`,
  ]) {
    try { await pool.query(stmt); } catch (err) {
      console.warn('[db] FK cascade migration warn:', err.message);
    }
  }

  await pool.query(`

    -- Recurring monthly charges per room (parking, internet, locker, etc.).
    -- Bulk-generate auto-pulls active rows for a room → adds them as line
    -- items on the next bill. start_at/end_at let admin pre-schedule
    -- promotional discounts or stop-dates.
    CREATE TABLE IF NOT EXISTS recurring_charges (
      id          BIGSERIAL PRIMARY KEY,
      room_id     TEXT,
      tenant_id   BIGINT REFERENCES tenants(id),
      label       TEXT NOT NULL,
      amount      NUMERIC(10,2) NOT NULL,
      frequency   TEXT NOT NULL DEFAULT 'monthly',  -- monthly | quarterly | one_off
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      start_at    DATE,
      end_at      DATE,
      notes       TEXT,
      created_by  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- a charge must point at a tenant OR a room (not neither)
      CONSTRAINT recurring_target CHECK (room_id IS NOT NULL OR tenant_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_recurring_room ON recurring_charges(room_id) WHERE active = TRUE;
    CREATE INDEX IF NOT EXISTS idx_recurring_tenant ON recurring_charges(tenant_id) WHERE active = TRUE;
    -- Older deployments used start_date/end_date. The application now uses
    -- start_at/end_at everywhere, so add the new columns and copy legacy
    -- values forward without dropping the old columns.
    ALTER TABLE recurring_charges ADD COLUMN IF NOT EXISTS start_at DATE;
    ALTER TABLE recurring_charges ADD COLUMN IF NOT EXISTS end_at DATE;
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='recurring_charges'
           AND column_name='start_date'
      ) THEN
        UPDATE recurring_charges
           SET start_at = COALESCE(start_at, start_date)
         WHERE start_at IS NULL AND start_date IS NOT NULL;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='recurring_charges'
           AND column_name='end_date'
      ) THEN
        UPDATE recurring_charges
           SET end_at = COALESCE(end_at, end_date)
         WHERE end_at IS NULL AND end_date IS NOT NULL;
      END IF;
    END $$;

    -- Encrypted secret store. Holds API keys (LINE, SMTP, Sentry, R2) so
    -- admins can configure them from the UI instead of needing to redeploy
    -- with new env vars. Values are AES-256-GCM encrypted (services/encryption.js)
    -- and never returned in plaintext through any API.
    CREATE TABLE IF NOT EXISTS secrets (
      key             TEXT PRIMARY KEY,
      value_encrypted TEXT NOT NULL,
      description     TEXT,
      updated_by      TEXT,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Bookings table: lets us migrate off the JSONB blob over time. The
    -- public booking endpoint still writes to the blob for backwards-compat
    -- (and so admins keep their existing list), but new code should read
    -- from this table.
    CREATE TABLE IF NOT EXISTS bookings (
      id           BIGSERIAL PRIMARY KEY,
      external_id  TEXT UNIQUE,
      name         TEXT NOT NULL,
      phone        TEXT,
      email        TEXT,
      want_type    TEXT,
      want_floor   INT,
      move_in      DATE,
      months       INT,
      deposit      NUMERIC(10,2) DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'pending',
      source       TEXT,
      message      TEXT,
      room_id      TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE INDEX IF NOT EXISTS idx_bookings_created ON bookings(created_at DESC);

    -- rooms_v2: relational rooms table that replaces baankarn_rooms_v1 JSONB
    -- for new code paths. Previously created lazily by routes/rooms.bootstrap()
    -- — moved here so any caller that runs migrate.js (tests, manual scripts)
    -- gets the schema without needing to mount the rooms router.
    CREATE TABLE IF NOT EXISTS rooms_v2 (
      id            BIGSERIAL PRIMARY KEY,
      room_code     TEXT UNIQUE NOT NULL,
      floor         INT NOT NULL,
      room_no       INT NOT NULL,
      room_type     TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'vacant',
      rent_price    NUMERIC(10,2) NOT NULL,
      deposit_price NUMERIC(10,2) NOT NULL DEFAULT 0,
      wifi_fee      NUMERIC(10,2) DEFAULT 0,
      view_type     TEXT,
      has_balcony   BOOLEAN DEFAULT FALSE,
      has_parking   BOOLEAN DEFAULT FALSE,
      has_kitchen   BOOLEAN DEFAULT FALSE,
      has_ac        BOOLEAN DEFAULT TRUE,
      size_sqm      NUMERIC(6,2),
      bed_count     INT DEFAULT 1,
      notes         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_rooms_v2_floor ON rooms_v2(floor) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_rooms_v2_status ON rooms_v2(status) WHERE deleted_at IS NULL;

    -- payments(tenant_id) is a frequent filter (server.js: tenant payments
    -- list at GET /api/tenant/payments). Add index to keep the query off a
    -- seq scan as the table grows.
    CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);

    -- Contract-length discount. The pricing UI lets admin configure
    -- discount percentages by contract term (sixMonth/twelveMonth/
    -- twentyFourMonth) — but until now those numbers were never applied
    -- to actual bills. discount_pct is the resolved % stamped on the
    -- contract at check-in, so billing.buildBill can apply it without
    -- having to derive contract length on every bill.
    ALTER TABLE contracts ADD COLUMN IF NOT EXISTS discount_pct NUMERIC(5,2) DEFAULT 0;
    ALTER TABLE contracts ADD COLUMN IF NOT EXISTS term_months INT;

    -- Deposit refund tracking. Previously the checkout endpoint accepted a
    -- finalDepositReturn amount and only wrote it to audit_logs — making
    -- the refund record invisible to reports / hard to reconcile against
    -- contracts.deposit. Storing it on the contract row gives a single
    -- source of truth + lets reports compute "deposit retained" cleanly.
    ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit_returned NUMERIC(10,2);
    ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit_returned_at TIMESTAMPTZ;
    ALTER TABLE contracts ADD COLUMN IF NOT EXISTS deposit_return_reason TEXT;

    -- === Identity capture (citizen ID front+back, address, emergency) =====
    -- Thailand law requires landlords to keep tenant identification on file
    -- (พ.ร.บ. การเช่าอสังหาริมทรัพย์) — without these columns the existing
    -- citizen_id_encrypted holds the digits but no scanned proof. file_uploads
    -- already supports category='citizen_id_image'; the new FK columns + side
    -- metadata link the upload row to the tenant atomically.
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS address TEXT;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS emergency_contact_name TEXT;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS emergency_contact_relation TEXT;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS citizen_id_image_front_id BIGINT REFERENCES file_uploads(id) ON DELETE SET NULL;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS citizen_id_image_back_id  BIGINT REFERENCES file_uploads(id) ON DELETE SET NULL;
    -- Searchable HMAC of the full 13-digit citizen ID. The encrypted
    -- column can't be queried for dedup without decrypting every row;
    -- the HMAC lets us catch "same person registered twice" cheaply.
    -- Salt comes from CITIZEN_ID_KEY / SESSION_SECRET via services/crypto.
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS citizen_id_hash TEXT;
    -- Partial unique: when present, the HMAC must be unique. Soft-delete
    -- (deleted_at) excluded so re-registering after move-out works. A
    -- prior tenant who moved-out keeps deleted_at NULL though, so we ALSO
    -- exclude moved_out + blacklist statuses from the uniqueness scope.
    -- Result: at most ONE active tenant per citizen ID at any time.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_citizen_id_hash_active
      ON tenants(citizen_id_hash)
      WHERE citizen_id_hash IS NOT NULL
        AND deleted_at IS NULL
        AND status = 'active';

    -- === Bookings: optional pre-screening fields ==========================
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS citizen_id_tail TEXT;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS citizen_id_image_front_id BIGINT REFERENCES file_uploads(id) ON DELETE SET NULL;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS expected_deposit NUMERIC(10,2);
    -- Legal trail: the timestamp at which the applicant clicked through the
    -- terms-and-conditions checkbox + the version of those terms (so if the
    -- terms text changes later we know which version they accepted).
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS agreed_terms_at TIMESTAMPTZ;
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS agreed_terms_version TEXT;

    -- === Contracts: signature image link + agreed terms ===================
    ALTER TABLE contracts ADD COLUMN IF NOT EXISTS signature_image_id BIGINT REFERENCES file_uploads(id) ON DELETE SET NULL;
    ALTER TABLE contracts ADD COLUMN IF NOT EXISTS agreed_terms_at TIMESTAMPTZ;
    ALTER TABLE contracts ADD COLUMN IF NOT EXISTS agreed_terms_version TEXT;

    -- === Contract templates (multi-template + CRUD) =======================
    -- The single-row system_settings['contract.terms_template'] stayed in
    -- place during the v1 rollout. Real operators want multiple templates
    -- (long-term tenant vs student vs short-stay) with different clauses,
    -- visible sections, and per-template variables. New table moves
    -- templates to first-class records; the legacy single row is
    -- migrated into a default 'auto-imported' template by the boot path
    -- below so existing deployments don't lose their custom clauses.
    CREATE TABLE IF NOT EXISTS contract_templates (
      id            BIGSERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      mode          TEXT NOT NULL DEFAULT 'append',  -- default | append | override
      clauses       JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- Section visibility / acknowledgment overrides — see contractPdf.js
      sections      JSONB NOT NULL DEFAULT '{}'::jsonb,
      -- Custom placeholders the renderer interpolates into clause bodies.
      -- Useful for fields like wifi_password, pet_policy, parking_fee.
      variables     JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_default    BOOLEAN NOT NULL DEFAULT FALSE,
      enabled       BOOLEAN NOT NULL DEFAULT TRUE,
      created_by    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at    TIMESTAMPTZ
    );
    -- At most one default template at a time (partial unique).
    CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_templates_default
      ON contract_templates(is_default) WHERE is_default = TRUE AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_contract_templates_enabled
      ON contract_templates(enabled) WHERE deleted_at IS NULL;

    -- Per-contract template choice. NULL means "use whatever is default".
    -- ON DELETE SET NULL keeps the contract row even if the template is
    -- removed — the rendered PDF will fall back to defaults at print time.
    ALTER TABLE contracts ADD COLUMN IF NOT EXISTS template_id BIGINT REFERENCES contract_templates(id) ON DELETE SET NULL;

    -- Contract immutability flag. Set when admin approves the tenant's
    -- self-fill submission OR explicitly locks via the contract editor.
    -- Once locked, /api/contracts/:id PUT refuses edits and the public
    -- fill token is invalidated. Stored as a timestamp (NULL = unlocked,
    -- non-NULL = locked at this time).
    ALTER TABLE contracts ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
    ALTER TABLE contracts ADD COLUMN IF NOT EXISTS locked_by TEXT;

    -- === Tenant self-fill invitations =====================================
    -- Admin generates a tokenised URL → tenant opens (no login) → fills
    -- personal info + ID photos + signature → submits → admin reviews →
    -- approves (which applies draft to tenants/contracts + locks) OR
    -- rejects (kicks back to tenant with reason).
    --
    -- The token in the URL is base64url(32 random bytes); we store ONLY
    -- the SHA-256 hash so a DB-only leak doesn't yield directly-replayable
    -- live tokens. Token is one-time-ish: usable until status leaves
    -- pending/submitted (then it's effectively dead).
    CREATE TABLE IF NOT EXISTS contract_invitations (
      id              BIGSERIAL PRIMARY KEY,
      contract_id     BIGINT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      tenant_id       BIGINT REFERENCES tenants(id) ON DELETE SET NULL,
      token_hash      TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
        -- pending | submitted | approved | rejected | revoked | expired
      draft           JSONB NOT NULL DEFAULT '{}'::jsonb,
        -- holds the tenant's in-progress fields: address, emergencyContact,
        -- citizenId (encrypted at submit time), citizenIdImageFrontId,
        -- citizenIdImageBackId, signatureFileId, agreedTermsAt
      submitted_at    TIMESTAMPTZ,
      approved_at     TIMESTAMPTZ,
      approved_by     TEXT,
      rejected_at     TIMESTAMPTZ,
      rejected_by     TEXT,
      rejection_reason TEXT,
      revoked_at      TIMESTAMPTZ,
      revoked_by      TEXT,
      expires_at      TIMESTAMPTZ NOT NULL,
      created_by      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_invitations_token_hash
      ON contract_invitations(token_hash);
    CREATE INDEX IF NOT EXISTS idx_contract_invitations_status
      ON contract_invitations(status);
    CREATE INDEX IF NOT EXISTS idx_contract_invitations_contract
      ON contract_invitations(contract_id);
    -- At most one ACTIVE invitation per contract — admin shouldn't be able
    -- to spawn a fleet of valid tokens for the same contract by accident.
    -- 'pending' + 'submitted' are the active states; once approved/rejected
    -- /revoked/expired, the invitation is closed and a new one can be
    -- issued. Partial unique enforces this without blocking history.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_invitations_active_per_contract
      ON contract_invitations(contract_id)
      WHERE status IN ('pending', 'submitted');

    -- === file_uploads: distinguish front vs back of citizen ID ============
    -- Without the side column, the admin UI has to dig into the URL or rely
    -- on upload order. Explicit column is cheap and lets queries filter cleanly.
    ALTER TABLE file_uploads ADD COLUMN IF NOT EXISTS side TEXT;  -- 'front' | 'back' | NULL
  `);

  // === Migrate legacy system_settings['contract.terms_template'] ==========
  // The v1 contract terms editor wrote to a single system_settings row.
  // v2 introduces contract_templates (proper CRUD). Auto-import the legacy
  // row as a default template so admin doesn't lose their custom clauses
  // when redeploying. Idempotent: subsequent boots skip if the auto-import
  // already happened (we mark it via a sentinel system_settings key).
  try {
    const sentinel = await pool.query(
      `SELECT 1 FROM system_settings WHERE key='contract.terms_template_migrated_v1' LIMIT 1`
    );
    if (!sentinel.rows.length) {
      const legacy = await pool.query(
        `SELECT value, updated_by FROM system_settings WHERE key='contract.terms_template' LIMIT 1`
      );
      if (legacy.rows.length && legacy.rows[0].value) {
        const v = legacy.rows[0].value;
        const mode = ['default', 'append', 'override'].includes(v.mode) ? v.mode : 'default';
        const clauses = Array.isArray(v.clauses) ? v.clauses : [];
        // Only create a default template if none exists yet (so re-runs
        // don't multiply rows).
        const exists = await pool.query(
          `SELECT id FROM contract_templates WHERE deleted_at IS NULL LIMIT 1`
        );
        if (!exists.rows.length) {
          await pool.query(
            `INSERT INTO contract_templates
                (name, description, mode, clauses, sections, variables,
                 is_default, enabled, created_by)
             VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, TRUE, TRUE, $7)`,
            [
              'นำเข้าจากเวอร์ชันก่อน',
              'auto-migrated from system_settings.contract.terms_template',
              mode,
              JSON.stringify(clauses),
              '{}', '{}',
              legacy.rows[0].updated_by || 'auto-migrate',
            ]
          );
          console.log('[db] migrated legacy contract terms template into contract_templates');
        }
      }
      // Stamp sentinel so this block doesn't fire on every boot.
      await pool.query(
        `INSERT INTO system_settings (key, value, description, updated_by, updated_at)
         VALUES ('contract.terms_template_migrated_v1', '"done"'::jsonb, 'sentinel — do not delete', 'system', NOW())
         ON CONFLICT (key) DO NOTHING`
      );
    }
  } catch (err) {
    console.warn('[db] contract template auto-migrate skipped:', err.message);
  }

  // === One-time role backfill =============================================
  // The auth_users.role column was originally `TEXT DEFAULT 'admin'`. The
  // RBAC system later switched to a 4-tier ladder (owner/manager/staff/
  // readonly) and ROLE_RANK no longer recognises the literal string 'admin'.
  // Any user with role='admin' silently ranks 0 and gets stripped of every
  // menu item that has minRole, including Settings → Users — meaning they
  // can't even fix their own role through the UI.
  //
  // Recovery is in three layers:
  //   1) Promote any 'admin' rows to 'owner'.
  //   2) Coerce any unrecognised role string to 'staff' (safer than rank 0).
  //   3) If after (1)+(2) there's still no owner at all, promote the oldest
  //      user — without an owner the system is unusable since /api/admin/users
  //      is owner-only. Idempotent on re-runs.
  try {
    const upd1 = await pool.query(
      `UPDATE auth_users SET role='owner' WHERE role='admin'`
    );
    if (upd1.rowCount > 0) {
      console.log(`[db] migrated ${upd1.rowCount} legacy 'admin' user(s) to role='owner'`);
    }
    const upd2 = await pool.query(
      `UPDATE auth_users SET role='staff'
        WHERE role NOT IN ('owner','manager','staff','readonly')`
    );
    if (upd2.rowCount > 0) {
      console.log(`[db] coerced ${upd2.rowCount} user(s) with unknown role to 'staff'`);
    }
    // Ensure at least one owner exists so the operator isn't locked out.
    // Defensive `?.n ?? 0` because some test stubs return rows: [] for COUNT
    // queries — without the guard the catch below would log a confusing
    // "Cannot read properties of undefined" warning during boot.
    const ownersQ = await pool.query(`SELECT COUNT(*)::int n FROM auth_users WHERE role='owner'`);
    const ownerCount = ownersQ.rows[0]?.n ?? 0;
    if (ownerCount === 0) {
      const promoted = await pool.query(
        `UPDATE auth_users SET role='owner'
           WHERE id = (SELECT id FROM auth_users ORDER BY id ASC LIMIT 1)
         RETURNING id, username`
      );
      if (promoted.rows[0]) {
        console.log(
          `[db] no 'owner' found — promoted oldest user '${promoted.rows[0].username}' (id=${promoted.rows[0].id}) to owner`
        );
      }
    }
    // Drop the bad default so future inserts that forget to specify a role
    // don't repeat the bug.
    await pool.query(`ALTER TABLE auth_users ALTER COLUMN role SET DEFAULT 'staff'`);
  } catch (err) {
    console.warn('[db] role backfill skipped:', err.message);
  }

  // === Bootstrap admin =====================================================
  // Only auto-bootstraps when ADMIN_PASSWORD is provided. A previous version
  // fell back to "admin1234" — production deploys that forgot to set the
  // env got a known-weak default. We now refuse to bootstrap silently and
  // surface a clear log line instead.
  const { rows } = await pool.query(
    'SELECT id FROM auth_users WHERE username=$1', [ADMIN_USERNAME]
  );
  if (rows.length === 0) {
    if (!ADMIN_PASSWORD) {
      console.warn(
        `[db] no '${ADMIN_USERNAME}' user found and ADMIN_PASSWORD is not set — skipping bootstrap. ` +
        `Set ADMIN_PASSWORD then redeploy, or create the user manually.`
      );
    } else if (ADMIN_PASSWORD.length < 12 && (process.env.NODE_ENV || 'production') === 'production') {
      // Don't throw — that crash-loops the container when ops just want to
      // start the server with a placeholder password. Skip the bootstrap
      // and tell the operator how to recover.
      console.warn(
        `[db] ADMIN_PASSWORD is shorter than 12 chars in production. ` +
        `Refusing to seed a weak admin row — set a strong password and redeploy, ` +
        `or POST /api/admin/users from an existing session to add the first user.`
      );
    } else if (ADMIN_PASSWORD === 'admin1234') {
      console.warn(
        `[db] ADMIN_PASSWORD is the example value 'admin1234' — bootstrap skipped.`
      );
    } else {
      const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
      await pool.query(
        'INSERT INTO auth_users (username, password_hash, role) VALUES ($1,$2,$3)',
        [ADMIN_USERNAME, hash, 'owner']  // first user gets the highest role
      );
      console.log(`[db] bootstrapped admin user '${ADMIN_USERNAME}' (role=owner)`);
    }
  }

  console.log('[db] schema ready');
}

module.exports = { migrate };
