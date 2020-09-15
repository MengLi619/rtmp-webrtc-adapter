import * as mediasoup from 'mediasoup';
import * as express from 'express';
import * as http from 'http';
import * as socketIO from 'socket.io';
import * as child_process from 'child_process';
import { raw } from 'express';

interface Source {
  name: string;
  rtmpUrl: string;
}

const PORT = process.env.PORT || 3000;
const RTC_MIN_PORT = Number(process.env.RTC_MIN_PORT || 30000);
const RTC_MAX_PORT = Number(process.env.RTC_MIN_PORT || 31000);

let expressApp: express.Express;
let httpServer: http.Server;
let socketServer: socketIO.Server;
let webRtcWorker: mediasoup.types.Worker;
let mediasoupRouter: mediasoup.types.Router;

const consumerTransports = new Map<string, mediasoup.types.WebRtcTransport>();
const socketTransports = new Map<string, mediasoup.types.WebRtcTransport>();
const consumers = new Map<string, mediasoup.types.Consumer>();
const producerTransports = new Map<string, mediasoup.types.PlainRtpTransport>();
const producers = new Map<string, mediasoup.types.Producer>();
const sources: Source[] = [];

function generateSSRC() {
  return Math.trunc(Math.random() * 10000);
}

(async () => {
  await runExpressApp();
  await runSocketServer();
  await runMediasoupWorker();
})();

async function runExpressApp() {
  expressApp = express();
  expressApp.use(express.json());

  httpServer = http.createServer(expressApp);
  return new Promise((resolve) => {
    httpServer.listen(PORT, () => {
      console.log(`server is running at https://localhost:${PORT}`);
      resolve();
    });
  });
}

async function runSocketServer() {
  socketServer = socketIO(httpServer, {
    serveClient: false,
    path: '/server',
  });
  socketServer.on('connection', (socket) => {
    console.log('client connected');

    socket.on('disconnect', () => {
      console.log('client disconnected');
      const transport = socketTransports.get(socket.id);
      if (transport) {
        console.log(`close transport ${transport.id}`);
        transport.close();
      }
    });

    socket.on('connect_error', (err) => {
      console.error('client connection error', err);
    });

    socket.on('createSource', async (data, callback) => {
      console.log(`createSource ${JSON.stringify(data)}`);
      const source = data as Source;
      if (!sources.find(s => s.name === source.name)) {
        await createSource(source)
        sources.push(source);
      }
      callback();
    });

    socket.on('getRouterRtpCapabilities', (data, callback) => {
      console.log(`getRouterRtpCapabilities ${JSON.stringify(data)}`);
      callback(mediasoupRouter.rtpCapabilities);
    });

    socket.on('createConsumerTransport', async (data, callback) => {
      console.log(`createConsumerTransport ${JSON.stringify(data)}`);
      const { transport, params } = await createWebRtcTransport();
      consumerTransports.set(transport.id, transport);
      socketTransports.set(socket.id, transport);
      callback(params);
    });

    socket.on('connectConsumerTransport', async (data, callback) => {
      console.log(`connectConsumerTransport ${JSON.stringify(data)}`);
      const { transportId } = data;
      const consumerTransport = consumerTransports.get(transportId);
      if (!consumerTransport) {
        throw new Error(`consumer transport ${transportId} not found`);
      }
      await consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });

    socket.on('consume', async (data, callback) => {
      console.log(`consume ${JSON.stringify(data)}`);
      const { source, transportId } = data;
      const producer = producers.get(source) as mediasoup.types.Producer;
      const consumerTransport = consumerTransports.get(transportId);
      if (!consumerTransport) {
        throw new Error(`consumer transport ${transportId} not found`);
      }
      const consumer = await createConsumer(producer, consumerTransport, data.rtpCapabilities);
      consumers.set(consumer.id, consumer);
      callback({
        producerId: producer.id,
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused
      });
    });

    socket.on('resume', async (data, callback) => {
      console.log(`resume ${JSON.stringify(data)}`);
      const { consumerId } = data;
      const consumer = consumers.get(consumerId);
      if (!consumer) {
        throw new Error(`consumer ${consumerId} not found`);
      }
      await consumer.resume();
      callback();
    });
  });
}

async function runMediasoupWorker() {
  webRtcWorker = await mediasoup.createWorker({
    rtcMinPort: RTC_MIN_PORT,
    rtcMaxPort: RTC_MAX_PORT,
  });
  mediasoupRouter = await webRtcWorker.createRouter({
    mediaCodecs: [
      {
        kind: 'video' as mediasoup.types.MediaKind,
        mimeType: 'video/H264',
        clockRate: 90000
      }
    ],
  });
}

async function createWebRtcTransport() {
  const transport = await mediasoupRouter.createWebRtcTransport({
    listenIps: ['127.0.0.1'],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });
  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    },
  };
}

async function createConsumer(
  producer: mediasoup.types.Producer,
  consumerTransport: mediasoup.types.WebRtcTransport,
  rtpCapabilities: mediasoup.types.RtpCapabilities
) {
  if (!mediasoupRouter.canConsume(
    {
      producerId: producer.id,
      rtpCapabilities,
    })
  ) {
    throw new Error('can not consume');
  }
  return consumerTransport.consume({
    producerId: producer.id,
    rtpCapabilities,
    paused: producer.kind === 'video',
  });
}

async function createSource(source: Source) {
  const transport = await mediasoupRouter.createPlainTransport({
    listenIp: '0.0.0.0',
    rtcpMux: false,
    comedia: true
  });

  const ssrc = generateSSRC();
  const payloadType = 102;
  const producer = await transport.produce({
    kind: 'video',
    rtpParameters: {
      codecs: [
        {
          mimeType: 'video/H264',
          clockRate: 90000,
          payloadType: payloadType,
        }
      ],
      encodings: [
        {
          ssrc: ssrc,
        }
      ]
    }
  });
  producerTransports.set(source.name, transport);
  producers.set(source.name, producer);

  const args = [
    '-analyzeduration', '20M',
    '-i', `${source.rtmpUrl}`,
    '-map', '0:v:0',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-tune', 'zerolatency',
    '-preset', 'ultrafast',
    '-f', 'tee',
    `"[select=v:f=rtp:ssrc=${ssrc}:payload_type=${payloadType}]rtp://127.0.0.1:${transport.tuple.localPort}?rtcpport=${transport.rtcpTuple?.localPort}"`,
  ];

  console.log(`Executing ffmpeg ${args.join(' ')}`);
  const process = child_process.spawn('ffmpeg', args, { shell: true });

  process.stderr.on('data', data => {
    console.warn(`[${source.name}] ${data.toString()}`);
  });

  process.on('exit', () => {
    console.log(`process exit: ${source}`);
  });
}
