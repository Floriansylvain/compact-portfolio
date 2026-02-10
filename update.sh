#!/bin/bash

# Pull latest changes from git repository
echo "Pulling latest changes..."
git pull

# Check if git pull was successful
if [ $? -eq 0 ]; then
    echo "Git pull successful. Restarting compact-portfolio service..."
    sudo systemctl restart compact-portfolio.service

    # Check if service restart was successful
    if [ $? -eq 0 ]; then
        echo "Service restarted successfully."
    else
        echo "Failed to restart service."
        exit 1
    fi
else
    echo "Git pull failed. Service not restarted."
    exit 1
fi

echo "Deployment completed successfully!"