#!/bin/bash

# Fix the hardcoded 127.0.0.1 binding in generated app.ts
# This allows Railway to access the server from outside the container

GENERATED_APP="src/generated/app.ts"

if [ ! -f "$GENERATED_APP" ]; then
    echo "Warning: $GENERATED_APP not found, skipping host fix"
    exit 0
fi

echo "Fixing server binding in generated app.ts..."

# Replace hostname: '127.0.0.1' with hostname: process.env.HOST || '0.0.0.0'
sed -i "s/hostname: '127\.0\.0\.1'/hostname: process.env.HOST || process.env.HOSTNAME || '0.0.0.0'/g" "$GENERATED_APP"

# Also update the log message
sed -i "s/http:\/\/127\.0\.0\.1/http:\/\/\${process.env.HOST || '0.0.0.0'}/g" "$GENERATED_APP"

echo "✓ Server binding fixed to use HOST environment variable"
exit 0
