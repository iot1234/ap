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
check "GET /api/promptpay/qr"       400 "$BASE_URL/api/promptpay/qr"   # no target
check "GET /api/promptpay/qr?target=0812345678&amount=100"  200 "$BASE_URL/api/promptpay/qr?target=0812345678&amount=100"

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
check "GET /api/data/baankarn_users_v1 (no auth) blocked"  401 "$BASE_URL/api/data/baankarn_users_v1"
check "GET /api/data/baankarn_bookings_v1 (no auth) blocked" 401 "$BASE_URL/api/data/baankarn_bookings_v1"
check "GET /api/data/baankarn_rooms_v1 (no auth) masked"   200 "$BASE_URL/api/data/baankarn_rooms_v1"

echo ""
echo "Validation (Zod):"
check "POST /api/auth/login (empty)"   400 -X POST -H "Content-Type: application/json" \
  -d '{}' -H "Origin: $BASE_URL" "$BASE_URL/api/auth/login"
check "POST /api/bookings/public (no name)" 400 -X POST -H "Content-Type: application/json" \
  -d '{"phone":"0812345678"}' -H "Origin: $BASE_URL" "$BASE_URL/api/bookings/public"
check "GET /api/promptpay/qr (bad shape)" 400 "$BASE_URL/api/promptpay/qr?target=1234567890"

echo ""
echo "v2.1 routes/ modules:"
check "GET /api/csrf-token"              200 "$BASE_URL/api/csrf-token"
check "GET /api/rooms"                   200 -b "$COOKIE_JAR" "$BASE_URL/api/rooms"
check "GET /api/settings"                200 -b "$COOKIE_JAR" "$BASE_URL/api/settings"
check "GET /api/reports2/revenue"        200 -b "$COOKIE_JAR" "$BASE_URL/api/reports2/revenue?year=2026"
check "GET /api/reports2/occupancy"      200 -b "$COOKIE_JAR" "$BASE_URL/api/reports2/occupancy?year=2026"
check "GET /api/reports2/overdue"        200 -b "$COOKIE_JAR" "$BASE_URL/api/reports2/overdue"
check "GET /api/reports2/maintenance/stats" 200 -b "$COOKIE_JAR" "$BASE_URL/api/reports2/maintenance/stats"
check "GET /api/reports2/cashflow"       200 -b "$COOKIE_JAR" "$BASE_URL/api/reports2/cashflow"
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
echo "==========================================="
echo "Summary: $PASS passed, $FAIL failed"
echo "==========================================="
[[ "$FAIL" == 0 ]] && exit 0 || exit 1
