FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
# Fonts with full Vietnamese coverage (SIL Open Font License), fetched at build time.
RUN mkdir -p fonts \
 && wget -q -O fonts/PatrickHand-Regular.ttf https://raw.githubusercontent.com/google/fonts/main/ofl/patrickhand/PatrickHand-Regular.ttf \
 && wget -q -O fonts/BeVietnamPro-Regular.ttf https://raw.githubusercontent.com/google/fonts/main/ofl/bevietnampro/BeVietnamPro-Regular.ttf \
 && wget -q -O fonts/BeVietnamPro-Bold.ttf https://raw.githubusercontent.com/google/fonts/main/ofl/bevietnampro/BeVietnamPro-Bold.ttf
COPY card.js server.js ./
USER node
EXPOSE 3100
CMD ["node", "server.js"]
