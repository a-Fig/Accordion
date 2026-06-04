#!/usr/bin/env node
/*
 * serve.js — zero-dependency static server for the Accordion visualizer.
 * Usage:  node serve.js [port]      (default 8080)
 * Then open the printed URL. Serving (vs double-clicking) lets the page
 * fetch the sample sessions in ./samples/.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = process.env.PORT || process.argv[2] || 8080;
const mime = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".jsonl": "application/x-ndjson; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".woff": "font/woff",
};

http
	.createServer((req, res) => {
		let p = decodeURIComponent(req.url.split("?")[0]);
		if (p === "/") p = "/index.html";
		const fp = path.join(root, path.normalize(p));
		if (fp !== root && !fp.startsWith(root + path.sep)) { res.writeHead(403); return res.end("forbidden"); }
		fs.readFile(fp, (err, data) => {
			if (err) { res.writeHead(404); return res.end("not found"); }
			res.writeHead(200, { "Content-Type": mime[path.extname(fp)] || "application/octet-stream", "Cache-Control": "no-store" });
			res.end(data);
		});
	})
	.listen(port, () => console.log(`Accordion visualizer → http://localhost:${port}`));
