#!/bin/bash

# Create stub .js files that TypeScript expects during build
# These will be replaced by the actual build output

echo "Creating stub files for TypeScript..."

mkdir -p src/agent

# Create stub files that re-export from index.js
cat > src/agent/content-creator.js << 'EOF'
// Stub file for TypeScript - will be replaced by build
export * from './content-creator/index.js';
export { default } from './content-creator/index.js';
EOF

cat > src/agent/manager.js << 'EOF'
// Stub file for TypeScript - will be replaced by build
export * from './manager/index.js';
export { default } from './manager/index.js';
EOF

cat > src/agent/translate.js << 'EOF'
// Stub file for TypeScript - will be replaced by build
export * from './translate/index.js';
export { default } from './translate/index.js';
EOF

echo "✓ Stub files created"
exit 0
