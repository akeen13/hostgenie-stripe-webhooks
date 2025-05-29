# Use an official Node.js runtime as a parent image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (or yarn.lock or pnpm-lock.yaml)
COPY package*.json ./

# Install app dependencies
# If using npm:
RUN npm install --only=production
# If using yarn:
# RUN yarn install --production --frozen-lockfile
# If using pnpm:
# RUN pnpm install --prod --frozen-lockfile

# Bundle app source
COPY . .

# Railway injects the PORT environment variable
# EXPOSE $PORT
# If running locally or on a platform that doesn't inject PORT,
# you might want to expose a default like 3003
EXPOSE 3003

# Define the command to run your app
CMD [ "node", "index.js" ]