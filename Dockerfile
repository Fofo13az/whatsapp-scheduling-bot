# Imagen de producción para Railway.
# node:20-slim (Debian) en lugar de alpine: mysql2 y tsdav son JS puro, pero
# slim evita sorpresas de musl con dependencias nativas transitivas.
FROM node:20-slim

ENV NODE_ENV=production

WORKDIR /app

# Instalar deps primero (capa cacheable — solo se invalida si cambian los locks)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY src ./src
COPY scripts ./scripts

# Railway inyecta PORT; el default 3000 solo aplica corriendo local
EXPOSE 3000

# node directo (no npm) para que SIGTERM llegue al proceso y el graceful
# shutdown de index.js funcione
CMD ["node", "index.js"]
