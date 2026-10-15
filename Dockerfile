FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm install --ignore-scripts

COPY src/ ./src/
RUN npm run build

FROM node:22-alpine AS runner

LABEL docker.mcp.transport=stdio

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

ENTRYPOINT ["node", "dist/index.js"]
