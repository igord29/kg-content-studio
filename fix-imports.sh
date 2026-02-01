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
    echo -e "${YELLOW}Warning: $ROUTES_FILE not found${NC}"
    echo "File will be generated during build."
    exit 0
fi

# Make backup
cp "$ROUTES_FILE" "$ROUTES_FILE.backup"

# Fix import paths - match any quote style and 'from' syntax
sed -i "s|from '../agent/content-creator\.js'|from '../agent/content-creator/index.js'|g" "$ROUTES_FILE"
sed -i "s|from \"../agent/content-creator\.js\"|from \"../agent/content-creator/index.js\"|g" "$ROUTES_FILE"
sed -i "s|from '../agent/manager\.js'|from '../agent/manager/index.js'|g" "$ROUTES_FILE"
sed -i "s|from \"../agent/manager\.js\"|from \"../agent/manager/index.js\"|g" "$ROUTES_FILE"
sed -i "s|from '../agent/translate\.js'|from '../agent/translate/index.js'|g" "$ROUTES_FILE"
sed -i "s|from \"../agent/translate\.js\"|from \"../agent/translate/index.js\"|g" "$ROUTES_FILE"

# Check if any changes were made
if diff "$ROUTES_FILE" "$ROUTES_FILE.backup" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Import paths are already correct${NC}"
    rm "$ROUTES_FILE.backup"
else
    echo -e "${GREEN}✓ Successfully fixed import paths in routes.ts${NC}"
    echo ""
    echo "Fixed paths:"
    echo "  - content-creator.js → content-creator/index.js"
    echo "  - manager.js → manager/index.js"
    echo "  - translate.js → translate/index.js"
    rm "$ROUTES_FILE.backup"
fi

exit 0
