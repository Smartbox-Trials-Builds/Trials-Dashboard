const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trials-dashboard-'));
process.env.DATA_DIR = dataDir;
const { createServer } = require('../server');

test('stores dashboard state and returns it to another client', async t => {
  const server = createServer().listen(0);
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const update = { files: [{ id: 1, first: 'Ada' }], gipodCodes: [{ code: 'G-1', usedOn: '' }] };

  const savedResponse = await fetch(`${base}/api/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update)
  });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.revision, 1);
  assert.ok(saved.updatedAt);

  const loaded = await (await fetch(`${base}/api/state`)).json();
  assert.deepEqual(loaded.files, update.files);
  assert.deepEqual(loaded.gipodCodes, update.gipodCodes);
});

test('serves the application and rejects malformed updates', async t => {
  const server = createServer().listen(0);
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.match(await (await fetch(base)).text(), /Trials Dashboard/);
  assert.equal((await fetch(`${base}/api/state`, { method: 'PUT', body: '{' })).status, 400);
});
