#!/usr/bin/env bash
# =============================================================================
#  install-ess.sh — Element Server Suite Community в одну команду
#  (k3s + Helm + cert-manager + чарт matrix-stack + первый пользователь)
#
#  Повторяет шаги официального README element-hq/ess-helm (ветка main,
#  состояние на 08.10.2026): https://github.com/element-hq/ess-helm
#
#  Запуск (на чистом Ubuntu 22.04/24.04 или Debian 12, от root или через sudo):
#
#    curl -fsSL https://taksa1973.github.io/results/ess/install-ess.sh -o install-ess.sh
#    sudo ESS_DOMAIN=example.com ESS_LE_EMAIL=admin@example.com ESS_ADMIN_USER=admin bash install-ess.sh
#
#  Без переменных скрипт задаст вопросы сам (домен, e-mail, имя пользователя).
#
#  Переменные окружения (все необязательные, кроме ESS_DOMAIN):
#    ESS_DOMAIN           имя сервера Matrix, напр. example.com  (@user:example.com)
#    ESS_HOST_SYNAPSE     адрес Synapse,     по умолчанию matrix.$ESS_DOMAIN
#    ESS_HOST_AUTH        адрес входа (MAS), по умолчанию account.$ESS_DOMAIN
#    ESS_HOST_RTC         адрес звонков,     по умолчанию mrtc.$ESS_DOMAIN
#    ESS_HOST_CHAT        адрес Element Web, по умолчанию chat.$ESS_DOMAIN
#    ESS_HOST_ADMIN       адрес Element Admin, по умолчанию admin.$ESS_DOMAIN
#    ESS_TLS              letsencrypt (по умолчанию) | none (только HTTP, за своим reverse proxy)
#    ESS_LE_EMAIL         e-mail для Let's Encrypt (уведомления об истечении)
#    ESS_ADMIN_USER       имя первого пользователя (по умолчанию admin)
#    ESS_ADMIN_PASSWORD   пароль; пусто = сгенерировать и показать в конце
#    ESS_ADMIN_EMAIL      e-mail первого пользователя (необязательно)
#    ESS_CHART_VERSION    версия чарта; пусто = последняя
#    CERT_MANAGER_VERSION версия cert-manager (по умолчанию v1.17.0, как в README)
#    ESS_SKIP_DNS_CHECK=1 не проверять, что DNS-записи смотрят на этот сервер
#    ESS_NONINTERACTIVE=1 не задавать вопросов, падать при нехватке данных
#    ESS_FORCE=1          продолжать, даже если порты 80/443 заняты
#
#  Повторный запуск безопасен: уже установленное пропускается, чарт обновляется.
#  Удаление: см. функцию print_uninstall в конце вывода.
# =============================================================================
set -Eeuo pipefail

SCRIPT_VERSION="2026-10-08"
ESS_CHART="oci://ghcr.io/element-hq/ess-helm/matrix-stack"
FRAGMENTS_BASE="https://raw.githubusercontent.com/element-hq/ess-helm/main/charts/matrix-stack/ci/fragments"

ESS_DOMAIN="${ESS_DOMAIN:-}"
ESS_HOST_SYNAPSE="${ESS_HOST_SYNAPSE:-}"
ESS_HOST_AUTH="${ESS_HOST_AUTH:-}"
ESS_HOST_RTC="${ESS_HOST_RTC:-}"
ESS_HOST_CHAT="${ESS_HOST_CHAT:-}"
ESS_HOST_ADMIN="${ESS_HOST_ADMIN:-}"
ESS_TLS="${ESS_TLS:-letsencrypt}"
ESS_LE_EMAIL="${ESS_LE_EMAIL:-}"
ESS_ADMIN_USER="${ESS_ADMIN_USER:-}"
ESS_ADMIN_PASSWORD="${ESS_ADMIN_PASSWORD:-}"
ESS_ADMIN_EMAIL="${ESS_ADMIN_EMAIL:-}"
ESS_CHART_VERSION="${ESS_CHART_VERSION:-}"
CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.17.0}"
ESS_SKIP_DNS_CHECK="${ESS_SKIP_DNS_CHECK:-0}"
ESS_NONINTERACTIVE="${ESS_NONINTERACTIVE:-0}"
ESS_FORCE="${ESS_FORCE:-0}"
ESS_NAMESPACE="${ESS_NAMESPACE:-ess}"
ESS_CONFIG_DIR="${ESS_CONFIG_DIR:-$HOME/ess-config-values}"
LOG_FILE="${LOG_FILE:-/var/log/ess-install.log}"

# ---------- вывод ----------
if [[ -t 1 ]]; then
  C_B=$'\e[1m'; C_G=$'\e[32m'; C_Y=$'\e[33m'; C_R=$'\e[31m'; C_0=$'\e[0m'
else
  C_B=""; C_G=""; C_Y=""; C_R=""; C_0=""
fi
step() { printf '\n%s==> %s%s\n' "$C_B" "$*" "$C_0"; }
ok()   { printf '%s  ✔ %s%s\n' "$C_G" "$*" "$C_0"; }
warn() { printf '%s  ! %s%s\n' "$C_Y" "$*" "$C_0" >&2; }
die()  { printf '%s  ✖ %s%s\n' "$C_R" "$*" "$C_0" >&2; exit 1; }
trap 'die "Ошибка на строке $LINENO (команда: $BASH_COMMAND). Лог: $LOG_FILE"' ERR

# ---------- вопросы (читаем с терминала даже при curl | bash) ----------
ask() { # ask VAR "подсказка" "значение по умолчанию"
  local var="$1" prompt="$2" def="${3:-}" val=""
  if [[ -n "${!var:-}" ]]; then return 0; fi
  if [[ "$ESS_NONINTERACTIVE" == "1" || ! -r /dev/tty ]]; then
    if [[ -n "$def" ]]; then printf -v "$var" '%s' "$def"; return 0; fi
    die "Не задана переменная $var, а вопросы отключены (ESS_NONINTERACTIVE=1 или нет терминала)."
  fi
  if [[ -n "$def" ]]; then
    read -r -p "$prompt [$def]: " val < /dev/tty || true
    val="${val:-$def}"
  else
    while [[ -z "$val" ]]; do read -r -p "$prompt: " val < /dev/tty || true; done
  fi
  printf -v "$var" '%s' "$val"
}

# ---------- 0. предварительные проверки ----------
[[ "$(id -u)" -eq 0 ]] || die "Запускайте от root: sudo bash install-ess.sh (переменные передавайте так: sudo ESS_DOMAIN=... bash install-ess.sh)."
mkdir -p "$(dirname "$LOG_FILE")"
exec > >(tee -a "$LOG_FILE") 2>&1
printf '\n===== install-ess.sh %s, %s =====\n' "$SCRIPT_VERSION" "$(date -Is)"

[[ "$(ps -p 1 -o comm= 2>/dev/null)" == "systemd" ]] || die "k3s требует systemd (PID 1 сейчас: $(ps -p 1 -o comm=)). В контейнере или WSL без systemd установка невозможна."
command -v curl >/dev/null 2>&1 || {
  step "Ставлю curl"
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq curl ca-certificates
  elif command -v dnf >/dev/null; then dnf install -y curl ca-certificates
  else die "Нет curl и неизвестный пакетный менеджер — поставьте curl вручную."; fi
}
for tool in tar awk sed grep ss; do command -v "$tool" >/dev/null 2>&1 || die "Нет утилиты $tool."; done

step "Параметры установки"
ask ESS_DOMAIN "Имя сервера Matrix (домен, который будет в @user:домен), напр. example.com"
ESS_DOMAIN="${ESS_DOMAIN,,}"
[[ "$ESS_DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "Домен «$ESS_DOMAIN» выглядит неверно."
ESS_HOST_SYNAPSE="${ESS_HOST_SYNAPSE:-matrix.$ESS_DOMAIN}"
ESS_HOST_AUTH="${ESS_HOST_AUTH:-account.$ESS_DOMAIN}"
ESS_HOST_RTC="${ESS_HOST_RTC:-mrtc.$ESS_DOMAIN}"
ESS_HOST_CHAT="${ESS_HOST_CHAT:-chat.$ESS_DOMAIN}"
ESS_HOST_ADMIN="${ESS_HOST_ADMIN:-admin.$ESS_DOMAIN}"
case "$ESS_TLS" in letsencrypt|none) ;; *) die "ESS_TLS должен быть letsencrypt или none." ;; esac
if [[ "$ESS_TLS" == "letsencrypt" ]]; then
  ask ESS_LE_EMAIL "E-mail для Let's Encrypt (уведомления об истечении сертификата)" ""
fi
ask ESS_ADMIN_USER "Имя первого пользователя (администратора)" "admin"
[[ "$ESS_ADMIN_USER" =~ ^[a-z0-9._=/+-]+$ ]] || die "Имя пользователя: только строчные латинские буквы, цифры и . _ = - / +"
GENERATED_PASSWORD=0
if [[ -z "$ESS_ADMIN_PASSWORD" ]]; then
  ESS_ADMIN_PASSWORD="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)"
  GENERATED_PASSWORD=1
fi
ok "Сервер: $ESS_DOMAIN"
ok "Synapse: $ESS_HOST_SYNAPSE · Вход: $ESS_HOST_AUTH · Звонки: $ESS_HOST_RTC · Чат: $ESS_HOST_CHAT · Админка: $ESS_HOST_ADMIN"
ok "TLS: $ESS_TLS · Пользователь: $ESS_ADMIN_USER"

step "Проверяю сервер"
CPU_N="$(nproc)"; MEM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)"
[[ "$CPU_N" -ge 2 ]] || warn "Ядер: $CPU_N — README рекомендует минимум 2."
[[ "$MEM_MB" -ge 1900 ]] || warn "Памяти: ${MEM_MB} МБ — README рекомендует минимум 2 ГБ."
ok "CPU: $CPU_N, RAM: ${MEM_MB} МБ"
BUSY_PORTS="$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E ':(80|443)$' || true)"
if [[ -n "$BUSY_PORTS" && "$ESS_FORCE" != "1" ]]; then
  die "Порты 80/443 уже заняты ($(echo "$BUSY_PORTS" | tr '\n' ' ')). Остановите nginx/apache/caddy или используйте режим reverse proxy из инструкции. ESS_FORCE=1 — всё равно продолжить."
fi

if [[ "$ESS_SKIP_DNS_CHECK" != "1" ]]; then
  step "Проверяю DNS (все шесть имён должны указывать на этот сервер)"
  PUBLIC_IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 10 https://ifconfig.me 2>/dev/null || true)"
  if [[ -n "$PUBLIC_IP" ]]; then ok "Публичный IP сервера: $PUBLIC_IP"; else warn "Не смог определить публичный IP, сравнение пропущено."; fi
  DNS_BAD=0
  for h in "$ESS_DOMAIN" "$ESS_HOST_SYNAPSE" "$ESS_HOST_AUTH" "$ESS_HOST_RTC" "$ESS_HOST_CHAT" "$ESS_HOST_ADMIN"; do
    r="$(getent ahostsv4 "$h" 2>/dev/null | awk '{print $1; exit}' || true)"
    if [[ -z "$r" ]]; then warn "$h — не резолвится"; DNS_BAD=1
    elif [[ -n "$PUBLIC_IP" && "$r" != "$PUBLIC_IP" ]]; then warn "$h → $r (ожидался $PUBLIC_IP)"; DNS_BAD=1
    else ok "$h → $r"; fi
  done
  if [[ "$DNS_BAD" == "1" ]]; then
    if [[ "$ESS_TLS" == "letsencrypt" ]]; then
      die "DNS не готов: Let's Encrypt не выдаст сертификаты. Исправьте записи (A/CNAME на $PUBLIC_IP) и запустите снова, либо ESS_SKIP_DNS_CHECK=1, если уверены."
    else
      warn "DNS не готов, но TLS выключен — продолжаю."
    fi
  fi
fi

# ---------- 1. файрвол ----------
step "Файрвол"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw allow 30001/tcp >/dev/null; ufw allow 30002/udp >/dev/null
  ufw allow 6443/tcp >/dev/null
  ufw allow from 10.42.0.0/16 to any >/dev/null; ufw allow from 10.43.0.0/16 to any >/dev/null
  ok "ufw: открыты 80, 443, 30001/tcp, 30002/udp, 6443 и внутренние сети k3s (по рекомендациям docs.k3s.io)"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=80/tcp --add-port=443/tcp --add-port=30001/tcp --add-port=30002/udp --add-port=6443/tcp >/dev/null
  firewall-cmd --permanent --zone=trusted --add-source=10.42.0.0/16 >/dev/null
  firewall-cmd --permanent --zone=trusted --add-source=10.43.0.0/16 >/dev/null
  firewall-cmd --reload >/dev/null
  ok "firewalld: открыты 80, 443, 30001/tcp, 30002/udp, 6443 и внутренние сети k3s"
else
  ok "Локальный файрвол не активен. Не забудьте открыть 80, 443, 30001/tcp, 30002/udp в панели хостера."
fi

# ---------- 2. k3s ----------
step "k3s (Kubernetes на одной машине)"
if command -v k3s >/dev/null 2>&1 && systemctl is-active --quiet k3s; then
  ok "k3s уже установлен и запущен: $(k3s --version | head -1)"
else
  curl -sfL https://get.k3s.io | sh -
  ok "k3s установлен"
fi
# Ждём, пока k3s запишет свой kubeconfig и узел станет Ready (сразу после установки файла ещё нет)
printf '  ждём запуска k3s и готовности узла'
for _ in $(seq 1 60); do
  if [[ -s /etc/rancher/k3s/k3s.yaml ]] && k3s kubectl get nodes --no-headers 2>/dev/null | grep -q ' Ready'; then break; fi
  printf '.'; sleep 5
done; echo
k3s kubectl get nodes --no-headers 2>/dev/null | grep -q ' Ready' || die "Узел k3s не перешёл в состояние Ready за 5 минут. Смотрите: journalctl -u k3s"
ok "Узел Ready"
mkdir -p "$HOME/.kube"
# Читаем конфиг именно из файла k3s: если KUBECONFIG уже указывает на старый/пустой файл, kubectl взял бы его
k3s kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml config view --raw > "$HOME/.kube/config"
chmod 600 "$HOME/.kube/config"
export KUBECONFIG="$HOME/.kube/config"
grep -q 'KUBECONFIG=' "$HOME/.bashrc" 2>/dev/null || echo 'export KUBECONFIG=~/.kube/config' >> "$HOME/.bashrc"
if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
  SUDO_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  if [[ -d "$SUDO_HOME" ]]; then
    mkdir -p "$SUDO_HOME/.kube"; cp "$KUBECONFIG" "$SUDO_HOME/.kube/config"
    chown -R "$SUDO_USER:" "$SUDO_HOME/.kube"; chmod 600 "$SUDO_HOME/.kube/config"
    grep -q 'KUBECONFIG=' "$SUDO_HOME/.bashrc" 2>/dev/null || echo 'export KUBECONFIG=~/.kube/config' >> "$SUDO_HOME/.bashrc"
    ok "kubeconfig скопирован и пользователю $SUDO_USER"
  fi
fi
kubectl get nodes --no-headers 2>/dev/null | grep -q ' Ready' || die "kubectl не видит узел через $KUBECONFIG"

# Настройка Traefik из README (доверять заголовкам из сети подов, разрешить %2F и %23 в URL)
TRAEFIK_CFG=/var/lib/rancher/k3s/server/manifests/traefik-config.yaml
if [[ ! -f "$TRAEFIK_CFG" ]]; then
  cat > "$TRAEFIK_CFG" <<'YAML'
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    ports:
      web:
        forwardedHeaders:
          trustedIPs:
            - "10.42.0.0/16"
            - "2001:db8:42::/56"
        http:
          encodedCharacters:
            allowEncodedHash: true
            allowEncodedSlash: true
      websecure:
        forwardedHeaders:
          trustedIPs:
            - "10.42.0.0/16"
            - "2001:db8:42::/56"
        http:
          encodedCharacters:
            allowEncodedHash: true
            allowEncodedSlash: true
YAML
  ok "Traefik настроен ($TRAEFIK_CFG)"
else
  ok "Traefik уже настроен"
fi

# ---------- 3. Helm ----------
step "Helm (установщик пакетов для Kubernetes)"
if command -v helm >/dev/null 2>&1; then
  ok "Helm уже есть: $(helm version --short)"
else
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
  ok "Helm установлен: $(helm version --short)"
fi

# ---------- 4. namespace и каталог values ----------
step "Namespace $ESS_NAMESPACE и каталог настроек $ESS_CONFIG_DIR"
kubectl create namespace "$ESS_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
mkdir -p "$ESS_CONFIG_DIR"
ok "Готово"

# ---------- 5. сертификаты ----------
VALUES_ARGS=(-f "$ESS_CONFIG_DIR/hostnames.yaml")
if [[ "$ESS_TLS" == "letsencrypt" ]]; then
  step "cert-manager $CERT_MANAGER_VERSION + Let's Encrypt"
  helm repo add jetstack https://charts.jetstack.io --force-update >/dev/null
  helm upgrade --install cert-manager jetstack/cert-manager \
    --namespace cert-manager --create-namespace \
    --version "$CERT_MANAGER_VERSION" --set crds.enabled=true --wait --timeout 10m >/dev/null
  ok "cert-manager установлен"
  {
    echo "apiVersion: cert-manager.io/v1"
    echo "kind: ClusterIssuer"
    echo "metadata:"
    echo "  name: letsencrypt-prod"
    echo "spec:"
    echo "  acme:"
    echo "    server: https://acme-v02.api.letsencrypt.org/directory"
    [[ -n "$ESS_LE_EMAIL" ]] && echo "    email: $ESS_LE_EMAIL"
    echo "    privateKeySecretRef:"
    echo "      name: letsencrypt-prod-private-key"
    echo "    solvers:"
    echo "      - http01:"
    echo "          ingress:"
    echo "            class: traefik"
  } > "$ESS_CONFIG_DIR/cluster-issuer.yaml"
  kubectl apply -f "$ESS_CONFIG_DIR/cluster-issuer.yaml" >/dev/null
  ok "ClusterIssuer letsencrypt-prod создан"
  curl -fsSL "$FRAGMENTS_BASE/quick-setup-letsencrypt.yaml" -o "$ESS_CONFIG_DIR/tls.yaml"
  VALUES_ARGS+=(-f "$ESS_CONFIG_DIR/tls.yaml")
else
  step "TLS выключен (ESS_TLS=none): ESS будет отвечать по HTTP, шифрование — на вашем reverse proxy"
  curl -fsSL "$FRAGMENTS_BASE/quick-setup-external-cert.yaml" -o "$ESS_CONFIG_DIR/tls.yaml"
  VALUES_ARGS+=(-f "$ESS_CONFIG_DIR/tls.yaml")
  ok "tls.yaml: ingress.tlsEnabled: false"
fi

# ---------- 6. hostnames.yaml ----------
step "hostnames.yaml"
cat > "$ESS_CONFIG_DIR/hostnames.yaml" <<YAML
# Сгенерировано install-ess.sh $(date -Is). Структура — как в quick-setup-hostnames.yaml из ess-helm.
serverName: $ESS_DOMAIN
synapse:
  ingress:
    host: $ESS_HOST_SYNAPSE
matrixAuthenticationService:
  ingress:
    host: $ESS_HOST_AUTH
matrixRTC:
  ingress:
    host: $ESS_HOST_RTC
elementWeb:
  ingress:
    host: $ESS_HOST_CHAT
elementAdmin:
  ingress:
    host: $ESS_HOST_ADMIN
YAML
ok "Записан $ESS_CONFIG_DIR/hostnames.yaml"

# ---------- 7. установка чарта ----------
step "Устанавливаю ESS Community (образы качаются, это 5–15 минут)"
HELM_EXTRA=()
[[ -n "$ESS_CHART_VERSION" ]] && HELM_EXTRA+=(--version "$ESS_CHART_VERSION")
helm upgrade --install --namespace "$ESS_NAMESPACE" ess "$ESS_CHART" \
  "${VALUES_ARGS[@]}" "${HELM_EXTRA[@]}" --wait --timeout 30m
ok "Чарт установлен: $(helm list -n "$ESS_NAMESPACE" -o json | sed -n 's/.*"chart":"\([^"]*\)".*/\1/p' | head -1)"
kubectl rollout status deploy/ess-matrix-authentication-service -n "$ESS_NAMESPACE" --timeout=600s >/dev/null
ok "Служба входа (MAS) готова"

# ---------- 8. первый пользователь ----------
step "Создаю пользователя @$ESS_ADMIN_USER:$ESS_DOMAIN"
REG_ARGS=(--yes --admin --password "$ESS_ADMIN_PASSWORD")
[[ -n "$ESS_ADMIN_EMAIL" ]] && REG_ARGS+=(--email "$ESS_ADMIN_EMAIL")
if kubectl exec -n "$ESS_NAMESPACE" deploy/ess-matrix-authentication-service -- \
     mas-cli manage register-user "${REG_ARGS[@]}" "$ESS_ADMIN_USER" >/dev/null 2>&1; then
  ok "Пользователь создан"
else
  warn "Не удалось создать пользователя (возможно, он уже существует). Вручную: kubectl exec -n $ESS_NAMESPACE -it deploy/ess-matrix-authentication-service -- mas-cli manage register-user"
  GENERATED_PASSWORD=0
fi

# ---------- 9. итог ----------
SCHEME="https"; [[ "$ESS_TLS" == "none" ]] && SCHEME="http"
printf '\n%s================ ГОТОВО ================%s\n' "$C_G" "$C_0"
printf 'Element Web:    %s://%s\n' "$SCHEME" "$ESS_HOST_CHAT"
printf 'Element Admin:  %s://%s\n' "$SCHEME" "$ESS_HOST_ADMIN"
printf 'Вход (MAS):     %s://%s\n' "$SCHEME" "$ESS_HOST_AUTH"
printf 'Synapse:        %s://%s\n' "$SCHEME" "$ESS_HOST_SYNAPSE"
printf 'Matrix ID:      @%s:%s\n' "$ESS_ADMIN_USER" "$ESS_DOMAIN"
if [[ "$GENERATED_PASSWORD" == "1" ]]; then
  printf 'Пароль:         %s   (сгенерирован, сохраните — больше не покажется)\n' "$ESS_ADMIN_PASSWORD"
fi
cat <<EOF

Что дальше:
  • В Element X на телефоне: «Войти» → сервер $ESS_DOMAIN → логин и пароль выше.
  • Проверка федерации: https://federationtester.matrix.org/#$ESS_DOMAIN
  • Ещё пользователи:  kubectl exec -n $ESS_NAMESPACE -it deploy/ess-matrix-authentication-service -- mas-cli manage register-user
  • Состояние:         kubectl get pods -n $ESS_NAMESPACE
  • Обновление:        запустите этот скрипт ещё раз (helm upgrade с теми же values)
  • Настройки:         $ESS_CONFIG_DIR/   · лог установки: $LOG_FILE
  • Если сертификаты не выданы за 5 минут: kubectl get certificate -n $ESS_NAMESPACE ; kubectl describe challenge -n $ESS_NAMESPACE

Удаление (по README ess-helm):
  helm uninstall ess -n $ESS_NAMESPACE && kubectl delete namespace $ESS_NAMESPACE
  helm uninstall cert-manager -n cert-manager
  /usr/local/bin/k3s-uninstall.sh && rm -rf ~/ess-config-values ~/.kube /usr/local/bin/helm
EOF
