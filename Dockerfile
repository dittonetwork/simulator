FROM node:20-alpine

WORKDIR /app

# Copy package manifests first for dependency installation caching
COPY package*.json ./
COPY ditto-workflow-sdk/package*.json ./ditto-workflow-sdk/
RUN npm install

# Copy entire project source
COPY . .

# Build ditto-workflow-sdk workspace first
RUN npm run build -w ditto-workflow-sdk

# Build simulator TypeScript integration
RUN npm run build

CMD ["npm", "start"] 