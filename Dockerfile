FROM node:22-alpine

WORKDIR /app

# Copia i file di configurazione
COPY package.json ./

# Copia il codice sorgente
COPY . .

# Variabili di ambiente predefinite
ENV PORT=3000
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

EXPOSE 3000

CMD ["node", "server.js"]
