# Деплой «Мясо з Техасу» — повний конспект (для переносу на інший застосунок)

## 1. Сервер (VPS)

- Хостинг: панель на базі QEMU/KVM, хостнейм `server7272.server-vps.com`, VNC-консоль через браузер (noVNC).
- ОС: Ubuntu 24.04 LTS, встановлена через кнопку "Встановити ОС" у панелі хостингу.
- **У сервера НЕМАЄ IPv4** — тільки IPv6: `2a05:b00:0:0:0:51:7d58:7c94` (повний запис), `2a05:b00::51:7d58:7c94` (скорочений).
- Та адреса, що показана в панелі хостингу як "91.223.223.237" — це IP для VNC-консолі хостингу, НЕ адреса самого сервера. Легко переплутати.
- Доступ до сервера:
  - **Через браузерну VNC-консоль** (кнопка в панелі хостингу, шестірня в ACTION → Launch VNC) — працює завжди, логін root + пароль, встановлений/скинутий у панелі хостингу.
  - **SSH з домашнього інтернету НЕ ПРАЦЮЄ**, бо вдома немає IPv6 (ні по wifi, ні по LTE в нашому випадку спершу теж не було). Тому PuTTY/FileZilla з комп'ютера — безуспішно.

## 2. Через що саме заливали файли на сервер (бо FileZilla не працював)

1. Файли проєкту заливались у публічний (!) репозиторій на GitHub через веб-інтерфейс (Add file → Upload files), з потрібною структурою папок.
2. На сервері (у VNC-консолі, залогінені root) файли стягувались напряму командою `wget` з raw-посилань:
   ```
   wget -O <local-filename> https://raw.githubusercontent.com/<user>/<repo>/refs/heads/main/<path/in/repo>
   ```
   Приклад, який реально використовували:
   ```
   mkdir -p /opt/sklad-server/public
   cd /opt/sklad-server
   wget -O server.js https://raw.githubusercontent.com/myasotexasdestr-dotcom/sklad2/refs/heads/main/server.js
   wget -O package.json https://raw.githubusercontent.com/myasotexasdestr-dotcom/sklad2/refs/heads/main/package.json
   wget -O README.md https://raw.githubusercontent.com/myasotexasdestr-dotcom/sklad2/refs/heads/main/README.md
   wget -O public/sklad.html https://raw.githubusercontent.com/myasotexasdestr-dotcom/sklad2/refs/heads/main/public/sklad.html
   ```
3. Для оновлення файлу пізніше: залити нову версію на GitHub (той самий шлях), повторити `wget -O ...` на сервері, потім `pm2 restart <назва-процесу>`.

**Для другого застосунку:** якщо він теж на Node.js — та сама схема підходить. Заведіть окремий репозиторій (або підпапку в тому ж) на GitHub, заливайте файли туди, стягуйте на сервер через `wget` у свою папку, наприклад `/opt/<назва-другого-застосунку>`.

## 3. Встановлене на сервері (спільне для всіх застосунків, повторно встановлювати не треба)

- **Node.js v20** — встановлено через NodeSource:
  ```
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
  ```
  (⚠️ стандартне apt-дзеркало `de.archive.ubuntu.com` не резолвилось — довелось замінити на `archive.ubuntu.com` у файлі `/etc/apt/sources.list.d/ubuntu.sources` через `sed -i 's/de.archive.ubuntu.com/archive.ubuntu.com/g' ...`, бо Ubuntu 24.04 тримає джерела саме в цьому новому файлі, не в старому `/etc/apt/sources.list`.)
- **build-essential + python3** — потрібні, якщо якийсь npm-пакет компілюється з нативного коду (у нас — `better-sqlite3`):
  ```
  apt install -y build-essential python3
  ```
- **pm2** (менеджер процесів, тримає застосунки живими й перезапускає після ребута):
  ```
  npm install -g pm2
  ```
  Запуск нового застосунку: `pm2 start server.js --name <ім'я>`, потім обов'язково `pm2 save`. `pm2 startup` виконували один раз (налаштовує автозапуск після перезавантаження сервера) — вдруге не треба.
- **Caddy** (реверс-проксі, автоматичний https) — встановлений НЕ через apt-репозиторій (там був протермінований GPG-ключ у репозиторії Caddy), а прямим завантаженням бінарника:
  ```
  curl -o /usr/local/bin/caddy "https://caddyserver.com/api/download?os=linux&arch=amd64"
  chmod +x /usr/local/bin/caddy
  ```
  Caddy теж запущений і живе через pm2, не через systemd:
  ```
  pm2 start "/usr/local/bin/caddy run --config /opt/caddy/Caddyfile --adapter caddyfile" --name caddy
  pm2 save
  ```

## 4. Конфіг Caddy — єдиний файл на весь сервер, кожен домен — свій блок

Файл: `/opt/caddy/Caddyfile`. Для кожного застосунку додається свій блок з доменом і портом, на якому цей застосунок слухає:

```
app.myasotexasy.com.ua {
  reverse_proxy localhost:3000
}

ДРУГИЙ-ДОМЕН.ua {
  reverse_proxy localhost:3001
}
```

**Важливо для другого застосунку:** він має слухати на іншому порту (не 3000, зайнятий першим застосунком) — наприклад 3001. Це задається всередині коду другого застосунку (зазвичай змінна `PORT`).

Після будь-якої зміни Caddyfile:
```
pm2 restart caddy
```

Якщо редагуєте файл через консоль і багаторядкове вставлення "ламається" (рядки зливаються в один) — пишіть по рядку окремими командами:
```
echo 'ДРУГИЙ-ДОМЕН.ua {' > /opt/caddy/Caddyfile
echo '  reverse_proxy localhost:3001' >> /opt/caddy/Caddyfile
echo '}' >> /opt/caddy/Caddyfile
```
(або `>>` замість `>` на першому рядку, якщо дописуєте до вже існуючого файлу з іншими доменами).

## 5. Домен і DNS — як обійшли відсутність IPv4

Проблема: сервер без IPv4 — більшість домашніх/мобільних мереж в Україні IPv6 не підтримують, тому прямий домен (DuckDNS → IPv6 сервера) відкривався тільки з частини мереж.

Рішення — **Cloudflare як безкоштовний проксі-міст**:
1. Куплено домен `myasotexasy.com.ua`.
2. Домен доданий у безкоштовний акаунт Cloudflare (cloudflare.com → Add a domain).
3. У реєстратора домену nameservers змінено на ті, що видав Cloudflare.
4. У Cloudflare → DNS → Records додано запис: **Тип AAAA**, Name — піддомен (у нас `app`), значення — IPv6-адреса сервера, **Proxy status обов'язково увімкнений** (помаранчева хмарка) — саме це дає "міст" для IPv4-клієнтів.
5. Cloudflare → SSL/TLS → Overview → режим **Full** (не Flexible).

**Для другого застосунку:** додайте ще один AAAA-запис у тому ж Cloudflare-акаунті з іншим піддоменом (наприклад `app2` або будь-яка зручна назва), той самий IPv6 сервера, проксі увімкнено. Відповідний блок прописуєте в Caddyfile (пункт 4) з портом другого застосунку.

## 6. Поточна структура на сервері

```
/opt/sklad-server/        — застосунок "Мясо з Техасу" (порт 3000)
  server.js
  package.json
  public/sklad.html
  node_modules/
  data/                    — SQLite-база, створюється сама
/opt/caddy/
  Caddyfile                — конфіг реверс-проксі з усіма доменами
/usr/local/bin/caddy       — бінарник Caddy
```

Для другого застосунку логічно: `/opt/<назва>/`, свій порт (3001 і далі), свій pm2-процес, свій блок у Caddyfile, свій AAAA-запис/піддомен у Cloudflare.

## 7. Корисні команди для перевірки стану

```
pm2 status                  — які процеси живі (sklad, caddy, і новий, коли додасте)
pm2 logs <ім'я> --lines 40 --nostream   — логи конкретного процесу
pm2 restart <ім'я>          — перезапустити після зміни файлів/конфігу
cat /opt/caddy/Caddyfile    — подивитись поточні домени
```
