import { openDb } from "./db";
import { createServer } from "./api";
import { config } from "./config";

const db = openDb(config.dbPath);
const server = createServer(db);
server.listen(config.port, "127.0.0.1", () => {
  const addr = server.address() as { port: number };
  console.log(`wafer-yield backend listening on http://127.0.0.1:${addr.port} (db=${config.dbPath})`);
});
process.on("SIGINT", () => { server.close(); db.close(); process.exit(0); });
