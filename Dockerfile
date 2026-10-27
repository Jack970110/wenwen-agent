# ---- 构建阶段：装依赖 + 构建前端 ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
RUN npm install
COPY . .
RUN npm run build

# ---- 运行阶段：精简镜像，只带运行时需要的东西 ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
RUN npm install --omit=dev
COPY --from=build /app/frontend/dist ./frontend/dist
COPY src ./src
# 数据卷：data/data.db（会话+向量）挂到宿主机，容器重建不丢
VOLUME /app/data
EXPOSE 3001
CMD ["npx", "tsx", "src/server.ts"]
