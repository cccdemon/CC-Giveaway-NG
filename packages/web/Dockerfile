# Web-Image (SvelteKit adapter-node, NEW_DESIGN.md 12.3). Kontext ist die Repo-Wurzel: docker build -f packages/web/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci -w packages/web
COPY packages/web packages/web
RUN npm run build -w packages/web

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev -w packages/web && npm cache clean --force
COPY --from=build /src/packages/web/build packages/web/build
USER node
WORKDIR /app/packages/web
ENV PORT=3000
CMD ["node", "build"]
