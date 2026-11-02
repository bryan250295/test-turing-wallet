FROM node:22-bookworm-slim AS development
WORKDIR /app/wallet
COPY wallet/package.json wallet/package-lock.json ./
COPY wallet/vendor ./vendor
RUN npm ci
COPY shared /app/shared
COPY wallet .
RUN mkdir -p node_modules/.vite node_modules/.vite-temp && chown node:node /app /app/wallet node_modules/.vite node_modules/.vite-temp
USER node
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--port", "5173", "--strictPort"]

FROM development AS build
RUN npm run build

FROM nginxinc/nginx-unprivileged:stable-alpine AS production
COPY wallet/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/wallet/dist /usr/share/nginx/html
EXPOSE 8080
