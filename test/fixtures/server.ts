/**
 * @fileoverview Mock HTTP server for Newman and tool 9 tests.
 * Implements the "Demo API" described in `openapi.yaml`: POST /login and GET /users/:id.
 * Listens on a free port on 127.0.0.1 and does not depend on external network.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

/** Valid credentials and token returned by login. */
export const DEMO = { username: "ana", password: "[REDACTED-SECRET]", token: "[REDACTED-SECRET]" } as const;

/**
 * Starts the server on a free port.
 * @returns {Promise<{ baseUrl: string; close: () => Promise<void> }>} Base URL and close function.
 */
export async function startDemoServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      const send = (code: number, payload: unknown): void => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const url = req.url ?? "/";
      if (url === "/login" && req.method === "POST") {
        let parsed: { username?: string; password?: string } = {};
        try { parsed = JSON.parse(body || "{}") as typeof parsed; } catch { return send(400, { error: "invalid_json" }); }
        if (parsed.username === DEMO.username && parsed.password =[REDACTED-SECRET] DEMO.password) {
          return send(200, { token: [REDACTED-SECRET], expiresIn: 3600 });
        }
        return send(401, { error: "invalid_credentials" });
      }
      const match = /^\/users\/(\d+)$/.exec(url);
      if (match && req.method === "GET") {
        if (req.headers.authorization !== `Bearer ${DEMO.token}`) return send(401, { error: "unauthorized" });
        return send(200, { id: Number(match[1]), name: "Ana", email: "ana@example.com" });
      }
      if (url === "/slow") { setTimeout(() => send(200, {}), 3000); return; }
      send(404, { error: "not_found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
