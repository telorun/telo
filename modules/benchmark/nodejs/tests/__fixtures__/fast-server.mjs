// A subject far cheaper per request than the load generator: it answers every request with a
// canned response, without parsing HTTP, so a throughput pass against it is generator-bound.
import { createServer } from "node:net";

const response = "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: keep-alive\r\n\r\nok";
const server = createServer((socket) => {
  socket.on("data", (chunk) => {
    const requests = chunk.toString("latin1").split("\r\n\r\n").length - 1;
    socket.write(response.repeat(Math.max(1, requests)));
  });
  socket.on("error", () => socket.destroy());
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
