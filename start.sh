#!/bin/bash

# Create .dev.vars file from environment variables
echo "# Auto-generated .dev.vars file" > .dev.vars

# Loop through all environment variables
env | while read -r line; do
  # Skip variables that are Docker/system specific
  if [[ ! $line =~ ^(PATH|PWD|HOME|HOSTNAME|NODE_|npm_|YARN_|TERM|SHLVL|_).*$ ]]; then
    echo "$line" >> .dev.vars
  fi
done

# Log that environment variables were processed
echo "Environment variables have been written to .dev.vars"

# Start wrangler with the local environment variables
exec wrangler dev --host 0.0.0.0 --port 8787 --local --persist-to .mf
