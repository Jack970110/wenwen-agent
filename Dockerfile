
  # ---- 构建阶段 ----
  FROM node:22-alpine AS build
  WORKDIR /app
  COPY package.json package-lock.json ./
  COPY frontend/package.json frontend/
  RUN npm config set registry https://registry.npmmirror.com
  RUN npm install
  COPY . .
  RUN npm run build

  # ---- 运行阶段 ----
  FROM node:22-alpine
  WORKDIR /app
  ENV NODE_ENV=production
  COPY package.json package-lock.json ./
  COPY frontend/package.json frontend/
  RUN npm config set registry https://registry.npmmirror.com
  RUN npm install --omit=dev
  COPY --from=build /app/frontend/dist ./frontend/dist
  COPY src ./src
  VOLUME /app/data
  EXPOSE 3001
  CMD ["npx", "tsx", "src/server.ts"]