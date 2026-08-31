FROM node:22-alpine AS base
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm install
COPY packages packages
RUN npm run build -w @buhc/shared && npm run build -w @buhc/core

FROM base AS api
COPY apps/api apps/api
RUN npm run build -w @buhc/api
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]

FROM base AS worker
COPY apps/worker apps/worker
RUN npm run build -w @buhc/worker
CMD ["node", "apps/worker/dist/index.js"]

FROM base AS web
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY apps/web apps/web
RUN npm run build -w @buhc/web
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@buhc/web"]
