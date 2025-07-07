FROM node:20-alpine

WORKDIR /app

# Copy package manifests first for dependency installation caching
COPY package*.json ./
RUN npm install

# Copy simulator source code
COPY src/ ./src/
COPY tsconfig.json ./

# Build simulator TypeScript integration
RUN npm run build

CMD ["npm", "start"] 