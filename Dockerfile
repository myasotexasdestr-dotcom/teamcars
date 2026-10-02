# Альтернатива pm2, если на VPS всё крутится в Docker.
# docker build -t teamcars . && docker run -d --name teamcars --restart unless-stopped \
#   -p 127.0.0.1:3010:3010 -v /var/lib/teamcars:/data --env-file .env -e DATA_DIR=/data -e HOST=0.0.0.0 teamcars
FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && npm install --omit=dev && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY . .
ENV PORT=3010 HOST=0.0.0.0 DATA_DIR=/data NODE_ENV=production
EXPOSE 3010
CMD ["node", "server.js"]
