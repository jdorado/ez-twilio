FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS runtime
WORKDIR /app
COPY package.json ez-plugin.json ez-deployment.json README.md SECURITY.md CONTRIBUTING.md CHANGELOG.md LICENSE THIRD_PARTY_NOTICES.md ./
COPY bin ./bin
COPY src ./src
COPY skills ./skills
RUN mkdir -p /state/twilio /plugins/twilio && chown -R node:node /app /state /plugins
USER node
CMD ["node", "/app/bin/ez-twilio.mjs", "serve"]
