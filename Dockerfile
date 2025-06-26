FROM node:20-alpine

WORKDIR /app

# Copy SDK first and build it
COPY ditto-workflow-sdk/ ./ditto-workflow-sdk/
WORKDIR /app/ditto-workflow-sdk
RUN npm install && npm run build

# Go back to app root and copy simulator files
WORKDIR /app
COPY package*.json ./
RUN npm install

# Copy simulator source code
COPY src/ ./src/
COPY tsconfig.json ./

# Build simulator TypeScript integration
RUN npm run build

CMD ["npm", "start"] 