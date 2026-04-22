#!/usr/bin/env bash
# =============================================================================
#  CIO Dashboard — Production Deploy Script
#  All credentials pre-configured. Just run: sudo bash deploy.sh
#  Safe to re-run for updates — fully idempotent.
# =============================================================================
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n▶ $*${RESET}"; }

# =============================================================================
#  PRE-CONFIGURED VALUES — edit here if anything changes
# =============================================================================

DEPLOY_DIR="/opt/cio-dashboard"
BACKEND_REPO="https://github.com/tejas2022/internal_dashboard_backend"
FRONTEND_REPO="https://github.com/tejas2022/internal_dashboard"

# Postgres
DB_NAME="cio_dashboard"
DB_USER="cio_user"
DB_PASSWORD="CioSecure2026!"

# Frontend port on host
FRONTEND_PORT="80"

# OpManager
OPMANAGER_HOST="http://192.168.10.190:8060"
OPMANAGER_API_KEY="d5f15fb54774a7c38fdb14e2a4850e18"
OPMANAGER_WIDGETS="627:088ede14-fc54-4e5a-9ec4-280c763d13f7,629:8806ef67-3e68-44a3-8a6b-b7d6b84733df,626:200c6446-7adb-43da-ba0a-dd6e752244b2,628:4cde34dd-679f-4616-8637-9e8823cf8dd9,630:cbe9523b-18be-437c-bf59-ec9e9e4c6658"

# Wazuh
WAZUH_HOST="https://192.168.10.120:55000"
WAZUH_USER="admin"
WAZUH_PASSWORD="SecretPassword"
WAZUH_DASHBOARD_URL="https://192.168.10.120"

# SOC Email (leave blank to disable)
SOC_EMAIL_HOST=""
SOC_EMAIL_USER=""
SOC_EMAIL_PASSWORD=""
SOC_EMAIL_PORT="993"

# xlsx data files expected in DEPLOY_DIR
XLSX_FILES=(
  "BOD_Checklist_OmneSys.xlsx"
  "BOD_Checklist_PCG.xlsx"
  "BOD_Checklist_Retail.xlsx"
  "VAPT Status.xlsx"
  "Infra BOD Check List.xlsm"
)

# =============================================================================
#  HELPERS
# =============================================================================

gen_secret() {
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))" 2>/dev/null \
    || openssl rand -hex 48
}

wait_healthy() {
  local container="$1" timeout=120 elapsed=0
  info "Waiting for ${container} to become healthy…"
  until [[ "$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null)" == "healthy" ]]; do
    sleep 3; elapsed=$((elapsed + 3))
    [[ $elapsed -ge $timeout ]] && error "${container} did not become healthy after ${timeout}s.\nRun: docker logs ${container}"
    echo -n "."
  done
  echo
  success "${container} is healthy"
}

# =============================================================================
#  STEP 0 — Must be root
# =============================================================================
step "Checking permissions"
[[ $EUID -ne 0 ]] && error "Run as root: sudo bash deploy.sh"
success "Running as root"

# =============================================================================
#  STEP 1 — Prerequisites
# =============================================================================
step "Checking prerequisites"

for cmd in docker git; do
  command -v "$cmd" &>/dev/null || error "'$cmd' is not installed. Install it and re-run."
done

docker info &>/dev/null || error "Docker daemon is not running. Start it: systemctl start docker"

if docker compose version &>/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE_CMD="docker-compose"
else
  error "Docker Compose not found.\nInstall: apt install docker-compose-plugin  (Ubuntu 22+)"
fi

success "Docker OK — Compose command: ${COMPOSE_CMD}"

# node is optional (for secret gen) — openssl is the fallback
command -v node &>/dev/null && info "Node.js found — using for secret generation" \
                             || info "Node.js not found — using openssl for secret generation"

# =============================================================================
#  STEP 2 — Deploy directory
# =============================================================================
step "Preparing deploy directory: ${DEPLOY_DIR}"
mkdir -p "$DEPLOY_DIR"
cd "$DEPLOY_DIR"
success "Working in: $(pwd)"

# =============================================================================
#  STEP 3 — Clone / update repos
# =============================================================================
step "Syncing repositories"

sync_repo() {
  local dir="$1" url="$2"
  if [[ -d "$dir/.git" ]]; then
    info "Updating ${dir}…"
    git -C "$dir" fetch origin
    git -C "$dir" reset --hard origin/main
    success "${dir} updated to $(git -C "$dir" rev-parse --short HEAD)"
  else
    info "Cloning ${url} → ${dir}…"
    git clone "$url" "$dir"
    success "${dir} cloned ($(git -C "$dir" rev-parse --short HEAD))"
  fi
}

sync_repo backend  "$BACKEND_REPO"
sync_repo frontend "$FRONTEND_REPO"

# Always pull latest docker-compose from repo
cp backend/docker-compose.yml ./docker-compose.yml
success "docker-compose.yml updated from repo"

# =============================================================================
#  STEP 4 — xlsx data files
# =============================================================================
step "Checking data files"

MISSING=()
for f in "${XLSX_FILES[@]}"; do
  [[ ! -f "${DEPLOY_DIR}/${f}" ]] && MISSING+=("$f")
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  warn "The following files are missing from ${DEPLOY_DIR}:"
  for f in "${MISSING[@]}"; do echo "      ✗  $f"; done
  echo
  echo "  Transfer them from Windows:"
  echo "  scp \"<file>\" root@$(hostname -I | awk '{print $1}'):${DEPLOY_DIR}/"
  echo
  read -rp "  Continue without them? App runs but seed data will be incomplete. [y/N] " yn
  [[ "${yn,,}" == "y" ]] || error "Aborted — add the files then re-run."
else
  success "All data files present"
fi

# =============================================================================
#  STEP 5 — Root .env  (docker-compose reads this)
# =============================================================================
step "Writing root .env (Postgres + compose config)"

cat > "${DEPLOY_DIR}/.env" <<EOF
# Generated by deploy.sh on $(date -u +"%Y-%m-%d %H:%M UTC")
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
FRONTEND_PORT=${FRONTEND_PORT}
EOF
chmod 600 "${DEPLOY_DIR}/.env"
success "Root .env written"

# =============================================================================
#  STEP 6 — Backend .env  (runtime config)
# =============================================================================
step "Writing backend .env (secrets + integrations)"

# Preserve existing JWT secrets across re-deploys so sessions aren't invalidated
if [[ -f "${DEPLOY_DIR}/backend/.env" ]]; then
  EXISTING_JWT=$(grep "^JWT_SECRET=" "${DEPLOY_DIR}/backend/.env" | cut -d= -f2-)
  EXISTING_JWT_REFRESH=$(grep "^JWT_REFRESH_SECRET=" "${DEPLOY_DIR}/backend/.env" | cut -d= -f2-)
fi
JWT_SECRET="${EXISTING_JWT:-$(gen_secret)}"
JWT_REFRESH_SECRET="${EXISTING_JWT_REFRESH:-$(gen_secret)}"

SERVER_IP=$(hostname -I | awk '{print $1}')

cat > "${DEPLOY_DIR}/backend/.env" <<EOF
# Generated by deploy.sh on $(date -u +"%Y-%m-%d %H:%M UTC")

# ── Database ──────────────────────────────────────────────────────────────────
DB_HOST=postgres
DB_PORT=5432
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}

# ── JWT ───────────────────────────────────────────────────────────────────────
JWT_SECRET=${JWT_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}

# ── Server ────────────────────────────────────────────────────────────────────
PORT=3001
NODE_ENV=production
FRONTEND_URL=http://${SERVER_IP}

# ── OpManager ─────────────────────────────────────────────────────────────────
OPMANAGER_HOST=${OPMANAGER_HOST}
OPMANAGER_API_KEY=${OPMANAGER_API_KEY}
OPMANAGER_WIDGETS=${OPMANAGER_WIDGETS}

# ── Wazuh ─────────────────────────────────────────────────────────────────────
WAZUH_HOST=${WAZUH_HOST}
WAZUH_USER=${WAZUH_USER}
WAZUH_PASSWORD=${WAZUH_PASSWORD}
WAZUH_DASHBOARD_URL=${WAZUH_DASHBOARD_URL}

# ── SOC Email ─────────────────────────────────────────────────────────────────
SOC_EMAIL_HOST=${SOC_EMAIL_HOST}
SOC_EMAIL_USER=${SOC_EMAIL_USER}
SOC_EMAIL_PASSWORD=${SOC_EMAIL_PASSWORD}
SOC_EMAIL_PORT=${SOC_EMAIL_PORT}
EOF
chmod 600 "${DEPLOY_DIR}/backend/.env"
success "backend/.env written"

# =============================================================================
#  STEP 7 — Build images
# =============================================================================
step "Building Docker images (this takes a few minutes on first run)"
$COMPOSE_CMD -f "${DEPLOY_DIR}/docker-compose.yml" build --pull
success "Images built"

# =============================================================================
#  STEP 8 — Start containers
# =============================================================================
step "Starting containers"
$COMPOSE_CMD -f "${DEPLOY_DIR}/docker-compose.yml" up -d
success "Containers started"

# =============================================================================
#  STEP 9 — Health checks
# =============================================================================
step "Waiting for all services to become healthy"

wait_healthy cio_postgres
wait_healthy cio_backend

# Frontend has no healthcheck — just verify it's running
sleep 3
if docker ps --filter "name=cio_frontend" --filter "status=running" | grep -q cio_frontend; then
  success "cio_frontend is running"
else
  error "cio_frontend failed to start.\nRun: docker logs cio_frontend"
fi

# =============================================================================
#  STEP 10 — Smoke test
# =============================================================================
step "Running smoke test"
sleep 2
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost/api/v1/health" 2>/dev/null || echo "000")
if [[ "$HTTP_STATUS" == "200" ]]; then
  success "API health check passed (HTTP 200)"
else
  warn "API returned HTTP ${HTTP_STATUS} — app may still be initialising, check: docker logs cio_backend"
fi

# =============================================================================
#  Done
# =============================================================================
echo
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  Deployment complete!${RESET}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  App URL    :  ${CYAN}http://${SERVER_IP}${RESET}"
echo -e "  Live logs  :  ${CYAN}docker compose -f ${DEPLOY_DIR}/docker-compose.yml logs -f${RESET}"
echo -e "  Stop all   :  ${CYAN}docker compose -f ${DEPLOY_DIR}/docker-compose.yml down${RESET}"
echo -e "  Update app :  ${CYAN}sudo bash ${DEPLOY_DIR}/backend/deploy.sh${RESET}"
echo
