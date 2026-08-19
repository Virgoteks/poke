# syntax=docker/dockerfile:1
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install --include=dev

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS runtime
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/db ./db
COPY --from=build /app/tsconfig.json ./tsconfig.json

EXPOSE 3000
USER node
CMD ["node", "dist/server.js"]
