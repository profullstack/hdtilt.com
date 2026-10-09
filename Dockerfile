# hdtilt.com: the web app, API, MCP and stream proxy in public mode.
FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
# Scripts off: the Electron binary is for the desktop build, not this image.
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun web/build.js

FROM oven/bun:1-alpine
# ffmpeg repackages transport streams as HLS for iPhone Safari (no MSE there).
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production HDTILT_PUBLIC=1 HOST=0.0.0.0 PORT=3000
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY --chown=bun:bun bin ./bin
COPY --chown=bun:bun src ./src
COPY --from=build --chown=bun:bun /app/web/dist ./web/dist
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["bun", "bin/hdtilt.js", "serve", "--public", "--host", "0.0.0.0", "--port", "3000"]
