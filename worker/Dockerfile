# 采集 worker：需要 Chromium，基于 Playwright 官方镜像（浏览器与系统依赖已内置）
FROM mcr.microsoft.com/playwright:v1.48.2-jammy AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.48.2-jammy
WORKDIR /app
ENV NODE_ENV=production
# 浏览器由基础镜像提供，跳过 npm 安装时的重复下载
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
CMD ["node", "dist/main.js"]
