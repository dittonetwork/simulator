FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache git

# Copy entire project source first, so we can update submodules
COPY . .

# Initialize and update submodules
RUN git submodule update --init --recursive

# Install dependencies for all workspaces
RUN npm install

# Build ditto-workflow-sdk workspace first
RUN npm run build -w @ditto/workflow-sdk

# Build simulator TypeScript integration
RUN npm run build

CMD ["npm", "start"] 