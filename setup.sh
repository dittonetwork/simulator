#!/bin/bash

# Ditto Simulator Setup Script
echo "🚀 Setting up Ditto Simulator with WorkflowSDK"
echo "=============================================="

# Check if ditto-workflow-sdk directory exists
if [ -d "ditto-workflow-sdk" ]; then
    echo "📂 SDK directory already exists. Updating..."
    cd ditto-workflow-sdk
    git pull origin zerodev-approach-improved
    cd ..
else
    echo "📥 Cloning WorkflowSDK repository..."
    git clone https://github.com/mukhametgalin/ditto-workflow-sdk.git
    cd ditto-workflow-sdk
    git checkout zerodev-approach-improved
    cd ..
fi

# Build the SDK
echo "🔨 Building WorkflowSDK..."
cd ditto-workflow-sdk
npm install
npm run build
cd ..

# Install simulator dependencies
echo "📦 Installing simulator dependencies..."
rm -f package-lock.json
npm install

# Build simulator
echo "🔨 Building simulator..."
npm run build -w @ditto/workflow-sdk

echo ""
echo "✅ Setup complete! You can now:"
echo "   • Run tests: npm run test:integration"
echo "   • Start simulator: npm start"
echo "   • Build Docker: docker build -t simulator ."
echo "   • Run with Docker: docker run --env-file .env simulator" 