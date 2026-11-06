FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package*.json ./
RUN npm ci
COPY web/ web/
RUN npm run build
FROM nginx:stable-alpine
COPY --from=build /src/dist /usr/share/nginx/html
COPY scripts/nginx.conf /etc/nginx/conf.d/default.conf
