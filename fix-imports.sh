#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ROUTES_FILE="src/generated/routes.ts"

echo "Checking import paths in routes.ts..."

# Check if file exists
if [ ! -f "$ROUTES_FILE" ]; then
    echo -e "${RED}Error: $ROUTES_FILE not found${NC}"
    echo "Make sure you're running this from the project root directory."
    exit 1
fi

# Check if paths are already correct
if grep -q "'../agent/content-creator/index.js'" "$ROUTES_FILE" && \
   grep -q "'../agent/manager/index.js'" "$ROUTES_FILE" && \
   grep -q "'../agent/translate/index.js'" "$ROUTES_FILE"; then
    echo -e "${GREEN}✓ Import paths are already correct${NC}"
    exit 0
fi

# Make backup
cp "$ROUTES_FILE" "$ROUTES_FILE.backup"
echo "Created backup: $ROUTES_FILE.backup"

# Fix import paths
sed -i "s|'../agent/content-creator.js'|'../agent/content-creator/index.js'|g" "$ROUTES_FILE"
sed -i "s|'../agent/manager.js'|'../agent/manager/index.js'|g" "$ROUTES_FILE"
sed -i "s|'../agent/translate.js'|'../agent/translate/index.js'|g" "$ROUTES_FILE"

# Verify changes
if grep -q "'../agent/content-creator/index.js'" "$ROUTES_FILE" && \
   grep -q "'../agent/manager/index.js'" "$ROUTES_FILE" && \
   grep -q "'../agent/translate/index.js'" "$ROUTES_FILE"; then
    echo -e "${GREEN}✓ Successfully fixed import paths in routes.ts${NC}"
    echo ""
    echo "Fixed paths:"
    echo "  - content-creator.js → content-creator/index.js"
    echo "  - manager.js → manager/index.js"
    echo "  - translate.js → translate/index.js"
    rm "$ROUTES_FILE.backup"
    exit 0
else
    echo -e "${RED}✗ Failed to fix import paths${NC}"
    echo "Restoring backup..."
    mv "$ROUTES_FILE.backup" "$ROUTES_FILE"
    exit 1
fi
