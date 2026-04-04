FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy server source and UI
COPY src/ src/
COPY ui/ ui/

EXPOSE 3000
CMD ["bun", "run", "src/server.ts"]
