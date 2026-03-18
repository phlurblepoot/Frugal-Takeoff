FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including devDependencies for building)
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the Vite frontend
RUN npm run build

# Set environment variables for production
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

# Create data directory and set permissions
RUN mkdir -p /app/data && chown -R node:node /app

# Switch to non-root user for security
USER node

# Expose the port the app runs on
EXPOSE 3000

# Start the server using tsx
CMD ["npx", "tsx", "server.ts"]
