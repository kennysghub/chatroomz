import { randomUUID } from "crypto";
import dotenv from "dotenv";
import fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyIO from "fastify-socket.io";
import Redis from "ioredis";
import closeWithGrace from "close-with-grace";
dotenv.config();

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "0.0.0.0";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

const REDIS_ENDPOINT = process.env.REDIS_ENDPOINT;

const CONNECTION_COUNT_KEY = "chat:connection-count";
const CONNECTION_COUNT_UPDATED_CHANNEL = "chat:connection-count-updated";
const NEW_MESSAGE_CHANNEL = "chat:new-message";
// To persist messages
// const MESSAGES_KEY = 'chat:messages';
// function sendMessageToRoom({
//   room, messageContents
// }){
//   const channel = `chat:${room}:messages`

// }

if (!REDIS_ENDPOINT) {
  console.error("Missing REDIS_ENDPOINT");
  process.exit(1);
}
// 2 redis instances for publisher and subscriber
const publisher = new Redis(REDIS_ENDPOINT, {
  tls: {
    rejectUnauthorized: true,
  },
});
const subscriber = new Redis(REDIS_ENDPOINT);

let connectedClients = 0;

// Create an instance of Fastify
// Easier for testing because you don't actually have to start server for your tests
// Builds server, registers all the plugins and endpoints 0
async function buildServer() {
  const app = fastify();

  await app.register(fastifyCors, {
    origin: CORS_ORIGIN,
  });

  await app.register(fastifyIO);
  // const currentCount = await publisher.get(CONNECTION_COUNT_KEY);
  // if (!currentCount) {
  //   await publisher.set(CONNECTION_COUNT_KEY, 0);
  // }
  await publisher.set(CONNECTION_COUNT_KEY, 0);

  /* ------------------------------ User Connects ----------------------------- */
  app.io.on("connection", async (io) => {
    console.log("Client connected");
    // Increment count
    const incrResult = await publisher.incr(CONNECTION_COUNT_KEY);
    connectedClients++;
    await publisher.publish(
      CONNECTION_COUNT_UPDATED_CHANNEL,
      String(incrResult)
    );
    // Reusing channel between sockets and publishers (I'm lazy)
    io.on(NEW_MESSAGE_CHANNEL, async (payload) => {
      const message = payload.message;
      if (!message) {
        return;
      }
      // Publish to Redis channel
      // Message is going to be a buffer that needs to be converted to string.
      await publisher.publish(NEW_MESSAGE_CHANNEL, message.toString());
    });

    // Decrement Count
    io.on("disconnect", async () => {
      connectedClients--;
      const decrResult = await publisher.decr(CONNECTION_COUNT_KEY);
      await publisher.publish(
        CONNECTION_COUNT_UPDATED_CHANNEL,
        String(decrResult)
      );
    });
  });

  subscriber.subscribe(CONNECTION_COUNT_UPDATED_CHANNEL, (err, count) => {
    if (err) {
      console.error(
        `Error subscribing to${CONNECTION_COUNT_UPDATED_CHANNEL}`,
        err
      );
      return;
    }
    console.log(
      `${count} clients subscribed to ${CONNECTION_COUNT_UPDATED_CHANNEL} channel`
    );
  });

  subscriber.subscribe(NEW_MESSAGE_CHANNEL, (err, count) => {
    if (err) {
      console.error(`Error subscribing to ${NEW_MESSAGE_CHANNEL}`);
      return;
    }
    console.log(
      `${count} clients subscribed to ${NEW_MESSAGE_CHANNEL} channel:`
    );
  });

  // Once we're subscribed to channel, we're going to receive messages.
  subscriber.on("message", (channel, text) => {
    if (channel === CONNECTION_COUNT_UPDATED_CHANNEL) {
      // This is going to be the socket channel we're emitting to.
      app.io.emit(CONNECTION_COUNT_UPDATED_CHANNEL, {
        count: text,
      });
    }

    // If you want all the messages to have a diff id..
    if (channel === NEW_MESSAGE_CHANNEL) {
      app.io.emit(NEW_MESSAGE_CHANNEL, {
        message: text,
        id: randomUUID(), // Helpful for mapping over messages in React.
        createdAt: new Date(),
        port: PORT,
      });
      return;
    }

    return;
  });

  // Health check endpoint.
  app.get("/healthcheck", () => {
    return {
      status: "ok",
      port: PORT,
    };
  });
  return app;
}

// Starting the server
async function main() {
  const app = await buildServer();
  try {
    await app.listen({
      port: PORT,
      host: HOST,
    });

    closeWithGrace({ delay: 2000 }, async ({ signal, err }) => {
      if (connectedClients > 0) {
        const currentCount = parseInt(
          (await publisher.get(CONNECTION_COUNT_KEY)) || "0",
          10
        );

        const newCount = Math.max(currentCount - connectedClients, 0);
        await publisher.set(CONNECTION_COUNT_KEY, newCount);
      }
      await app.close();
    });

    console.log(`Server started at http://${HOST}:${PORT}`);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

main();
