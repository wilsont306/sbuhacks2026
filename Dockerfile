# Hub image: builds the two Vite pages into dist/ and serves them plus /ws from hub.js.
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
# Full install first: vite is a devDependency and the build needs it.
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "hub.js"]
