import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import serverListen from "../desktop/bounded-server-listen.cjs";

const { listenServerWithDeadline } = serverListen;

test("bounded server listen resolves and removes startup listeners", async () => {
  const server = fakeServer();
  const pending = listenServerWithDeadline(server, { port: 0, host: "127.0.0.1" });
  server.listenCallback();
  assert.deepEqual(await pending, { address: "127.0.0.1", port: 4317 });
  assert.equal(server.listenerCount("error"), 0);
  assert.equal(server.listenerCount("close"), 0);
});

test("bounded server listen rejects a close before callback", async () => {
  const server = fakeServer();
  const pending = listenServerWithDeadline(server);
  server.emit("close");
  await assert.rejects(pending, (error) => error.code === "SERVER_LISTEN_CLOSED");
});

test("bounded server listen timeout closes the unfinished server", async () => {
  const server = fakeServer();
  let fireTimeout;
  const timer = { unref() {} };
  const pending = listenServerWithDeadline(server, {
    timeoutMs: 5_000,
    setTimeoutFn(callback) {
      fireTimeout = callback;
      return timer;
    },
    clearTimeoutFn() {},
  });
  fireTimeout();
  await assert.rejects(pending, (error) => error.code === "SERVER_LISTEN_TIMEOUT");
  assert.equal(server.closeCalls, 1);
});

function fakeServer() {
  const server = new EventEmitter();
  server.closeCalls = 0;
  server.listen = (_port, _host, callback) => { server.listenCallback = callback; };
  server.address = () => ({ address: "127.0.0.1", port: 4317 });
  server.close = () => {
    server.closeCalls += 1;
    server.emit("close");
  };
  return server;
}
