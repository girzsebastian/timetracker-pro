FROM node:22-slim

# fus orar România — altfel containerul rulează pe UTC și cronometrul scrie orele cu -3h
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/*
ENV TZ=Europe/Bucharest

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# Baza de date stă în /app/data — pe Coolify se montează un volum persistent aici
RUN mkdir -p data
VOLUME /app/data

ENV PORT=5555
EXPOSE 5555

CMD ["node", "server/index.js"]
