// Tiny static server for the game directory: some browsers restrict
// localStorage on file:// URLs, and the game page loads its CSS/JS
// via relative URLs.
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export interface ServedDir {
  server: Server;
  url: string;
}

export function serveDir(dir: string): Promise<ServedDir> {
  const root = path.resolve(dir);
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const rel = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
        const safe = path.normalize(rel).replace(/^([.][.][/\\])+/, "");
        let file = path.resolve(root, "." + safe);
        if (!file.startsWith(root)) file = path.join(root, "index.html");
        if (safe.endsWith("/") || path.extname(file) === "") file = path.join(file, "index.html");
        const type = TYPES[path.extname(file)] ?? "application/octet-stream";
        const body = await readFile(file);
        res.writeHead(200, { "content-type": type });
        res.end(body);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no server address");
      resolve({ server, url: `http://127.0.0.1:${addr.port}/` });
    });
  });
}
