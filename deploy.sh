#!/usr/bin/env bash
# =============================================================================
#  CIO Dashboard — Production Deploy Script
#  Run from any directory: bash /path/to/deploy.sh
#  Safe to re-run for updates — idempotent.
# =============================================================================
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; exit 1; }
step()    { echo -e "\n${BOLD}${CYAN}▶ $*${RESET}"; }

# ── Config ────────────────────────────────────────────────────────────────────
DEPLOY_DIR="/opt/cio-dashboard"
BACKEND_REPO="https://github.com/tejas2022/internal_dashboard_backend"
FRONTEND_REPO="https://github.com/tejas2022/internal_dashboard"

XLSX_FILES=(
  "BOD_Checklist_OmneSys.xlsx"
  "BOD_Checklist_PCG.xlsx"
  "BOD_Checklist_Retail.xlsx"
  "VAPT Status.xlsx"
  "Infra BOD Check List.xlsm"
)

# ── Helpers ───────────────────────────────────────────────────────────────────
gen_secret() { node -e "console.log(require('crypto').randomBytes(48).toString('hex'))" 2>/dev/null \
               || openssl rand -hex 48; }

prompt_password() {
  local prompt="$1" var
  while true; do
    read -rsp "${prompt}: " var; echo
    [[ ${#var} -ge 12 ]] && { echo "$var"; return; }
    warn "Password must be at least 12 characters — try again."
  done
}

wait_healthy() {
  local container="$1" timeout=120 elapsed=0
  info "Waiting for ${container} to become healthy…"
  until [[ "$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null)" == "healthy" ]]; do
    sleep 3; elapsed=$((elapsed+3))
    [[ $elapsed -ge $timeout ]] && error "${container} did not become healthy within ${timeout}s. Run: docker logs ${container}"
    echo -n "."
  done
  echo; success "${container} is healthy"
}

is_fresh_install() { [[ ! -d "$DEPLOY_DIR/backend" ]]; }

# =============================================================================
#  STEP 0 — Root check
# =============================================================================
step "Checking permissions"
[[ $EUID -ne 0 ]] && error "Please run as root: sudo bash deploy.sh"
success "Running as root"

# =============================================================================
#  STEP 1 — Prerequisites
# =============================================================================
step "Checking prerequisites"

check_cmd() {
  command -v "$1" &>/dev/null || error "'$1' is not installed. Install it and re-run."
}

check_cmd docker
check_cmd git
check_cmd node   # needed only for secret generation — falls back to openssl

# Docker daemon running?
docker info &>/dev/null || error "Docker daemon is not running. Start it with: systemctl start docker"

# Docker Compose v2?
if docker compose version &>/dev/null; then
  COMPOSE_CMD="docker compose"
elif docker-compose version &>/dev/null; then
  COMPOSE_CMD="docker-compose"
else
  error "Docker Compose not found. Install it: https://docs.docker.com/compose/install/"
fi

success "All prerequisites met (Docker: $(docker --version | awk '{print $3}' | tr -d ','))"

# =============================================================================
#  STEP 2 — Create deploy directory
# =============================================================================
step "Setting up deploy directory: ${DEPLOY_DIR}"
mkdir -p "$DEPLOY_DIR"
cd "$DEPLOY_DIR"
success "Working directory: $(pwd)"

# =============================================================================
#  STEP 3 — Clone or update repos
# =============================================================================
step "Syncing repositories"

sync_repo() {
  local dir="$1" url="$2"
  if [[ -d "$dir/.git" ]]; then
    info "Updating ${dir}…"
    git -C "$dir" pull --ff-only || {
      warn "Fast-forward pull failed. Fetching and resetting to origin/main…"
      git -C "$dir" fetch origin
      git -C "$dir" reset --hard origin/main
    }
  else
    info "Cloning ${url} → ${dir}…"
    git clone "$url" "$dir"
  fi
}

sync_repo backend  "$BACKEND_REPO"
sync_repo frontend "$FRONTEND_REPO"

# Always keep docker-compose.yml up to date from the repo
cp backend/docker-compose.yml ./docker-compose.yml
success "Repositories up to date"

# =============================================================================
#  STEP 4 — Check xlsx data files
# =============================================================================
step "Checking data files"
MISSING_XLSX=()
for f in "${XLSX_FILES[@]}"; do
  if [[ ! -f "$DEPLOY_DIR/$f" ]]; then
    MISSING_XLSX+=("$f")
  fi
done

if [[ ${#MISSING_XLSX[@]} -gt 0 ]]; then
  warn "The following data files are missing from ${DEPLOY_DIR}:"
  for f in "${MISSING_XLSX[@]}"; do echo "    ✗  $f"; done
  echo
  echo -e "  Transfer them from your Windows machine with:"
  echo -e "  ${CYAN}scp \"file.xlsx\" root@$(hostname -I | awk '{print $1}'):${DEPLOY_DIR}/${RESET}"
  echo
  read -rp "Continue without them? The app will still run but seed data may be incomplete. [y/N] " confirm
  [[ "${confirm,,}" == "y" ]] || error "Aborted. Add the files and re-run."
else
  success "All data files present"
fi

# =============================================================================
#  STEP 5 — Root .env (docker-compose reads this)
# =============================================================================
step "Configuring root .env (Postgres credentials)"

if [[ -f ".env" ]]; then
  info "Root .env already exists — skipping (delete it to reconfigure)"
else
  echo
  echo -e "  ${BOLD}Set a strong Postgres password.${RESET} It will be stored in .env"
  DB_PASSWORD=$(prompt_password "  Postgres password")

  cat > .env <<EOF
# Auto-generated by deploy.sh on $(date -u +"%Y-%m-%d %H:%M UTC")
DB_NAME=cio_dashboard
DB_USER=cio_user
DB_PASSWORD=${DB_PASSWORD}
FRONTEND_PORT=80
EOF
  chmod 600 .env
  success "Root .env created"
fi

# Source root .env so we can reference DB_PASSWORD below
set -o allexport; source .env; set +o allexport

# =============================================================================
#  STEP 6 — Backend .env (runtime secrets + integrations)
# =============================================================================
step "Configuring backend .env"

if [[ -f "backend/.env" ]]; then
  info "backend/.env already exists — skipping (delete it to reconfigure)"
else
  # Detect server IP for FRONTEND_URL
  SERVER_IP=$(hostname -I | awk '{print $1}')

  info "Generating JWT secrets…"
  JWT_SECRET=$(gen_secret)
  JWT_REFRESH_SECRET=$(gen_secret)

  cat > backend/.env <<EOF
# Auto-generated by deploy.sh on $(date -u +"%Y-%m-%d %H:%M UTC")

# ── Database (injected from docker-compose) ───────────────────────────────────
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

# ── OpManager (leave blank to use mock data) ──────────────────────────────────
OPMANAGER_HOST=
OPMANAGER_API_KEY=
OPMANAGER_WIDGETS=

# ── Wazuh (leave blank to use mock data) ──────────────────────────────────────
WAZUH_HOST=
WAZUH_USER=
WAZUH_PASSWORD=
WAZUH_DASHBOARD_URL=

# ── SOC Email (leave blank to disable) ────────────────────────────────────────
SOC_EMAIL_HOST=
SOC_EMAIL_USER=
SOC_EMAIL_PASSWORD=
SOC_EMAIL_PORT=993
EOF
  chmod 600 backend/.env
  success "backend/.env created (JWT secrets auto-generated)"
fi

# =============================================================================
#  STEP 7 — Build and start containers
# =============================================================================
step "Building Docker images"
$COMPOSE_CMD build --pull 2>&1 | grep -E "^(Step|#[0-9]| ---| =>|ERROR|error)" || true
success "Images built"

step "Starting containers"
$COMPOSE_CMD up -d
success "Containers started"

# =============================================================================
#  STEP 8 — Health checks
# =============================================================================
step "Waiting for services to become healthy"
wait_healthy cio_postgres
wait_healthy cio_backend
# Frontend has no healthcheck — just verify it's running
sleep 3
if docker ps --filter "name=cio_frontend" --filter "status=running" | grep -q cio_frontend; then
  success "cio_frontend is running"
else
  error "cio_frontend failed to start. Run: docker logs cio_frontend"
fi

# =============================================================================
#  STEP 9 — Smoke test
# =============================================================================
step "Running smoke test"
sleep 2
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost/api/v1/health 2>/dev/null || echo "000")
if [[ "$HTTP_STATUS" == "200" ]]; then
  success "API health check passed (HTTP 200)"
else
  warn "API returned HTTP ${HTTP_STATUS} — check logs if the app doesn't load"
fi

# =============================================================================
#  Done
# =============================================================================
SERVER_IP=$(hostname -I | awk '{print $1}')
echo
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  Deployment complete!${RESET}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  App URL   :  ${CYAN}http://${SERVER_IP}${RESET}"
echo -e "  Logs      :  ${CYAN}docker compose -f ${DEPLOY_DIR}/docker-compose.yml logs -f${RESET}"
echo -e "  Restart   :  ${CYAN}docker compose -f ${DEPLOY_DIR}/docker-compose.yml restart${RESET}"
echo -e "  Update    :  ${CYAN}sudo bash ${DEPLOY_DIR}/backend/deploy.sh${RESET}"
echo
echo -e "  ${YELLOW}To configure integrations (OpManager, Wazuh, SOC email):${RESET}"
echo -e "  ${CYAN}nano ${DEPLOY_DIR}/backend/.env${RESET}  then  ${CYAN}docker compose restart cio_backend${RESET}"
echo
