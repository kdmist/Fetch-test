# Stage 1: Builder
FROM node:22-alpine AS builder
WORKDIR /workspace

# Install pnpm - pinning version is good practice
RUN corepack enable && corepack prepare pnpm@10.16.1 --activate

# Copy workspace configs - we need the root files to understand the workspace structure
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./

# Copy the source code for the app and shared packages
# Copying everything to be safe - use .dockerignore to whitelist
COPY . .

# Install dependencies (including local workspace links)
RUN pnpm install --frozen-lockfile

# Build the shared OTEL package first
RUN pnpm --filter=@zakayo/zts-otel run build

# Build app - builds 'website' and outputs to /workspace/apps/website/build
RUN pnpm --filter=website run build

# Create a pruned, production-ready deployment folder
# This command isolates the 'website' app and installs only prod dependencies into /prod/website
RUN pnpm --filter=website --prod deploy /prod/website

# Stage 2: Runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# PORT is set by the environment variable passed in docker-compose
ENV PORT=4321

# Copy the "deployed" folder from pnpm
# This contains package.json and a perfectly structure node_modules
COPY --from=builder /prod/website ./

# Copy the actual build artifacts
# (pnpm deploy usually copies source/deps, but not build artifacts unless configured)
COPY --from=builder /workspace/apps/website/dist ./dist

EXPOSE 4321

CMD ["node", "dist/server/entry.mjs"]