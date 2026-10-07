FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
# The image ships without .git, so the commit is passed in at build time:
#   docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t tradegate .
ARG GIT_SHA=""
ENV NODE_ENV=production GIT_SHA=$GIT_SHA
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY database ./database
COPY --from=build /app/dist ./dist
# The base image runs as root by default. Nothing here needs it: the server
# binds an unprivileged port and writes nothing to the filesystem, so a
# compromise of the process should not also be a compromise of the container.
RUN chown -R node:node /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/health > /dev/null || exit 1
CMD ["node", "server/index.js"]
