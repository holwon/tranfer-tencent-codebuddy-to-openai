FROM node:20-alpine
WORKDIR /app
COPY proxy.js .
EXPOSE 8123
CMD ["node", "proxy.js"]
