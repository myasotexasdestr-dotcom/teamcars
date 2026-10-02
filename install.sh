#!/usr/bin/env bash
# Установка TeamCars на VPS рядом с «Мясо з Техасу».
# Мясо (/opt/sklad-server, pm2-процесс «sklad») НЕ изменяется: его файлы только читаются при необходимости.
#
# Запуск на сервере (код берётся с raw.githubusercontent.com — работает на IPv6-only VPS, репозиторий должен быть публичным):
#   curl -fsSL https://raw.githubusercontent.com/ЛОГИН/teamcars/refs/tags/v9/install.sh | bash -s ЛОГИН/teamcars v9
#   (v9 — номер версії; без нього береться гілка main, яку GitHub кешує кілька хвилин)
#
# Повторный запуск безопасен: обновляет код, базу и .env не трогает.
set -euo pipefail

REPO="${1:?Укажите репозиторий: bash -s ЛОГИН/teamcars}"
REF="${2:-main}"
DOMAIN="${DOMAIN:-cars.myasotexasy.com.ua}"
PORT="${PORT:-3010}"
DEST=/opt/teamcars
DATA=/var/lib/teamcars
CADDYFILE=/opt/caddy/Caddyfile
CADDY=/usr/local/bin/caddy
MEAT=/opt/sklad-server
# Версія-тег (v9, v10…) — незмінна адреса, без кешу GitHub; інакше — гілка (main)
if [[ "$REF" =~ ^v[0-9]+$ ]]; then REFPATH="refs/tags/$REF"; else REFPATH="refs/heads/$REF"; fi
BASE="${BASE_URL:-https://raw.githubusercontent.com/$REPO/$REFPATH}"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m    ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m    ✗ %s\033[0m\n' "$*"; exit 1; }

say "1/6 Проверка"
command -v node >/dev/null || die "Node.js не найден"
command -v pm2 >/dev/null  || die "pm2 не найден"
ok "node $(node -v), pm2 есть"
if ss -ltn 2>/dev/null | grep -q ":$PORT\b" && ! pm2 describe teamcars >/dev/null 2>&1; then
  die "Порт $PORT уже занят другим приложением. Запустите так: PORT=3011 bash … (и сообщите Claude)"
fi
ok "порт $PORT свободен (или уже занят самим teamcars)"

say "2/6 Загрузка кода в $DEST"
FILES="server.js package.json ecosystem.config.cjs src/db.js src/logic.js src/sqlite.js public/index.html"
OPTIONAL="scripts/backup.js scripts/reset-pin.js README.md install.sh docs/TZ.md"
mkdir -p "$DEST"/{src,public,scripts,docs} "$DATA"
TMP=$(mktemp -d)
for f in $FILES $OPTIONAL; do
  mkdir -p "$TMP/$(dirname "$f")"
  if ! curl -fsSL --retry 3 "$BASE/$f?$(date +%s)" -o "$TMP/$f" 2>/dev/null; then
    rm -f "$TMP/$f"
    case " $OPTIONAL " in *" $f "*) warn "нет в репозитории (не страшно): $f" ;; *) die "не удалось скачать $f — проверьте, что он есть в репозитории на GitHub" ;; esac
  fi
done
cp -r "$TMP"/. "$DEST"/ && rm -rf "$TMP"
ok "файлы скачаны"

say "3/6 Библиотека базы данных (better-sqlite3)"
cd "$DEST"
if npm install --omit=dev --no-audit --no-fund >/tmp/teamcars-npm.log 2>&1 && node -e "require('better-sqlite3')" 2>/dev/null; then
  ok "установлена через npm"
else
  warn "npm не смог собрать модуль (лог: /tmp/teamcars-npm.log) — копирую готовый из мяса (только чтение)"
  mkdir -p node_modules
  for m in better-sqlite3 bindings file-uri-to-path; do
    [ -d "$MEAT/node_modules/$m" ] && cp -r "$MEAT/node_modules/$m" node_modules/
  done
  if node -e "require('better-sqlite3')" 2>/dev/null; then ok "скопирована из $MEAT"
  elif node --no-warnings -e "require('node:sqlite')" 2>/dev/null; then ok "будет использована встроенная SQLite Node.js"
  else die "better-sqlite3 не работает. Пришлите Claude: tail -30 /tmp/teamcars-npm.log"; fi
fi

say "4/6 Настройки (.env)"
if [ -f "$DEST/.env" ]; then
  ok ".env уже есть — оставляю как есть"
else
  PIN=""
  while ! [[ "$PIN" =~ ^[0-9]{4,8}$ ]]; do
    read -r -p "    Придумайте PIN первого админа (4–8 цифр): " PIN </dev/tty
  done
  cat > "$DEST/.env" <<EOF
PORT=$PORT
DATA_DIR=$DATA
ADMIN_NAME=Адміністратор
ADMIN_PIN=$PIN
SEED_DEMO=0
EOF
  chmod 600 "$DEST/.env"
  ok ".env создан (имя админа поменяете в приложении)"
fi

say "5/6 Запуск в pm2 (процесс «teamcars»; «sklad» не трогаем)"
if pm2 describe teamcars >/dev/null 2>&1; then pm2 restart teamcars --update-env >/dev/null; else pm2 start "$DEST/ecosystem.config.cjs" >/dev/null; fi
pm2 save >/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null || die "teamcars не отвечает. Пришлите Claude: pm2 logs teamcars --lines 30 --nostream"
ok "teamcars работает на 127.0.0.1:$PORT"

say "6/6 Caddy: блок для $DOMAIN"
if grep -q "^$DOMAIN" "$CADDYFILE"; then
  ok "блок уже есть"
else
  BACKUP="$CADDYFILE.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$CADDYFILE" "$BACKUP"
  printf '\n%s {\n  reverse_proxy localhost:%s\n}\n' "$DOMAIN" "$PORT" >> "$CADDYFILE"
  if ! "$CADDY" validate --config "$CADDYFILE" --adapter caddyfile >/tmp/teamcars-caddy.log 2>&1; then
    cp "$BACKUP" "$CADDYFILE"
    die "Caddy не принял настройку — файл возвращён как был, мясо не затронуто. Лог: /tmp/teamcars-caddy.log"
  fi
  ok "блок добавлен (копия старого файла: $BACKUP)"
fi
if "$CADDY" reload --config "$CADDYFILE" --adapter caddyfile >>/tmp/teamcars-caddy.log 2>&1; then
  ok "Caddy перечитал настройки без остановки"
else
  warn "caddy reload не сработал — перезапускаю процесс caddy (мясо будет недоступно 1–2 секунды)"
  pm2 restart caddy >/dev/null && ok "caddy перезапущен"
fi

printf '\nВстановлено версію: %s\n' "$REF"
printf '\n\033[1;32mГотово.\033[0m Через 1–2 минуты (выпуск сертификата) откройте https://%s\n' "$DOMAIN"
printf 'Проверка мяса: https://app.myasotexasy.com.ua — должно работать как раньше.\n'
printf 'Логи: pm2 logs teamcars    Сертификат: pm2 logs caddy --lines 30 --nostream\n\n'
pm2 ls
