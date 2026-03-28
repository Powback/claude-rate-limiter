FROM node:20-slim
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npx tsc
EXPOSE 3128
CMD ["node", "dist/index.js"]
