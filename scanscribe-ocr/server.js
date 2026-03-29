import "dotenv/config";

import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import compression from "compression";
import express from "express";
import helmet from "helmet";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

const trustProxy = Number.parseInt(process.env.TRUST_PROXY ?? "0", 10);

if (trustProxy > 0) {
  app.set("trust proxy", trustProxy);
}

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "blob:", "https://cdn.jsdelivr.net"],
        workerSrc: ["'self'", "blob:", "https://cdn.jsdelivr.net"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  })
);

app.use(compression());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    app: process.env.APP_NAME || "ScanScribe OCR",
    mode: "static-ocr",
    timestamp: new Date().toISOString()
  });
});

app.get("*", (_request, response) => {
  response.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST || "0.0.0.0";

httpServer.listen(port, host, () => {
  console.log(`${process.env.APP_NAME || "ScanScribe OCR"} running on http://${host}:${port}`);
});
