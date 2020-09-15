FROM node:10-alpine

RUN apk add --no-cache g++ make python2

WORKDIR /home/node/app
COPY src /home/node/app/src
COPY package.json /home/node/app/
COPY package-lock.json /home/node/app/
COPY tsconfig.json /home/node/app/

RUN npm ci
RUN npm run build

ENTRYPOINT ['npm', 'start']
