# Server-Image (NEW_DESIGN.md 12.3): ein Image für app, ingest und scheduler, der Prozess kommt aus `command:` in Compose.
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci -w packages/server
COPY packages/server packages/server
RUN npm run build -w packages/server

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev -w packages/server && npm cache clean --force
COPY --from=build /src/packages/server/dist packages/server/dist
COPY packages/server/migrations packages/server/migrations
USER node
WORKDIR /app/packages/server
CMD ["node", "dist/app/main.js"]
