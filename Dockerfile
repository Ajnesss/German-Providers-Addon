FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8000
EXPOSE 8000
CMD ["node", "server.js"]
