import { createServer } from "node:http";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { openDatabase } from "./db.js";
import { createRouter } from "./api.js";

export async function startServer(dbPath = process.env.WAFER_DB ?? "data/wafer.sqlite", preferredPort = Number(process.env.PORT ?? 0)): Promise<{ close: () => void; port: number }> {
  const db = openDatabase(dbPath);
  const server = createServer(createRouter(db));
  await once(server.listen(preferredPort, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
  return { port: address.port, close: () => server.close(() => db.close()) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startServer();
  console.log(`wafer API listening on http://127.0.0.1:${server.port}`);
}
