/**
 * Tiny HTTP "victim" server for SSRF e2e tests.
 *
 * Used as a stand-in for an internal/private service that should be unreachable
 * when the SSRF proxy is doing its job. After making a blocked request, the
 * test asserts that this server received zero hits — proving the request was
 * dropped at the proxy and never reached its target.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type VictimServer = {
  /** All requests received by this server */
  hits: { method: string; url: string; host: string }[];
  /** The URL on which the server is listening (e.g. http://127.0.0.1:12345) */
  url(): string;
  /** Just the port number */
  port(): number;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Clear the hits array (useful between test cases) */
  reset(): void;
};

export function createVictimServer(): VictimServer {
  const hits: VictimServer["hits"] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push({
      method: req.method ?? "GET",
      url: req.url ?? "",
      host: req.headers["host"] ?? "",
    });
    res.setHeader("Connection", "close");
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("VICTIM_REACHED");
  });

  let listenPort = 0;

  return {
    hits,
    port: () => listenPort,
    url: () => `http://127.0.0.1:${listenPort}`,
    start: (): Promise<void> =>
      new Promise((resolve, reject) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          listenPort = typeof addr === "object" && addr !== null ? addr.port : 0;
          resolve();
        });
        server.on("error", reject);
      }),
    stop: (): Promise<void> =>
      new Promise((resolve, reject) => {
        (server as { closeAllConnections?(): void }).closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    reset: () => {
      hits.length = 0;
    },
  };
}
