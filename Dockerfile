FROM node:26-slim

# fus orar România — altfel containerul rulează pe UTC și cronometrul scrie orele cu -3h
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/*
ENV TZ=Europe/Bucharest

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
# shared/locales.json — toate textele, în toate limbile; serverul îl citește la
# pornire și îl servește browserului ca /i18n.js. Fără el, aplicația nu pornește.
COPY shared ./shared

# Baza de date stă în /app/data — pe Coolify se montează un volum persistent aici
RUN mkdir -p data
VOLUME /app/data

ENV PORT=5555
EXPOSE 5555

CMD ["node", "server/index.js"]
