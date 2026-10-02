// pm2: pm2 start ecosystem.config.cjs && pm2 save
// Настройки (порт, папка данных, первый админ) читаются из .env рядом с server.js.
module.exports = {
  apps: [{
    name: 'teamcars',
    script: 'server.js',
    cwd: __dirname,
    env: { NODE_ENV: 'production' },
    max_memory_restart: '300M',
    time: true,
  }],
};
