FROM node:22-bookworm-slim

# Install dependencies needed for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy the rest of the application code
COPY . .

# Build the frontend
RUN npm run build

# Set environment variables
ENV NODE_ENV=production
ENV STORAGE_PATH=/app/data
ENV PORT=3000

# Expose the port the app runs on
EXPOSE 3000

# Create the data directory
RUN mkdir -p /app/data

# Start the server
CMD ["npx", "tsx", "server.ts"]
