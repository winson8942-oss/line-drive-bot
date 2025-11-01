FROM node:18-alpine

ENV NODE_ENV=production
WORKDIR /app

# Copy package manifest & install deps first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# Copy remaining files
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
