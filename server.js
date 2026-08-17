const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'dashboard.json');
const PORT = Number(process.env.PORT || 3000);
const clients = new Set();

function emptyState() {
  return { files: [], gipodCodes: [], revision: 0, updatedAt: null };
}

function readState() {
  try {
    return { ...emptyState(), ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read dashboard data:', error);
    return emptyState();
  }
}

function writeState(input) {
  const state = {
    files: Array.isArray(input.files) ? input.files : [],
    gipodCodes: Array.isArray(input.gipodCodes) ? input.gipodCodes : [],
    revision: readState().revision + 1,
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${DATA_FILE}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, DATA_FILE);
  return state;
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function broadcast(state) {
  const event = `event: dashboard\ndata: ${JSON.stringify(state)}\n\n`;
  for (const client of clients) client.write(event);
}

function serveFile(response, filePath, contentType) {
  fs.readFile(filePath, (error, body) => {
    if (error) return json(response, 404, { error: 'Not found' });
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    response.end(body);
  });
}

function createServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, readState());
    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      response.write(`event: dashboard\ndata: ${JSON.stringify(readState())}\n\n`);
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }
    if (request.method === 'PUT' && url.pathname === '/api/state') {
      let body = '';
      request.on('data', chunk => {
        body += chunk;
        if (body.length > 5_000_000) request.destroy();
      });
      request.on('end', () => {
        try {
          const state = writeState(JSON.parse(body));
          json(response, 200, state);
          broadcast(state);
        } catch {
          json(response, 400, { error: 'The dashboard update was not valid JSON.' });
        }
      });
      return;
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveFile(response, path.join(ROOT, 'index.html'), 'text/html; charset=utf-8');
    }
    json(response, 404, { error: 'Not found' });
  });
}

if (require.main === module) createServer().listen(PORT, () => console.log(`Trials Dashboard running at http://localhost:${PORT}`));

module.exports = { createServer, emptyState };
