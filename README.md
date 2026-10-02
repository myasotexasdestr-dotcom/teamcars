# TeamCars — учёт автозапчастей

Веб-приложение для авторазборки: склады, товары, сделки, касса. Работает с телефона, с ПК и как Telegram Mini App.

- **Сервер:** Node.js (встроенный `http`) + SQLite (`better-sqlite3`). Один процесс отдаёт и API, и интерфейс.
- **Данные:** файл `teamcars.db` и папка `photos/` в `DATA_DIR`. Таблицы устроены по ТЗ (`docs/TZ.md`): товары, склады, остатки, журнал движения товара, сделки, позиции сделок, счета, журнал финансовых операций.
- **Логика на сервере.** Каждое действие выполняется в одной транзакции: сделка, списание со склада, запись в журнал и зачисление денег. Сервер сам проверяет остатки, балансы и права ролей (Адмін / Власник).
- **Синхронизация.** Все устройства видят одни и те же данные, изменения подтягиваются раз в 5 секунд.
- **PIN** хранится как HMAC-хеш с секретом сервера. Вход ограничен: 20 попыток за 15 минут с одного IP.

---

## Шпаргалка: что сделать

> Везде ниже замените **`ВАШ-ДОМЕН`** на домен мясного приложения (например, `myaso-texas.com.ua`).
> Приложение откроется на **`https://cars.ВАШ-ДОМЕН`**.

1. Залить код в новый GitHub-репозиторий `teamcars`.
2. В DNS добавить запись `cars` → IP вашего VPS.
3. На VPS: клонировать, `npm install`, заполнить `.env`, запустить через pm2.
4. Добавить сайт в nginx и выпустить сертификат через certbot.
5. В BotFather прописать ссылку `https://cars.ВАШ-ДОМЕН` в кнопку меню бота.

Подробно — ниже.

---

## 1. GitHub: новый репозиторий

1. На github.com нажмите **New repository**. Имя `teamcars`, тип **Private**. README, .gitignore и лицензию **не** добавляйте, репозиторий должен быть пустым.
2. На своём компьютере распакуйте архив и выполните в папке проекта:

```bash
cd teamcars
git init
git add .
git commit -m "TeamCars: перша версія"
git branch -M main
git remote add origin https://github.com/ВАШ-ЛОГІН/teamcars.git
git push -u origin main
```

При `git push` по HTTPS GitHub попросит логин, а вместо пароля — **Personal Access Token**: Settings → Developer settings → Fine-grained tokens, доступ Contents: Read and write к репозиторию `teamcars`.
Без терминала можно так: GitHub Desktop → File → Add local repository → Publish.

> `.env`, `data/` и `node_modules/` в git не попадут, они уже в `.gitignore`. Никогда не коммитьте `.env`.

---

## 2. DNS: поддомен `cars`

В панели, где управляете доменом (регистратор или Cloudflare), добавьте запись:

| Тип | Имя | Значение |
|---|---|---|
| A | `cars` | IP вашего VPS (тот же, что у основного домена) |

Узнать IP: `dig +short ВАШ-ДОМЕН` или `ping ВАШ-ДОМЕН`.
Если домен на **Cloudflare**, на время выпуска сертификата поставьте у записи серое облако (DNS only). Потом можно вернуть оранжевое, режим SSL/TLS — *Full (strict)*.

Проверка, когда запись применилась (обычно 1–15 минут): `dig +short cars.ВАШ-ДОМЕН` должен вернуть IP сервера.

---

## 3. VPS: установка

Зайдите на сервер по SSH (так же, как для мясного приложения):

```bash
ssh ВАШ-ПОЛЬЗОВАТЕЛЬ@IP-СЕРВЕРА
```

**3.1. Посмотрите, что уже работает** — это ни на что не влияет, просто чтобы не задеть мясное приложение:

```bash
node -v              # нужно v18 или новее
pm2 ls               # список процессов; мясное приложение, скорее всего, тут
ls /etc/nginx/sites-enabled/
sudo ss -ltnp | grep -E ':3000|:3010'   # какие порты заняты
```

Если `pm2 ls` пустой, а `docker ps` показывает контейнеры, значит у вас Docker. Тогда смотрите раздел «Если на сервере Docker» ниже.
Если порт 3010 занят, возьмите любой свободный, например 3011, и поменяйте его и в `.env`, и в конфиге nginx.

**3.2. Скачайте код:**

```bash
sudo mkdir -p /opt/teamcars /var/lib/teamcars
sudo chown -R $USER:$USER /opt/teamcars /var/lib/teamcars
git clone https://github.com/ВАШ-ЛОГІН/teamcars.git /opt/teamcars
cd /opt/teamcars
npm install --omit=dev
```

Для приватного репозитория git спросит логин и токен (тот же Personal Access Token, достаточно доступа Read).
Если `npm install` падает при сборке `better-sqlite3`: `sudo apt install -y build-essential python3` и повторите.

**3.3. Настройки:**

```bash
cp .env.example .env
nano .env
```

- `PORT=3010` — порт, на котором слушает приложение (только локально, наружу его откроет nginx).
- `DATA_DIR=/var/lib/teamcars` — база, фото и секрет. Эта папка переживает обновления кода.
- `ADMIN_NAME` / `ADMIN_PIN` — первый администратор, создаётся при самом первом запуске. **Поставьте свой PIN** (4–8 цифр), не `0000`.
- `SEED_DEMO=0` — на боевом сервере должно быть 0.

Сохранить в nano: `Ctrl+O`, `Enter`, `Ctrl+X`.

**3.4. Пробный запуск:**

```bash
node server.js
# Должно появиться: «Створено першого адміна …» и «TeamCars: http://127.0.0.1:3010 …»
# Остановить: Ctrl+C
```

**3.5. Постоянный запуск через pm2** (как мясное приложение):

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 ls          # teamcars — online
```

Если pm2 на этом сервере ещё не настроен на автозапуск, выполните `pm2 startup` и затем команду, которую он выведет.

---

## 4. nginx + HTTPS

```bash
sudo cp /opt/teamcars/deploy/nginx-cars.conf /etc/nginx/sites-available/cars.ВАШ-ДОМЕН
sudo sed -i 's/ВАШ-ДОМЕН/ваш-настоящий-домен.com/g' /etc/nginx/sites-available/cars.ВАШ-ДОМЕН
sudo ln -s /etc/nginx/sites-available/cars.ВАШ-ДОМЕН /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` должен написать `syntax is ok` / `test is successful`. Мясной сайт при этом не затрагивается: это отдельный файл для отдельного поддомена.

Сертификат (certbot, скорее всего, уже стоит, если мясной сайт работает по https):

```bash
sudo certbot --nginx -d cars.ВАШ-ДОМЕН
# на вопрос о редиректе — выбрать редирект на HTTPS
```

Проверка: откройте `https://cars.ВАШ-ДОМЕН/api/health`, должно быть `{"ok":true,...}`.
Потом откройте `https://cars.ВАШ-ДОМЕН` и войдите с `ADMIN_PIN`.

---

## 5. Первые шаги в приложении

1. **Налаштування → Користувачі.** При необходимости поменяйте свой PIN. Добавьте сотрудников и выдайте им роли: Адмін управляет пользователями, Власник только смотрит список.
2. **Налаштування → Склади.** Переименуйте «Склад 1», добавьте остальные склады, звёздочкой отметьте склад по умолчанию.
3. **Головна → нажать на баланс → «Внести».** Внесите текущие остатки Каса UAH, Каса USD, Крипто и ФОП, в комментарии напишите «Початковий залишок». Балансы считаются только по журналу операций, поэтому стартовые суммы вносятся именно так.
4. **Склад → «+ Товар».** Добавьте запчасти.

---

## 6. Telegram-бот

Telegram открывает приложение по https-адресу, ничего на сервер добавлять не нужно.

**Вариант А — отдельный бот для запчастей (рекомендуется):**
1. В [@BotFather](https://t.me/BotFather): `/newbot` → название (например, «TeamCars Склад») → username, заканчивающийся на `bot`.
2. `/mybots` → выберите бота → **Bot Settings → Menu Button → Configure menu button** → вставьте `https://cars.ВАШ-ДОМЕН` → название кнопки, например `Склад`.
3. Откройте бота в Telegram, слева от поля ввода появится кнопка «Склад».

**Вариант Б — в том же боте, что и мясное приложение.** Кнопка меню у бота одна, и она уже занята мясом, поэтому создайте Mini App:
1. В BotFather: `/newapp` → выберите мясного бота → название «Запчастини» → описание → картинка 640×360 (любая) → GIF можно пропустить (`/empty`) → URL `https://cars.ВАШ-ДОМЕН` → короткое имя, например `cars`.
2. Приложение откроется по ссылке `https://t.me/ИМЯ_МЯСНОГО_БОТА/cars`. Её можно закрепить в чате или отправить сотрудникам.

В Telegram приложение само разворачивается на весь экран. Каждый вход в Telegram на новом устройстве требует PIN один раз, дальше сессия сохраняется на 60 дней.

---

## 7. Обновление кода

На своём компьютере: внесли изменения → `git add . && git commit -m "..." && git push`.
На сервере:

```bash
cd /opt/teamcars
git pull
npm install --omit=dev
pm2 restart teamcars
```

База и фото лежат в `/var/lib/teamcars`, при обновлении они не трогаются.

---

## 8. Резервные копии

```bash
crontab -e
# добавить строку — копия базы каждую ночь в 03:15, хранится 30 последних:
15 3 * * * cd /opt/teamcars && /usr/bin/env node scripts/backup.js >> /var/lib/teamcars/backup.log 2>&1
```

Копии лежат в `/var/lib/teamcars/backups/`. Фото — в `/var/lib/teamcars/photos/`.
Хотя бы раз в неделю скачивайте обе папки к себе:

```bash
scp -r ВАШ-ПОЛЬЗОВАТЕЛЬ@IP-СЕРВЕРА:/var/lib/teamcars ./teamcars-backup
```

Восстановление: `pm2 stop teamcars` → скопировать нужный `teamcars-….db` в `/var/lib/teamcars/teamcars.db` → `pm2 start teamcars`.

> Файл `/var/lib/teamcars/.secret` тоже держите в бэкапе. Без него старые PIN-коды перестанут подходить. Тогда админу задаётся новый PIN через `scripts/reset-pin.js`, а остальным он выдаёт PIN заново.

---

## 9. Если что-то не так

| Симптом | Что сделать |
|---|---|
| 502 Bad Gateway | `pm2 logs teamcars --lines 50`. Чаще всего неверный `PORT`/`DATA_DIR` в `.env` или не выполнен `npm install`. |
| certbot: «DNS problem» | Запись `cars` ещё не применилась (`dig +short cars.ВАШ-ДОМЕН`) или включён оранжевый Cloudflare. |
| Забыли PIN единственного админа | `cd /opt/teamcars && node scripts/reset-pin.js "Богдан Анатолійович" 4821`. Пользователь станет активным админом с новым PIN. |
| «Забагато спроб» при входе | 20 неверных PIN с одного IP за 15 минут. Подождите или `pm2 restart teamcars`. |
| Нужно попробовать на демо-данных | На **другой** папке данных: `DATA_DIR=/tmp/tc-demo SEED_DEMO=1 PORT=3099 node server.js` (PIN 1111 / 2222). |

---

## Если на сервере Docker, а не pm2

```bash
cd /opt/teamcars
cp .env.example .env && nano .env      # ADMIN_NAME / ADMIN_PIN
docker build -t teamcars .
docker run -d --name teamcars --restart unless-stopped \
  -p 127.0.0.1:3010:3010 -v /var/lib/teamcars:/data \
  --env-file .env -e DATA_DIR=/data -e HOST=0.0.0.0 teamcars
```

Дальше всё так же: nginx из раздела 4 проксирует на `127.0.0.1:3010`.
Обновление: `git pull && docker build -t teamcars . && docker rm -f teamcars` и снова `docker run …`.

---

## Структура

```
server.js              HTTP-сервер: API, вход, раздача интерфейса и фото
src/db.js              схема SQLite (таблицы по ТЗ)
src/logic.js           вся бизнес-логика: сделки, склад, деньги, роли, журналы
src/sqlite.js          драйвер: better-sqlite3 (или встроенный node:sqlite в Node 22+)
public/index.html      интерфейс (одна страница)
scripts/backup.js      резервная копия базы
scripts/reset-pin.js   аварийный сброс PIN админа
deploy/nginx-cars.conf конфиг nginx для поддомена
ecosystem.config.cjs   конфиг pm2
docs/TZ.md             техническое задание
```

### API (для справки)

| Метод | Путь | Что делает |
|---|---|---|
| POST | `/api/auth/login` `{pin}` | вход → токен + данные |
| POST | `/api/auth/logout` | выход |
| GET | `/api/state` | все данные для интерфейса |
| GET | `/api/version` | номер версии данных (для опроса изменений) |
| POST | `/api/action` `{type, payload}` | действие: `createDeal`, `updateDeal`, `payDeal`, `cancelDeal`, `addStock`, `saveProduct`, `deleteProduct`, `expense`, `deposit`, `saveUser`, `toggleUser`, `deleteUser`, `saveWarehouse`, `toggleWarehouse`, `deleteWarehouse`, `setDefaultWarehouse` |
| POST | `/api/photos` `{dataUrl}` | загрузка фото → `/photos/…jpg` |
| GET | `/api/health` | проверка, что сервер жив |
