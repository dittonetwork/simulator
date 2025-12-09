FROM node:20-alpine
ARG COMMIT_HASH
ARG BUILD_TAG
ENV COMMIT_HASH=$COMMIT_HASH
ENV BUILD_TAG=$BUILD_TAG

WORKDIR /app

RUN apk add --no-cache git

# Copy entire project source first
COPY . .

# Initialize and update submodules (in case they weren't cloned with --recursive)
RUN git submodule update --init --recursive || true

# Install dependencies for all workspaces
RUN npm install

# Build ditto-workflow-sdk workspace first
RUN npm run build -w @ditto/workflow-sdk

# Build simulator TypeScript integration
RUN npm run build

CMD ["npm", "run", "start"] 