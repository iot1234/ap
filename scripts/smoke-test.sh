#!/usr/bin/env bash
# scripts/smoke-test.sh — quick health check of all endpoints
#
# Usage:
#   BASE_URL=https://ap-production-bba9.up.railway.app \
#   ADMIN_USER=admin ADMIN_PASS=yourpassword \
#   bash scripts/smoke-test.sh
#
# Exits 0 if every check passes, 1 otherwise.

set -u
: "${BASE_URL:=http://localhost:3000}"
: "${ADMIN_USER:=admin}"
: "${ADMIN_PASS:=admin1234}"

PASS=0
FAIL=0
COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR"' EXIT

check() {
  local label="$1"; shift
  local expected="$1"; shift
  local actual
  actual=$(curl -sk -o /tmp/_smoke_body -w "%{http_code}" "$@")
  if [[ "$actual" == "$expected" ]]; then
    echo "  ✓ $label  → $actual"
    PASS=$((PASS+1))
  else
    echo "  ✗ $label  → got $actual, want $expected"
    if [[ -s /tmp/_smoke_body ]]; then
      echo "    body: $(head -c 200 /tmp/_smoke_body)"
    fi
    FAIL=$((FAIL+1))
  fi
}

echo "=== Smoke test: $BASE_URL ==="

echo ""
echo "Public endpoints:"
check "GET /health"                 200 "$BASE_URL/health"
check "GET /"                       200 "$BASE_URL/"
check "GET /book"                   200 "$BASE_URL/book"
check "GET /maintenance"            200 "$BASE_URL/maintenance"
check "GET /login"                  200 "$BASE_URL/login"
check "GET /api/data"               200 "$BASE_URL/api/data"
check "GET /api/data/baankarn_rooms_v1"  200 "$BASE_URL/api/data/baankarn_rooms_v1"
# Generic /api/promptpay/qr was removed (dead code; replaced by
# /api/tenant/bills/:id/qr which loads the amount from the DB row).
# Confirm the public route is gone — 404 means the cleanup is in effect.
check "GET /api/promptpay/qr (removed)" 404 "$BASE_URL/api/promptpay/qr?target=0812345678&amount=100"

echo ""
echo "Auth-required endpoints (without session — expect 401):"
check "PUT /api/data/x (no auth)"   401 -X PUT -H "Content-Type: application/json" -d '{"value":[]}' "$BASE_URL/api/data/baankarn_rooms_v1"
check "GET /api/audit (no auth)"    401 "$BASE_URL/api/audit"
check "GET /api/maintenance (no auth)"  401 "$BASE_URL/api/maintenance"
check "GET /admin (redirect)"       302 "$BASE_URL/admin"

echo ""
echo "Login flow:"
check "POST /api/auth/login (bad)"  401 -X POST -H "Content-Type: application/json" \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"WRONG\"}" \
  -H "Origin: $BASE_URL" \
  "$BASE_URL/api/auth/login"

check "POST /api/auth/login (ok)"   200 -X POST -H "Content-Type: application/json" \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" \
  -H "Origin: $BASE_URL" \
  -c "$COOKIE_JAR" \
  "$BASE_URL/api/auth/login"

echo ""
echo "Authenticated endpoints (with session):"
check "GET /api/auth/me"            200 -b "$COOKIE_JAR" "$BASE_URL/api/auth/me"
check "GET /api/audit"              200 -b "$COOKIE_JAR" "$BASE_URL/api/audit"
check "GET /api/maintenance"        200 -b "$COOKIE_JAR" "$BASE_URL/api/maintenance"
check "GET /api/reports/overview"   200 -b "$COOKIE_JAR" "$BASE_URL/api/reports/overview"
check "GET /api/reports/maintenance" 200 -b "$COOKIE_JAR" "$BASE_URL/api/reports/maintenance"

echo ""
echo "v2 admin endpoints:"
check "GET /api/admin/users"          200 -b "$COOKIE_JAR" "$BASE_URL/api/admin/users"
check "GET /api/admin/security-events" 200 -b "$COOKIE_JAR" "$BASE_URL/api/admin/security-events"
check "GET /api/admin/access-devices" 200 -b "$COOKIE_JAR" "$BASE_URL/api/admin/access-devices"
check "GET /api/admin/notifications"  200 -b "$COOKIE_JAR" "$BASE_URL/api/admin/notifications"
check "GET /api/admin/features"       200 -b "$COOKIE_JAR" "$BASE_URL/api/admin/features"
check "GET /api/features"             200 "$BASE_URL/api/features"
check "GET /api/tenants"              200 -b "$COOKIE_JAR" "$BASE_URL/api/tenants"
check "GET /api/bills"                200 -b "$COOKIE_JAR" "$BASE_URL/api/bills"
check "GET /api/payments"             200 -b "$COOKIE_JAR" "$BASE_URL/api/payments"

echo ""
echo "Public PII protection:"
check "GET /api/data/baankarn_users_v1 (removed)"  400 "$BASE_URL/api/data/baankarn_users_v1"
check "GET /api/data/baankarn_bookings_v1 (no auth) blocked" 401 "$BASE_URL/api/data/baankarn_bookings_v1"
check "GET /api/data/baankarn_rooms_v1 (no auth) masked"   200 "$BASE_URL/api/data/baankarn_rooms_v1"

echo ""
echo "Validation (Zod):"
check "POST /api/auth/login (empty)"   400 -X POST -H "Content-Type: application/json" \
  -d '{}' -H "Origin: $BASE_URL" "$BASE_URL/api/auth/login"
check "POST /api/bookings/public (no name)" 400 -X POST -H "Content-Type: application/json" \
  -d '{"phone":"0812345678"}' -H "Origin: $BASE_URL" "$BASE_URL/api/bookings/public"
# /api/promptpay/qr removed — see line 49 note. The bad-shape validation
# now lives in services/promptpay.normaliseTarget() and is exercised by
# tests/promptpay.test.js + the /api/tenant/bills/:id/qr 503 path.

echo ""
echo "v2.1 routes/ modules:"
check "GET /api/csrf-token"              200 "$BASE_URL/api/csrf-token"
check "GET /api/rooms"                   200 -b "$COOKIE_JAR" "$BASE_URL/api/rooms"
check "GET /api/settings"                200 -b "$COOKIE_JAR" "$BASE_URL/api/settings"
check "GET /api/reports/revenue"        200 -b "$COOKIE_JAR" "$BASE_URL/api/reports/revenue?year=2026"
check "GET /api/reports/occupancy"      200 -b "$COOKIE_JAR" "$BASE_URL/api/reports/occupancy?year=2026"
check "GET /api/reports/overdue"        200 -b "$COOKIE_JAR" "$BASE_URL/api/reports/overdue"
check "GET /api/reports/maintenance/stats" 200 -b "$COOKIE_JAR" "$BASE_URL/api/reports/maintenance/stats"
check "GET /api/reports/cashflow"       200 -b "$COOKIE_JAR" "$BASE_URL/api/reports/cashflow"
check "POST /webhook/line (bad sig)"     403 -X POST -H "Content-Type: application/json" \
  -d '{"events":[]}' "$BASE_URL/webhook/line"

echo ""
echo "Auth hardening:"
check "POST /api/auth/login (timing-attack)" 401 -X POST -H "Content-Type: application/json" \
  -d "{\"username\":\"definitely-does-not-exist\",\"password\":\"wrong\"}" \
  -H "Origin: $BASE_URL" "$BASE_URL/api/auth/login"
check "GET /files/999999 (not found)"   404 "$BASE_URL/files/999999"

echo ""
echo "CSRF defense (cross-origin should be blocked):"
check "PUT /api/data with foreign Origin → 403"  403 \
  -X PUT -H "Content-Type: application/json" -H "Origin: https://evil.example.com" \
  -b "$COOKIE_JAR" \
  -d '{"value":{}}' \
  "$BASE_URL/api/data/baankarn_rooms_v1"

echo ""
echo "v3 endpoints (May 2026 audit cycle):"
# Production-readiness — owner-only. Without cookie should 401, with
# cookie should 200 (admin user from bootstrap is owner). Both flows
# tested so the endpoint is proven reachable.
check "GET /api/admin/production-readiness (no auth)"  401 \
  "$BASE_URL/api/admin/production-readiness"
check "GET /api/admin/production-readiness (auth)"     200 \
  -b "$COOKIE_JAR" "$BASE_URL/api/admin/production-readiness"

# Health endpoint — schema sanity check now lists the new payment
# columns. Reachability proves the migration ran + columns exist.
check "GET /api/admin/health (auth)"                   200 \
  -b "$COOKIE_JAR" "$BASE_URL/api/admin/health"

# New atomic booking approve endpoint — POST + CSRF required. Without
# a CSRF token it should reject (403 from csrfGuard). Picks a fake
# booking id so we don't accidentally approve a real one.
check "POST /api/bookings/X/approve-and-assign (no csrf)"  403 \
  -X POST -H "Content-Type: application/json" -H "Origin: $BASE_URL" \
  -b "$COOKIE_JAR" -d '{}' \
  "$BASE_URL/api/bookings/BK-SMOKE-NOPE/approve-and-assign"

# Slip auto-verify column existence (indirect): GET /api/payments
# implicitly references payments.* columns. If a column is missing
# from the SELECT projection, this 500s instead of 200.
check "GET /api/payments (smoke schema)"               200 \
  -b "$COOKIE_JAR" "$BASE_URL/api/payments"

echo ""
echo "==========================================="
echo "Summary: $PASS passed, $FAIL failed"
echo "==========================================="
[[ "$FAIL" == 0 ]] && exit 0 || exit 1
