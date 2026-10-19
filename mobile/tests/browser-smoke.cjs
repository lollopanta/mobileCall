const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const webDir = path.resolve(process.argv[2] || path.join(__dirname, '../dist'));
const python = process.env.PYTHON || path.resolve(__dirname, '../../server/.venv/bin/python');
const server = spawn(python, [path.resolve(__dirname, '../../server/tests/browser_fixture.py'), webDir], { stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
server.stderr.on('data', chunk => { logs += chunk; });
let browser;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function register(page, baseUrl, username) {
  await page.goto(baseUrl);
  await page.getByPlaceholder('Server Address (e.g. 192.168.1.5 or my.server.com)').fill(baseUrl);
  await page.getByText("Don't have an account? Register", { exact: true }).click();
  await page.getByPlaceholder('Username', { exact: true }).fill(username);
  await page.getByPlaceholder('Password', { exact: true }).fill('smoke-test-password');
  const registration = page.waitForResponse(r => r.url() === `${baseUrl}/register` && r.request().method() === 'POST');
  await page.getByText('REGISTER', { exact: true }).click();
  assert.equal((await registration).status(), 200);
  await page.getByText('LOGIN', { exact: true }).click();
  await page.getByText('Online Family Members', { exact: true }).waitFor();
}
async function instrument(page) {
  page.on('dialog', dialog => dialog.dismiss());
  await page.addInitScript(() => {
    window.__signals = [];
    const Socket = window.WebSocket;
    const record = (direction, raw) => {
      if (typeof raw !== 'string' || !raw.startsWith('42')) return;
      try { window.__signals.push({ direction, event: JSON.parse(raw.slice(2)) }); } catch {}
    };
    window.WebSocket = class extends Socket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => record('in', event.data));
      }
      send(data) { record('out', data); return super.send(data); }
    };
    window.__peers = [];
    window.__streams = [];
    const Peer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(...args) { super(...args); window.__peers.push(this); }
    };
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await getMedia(constraints);
      window.__streams.push(stream);
      return stream;
    };
  });
}
async function hasMedia(page, video) {
  return page.evaluate(async video => {
    const peer = window.__peers.findLast(p => p.connectionState === 'connected');
    if (!peer) return false;
    const reports = [...(await peer.getStats()).values()];
    return ['audio', ...(video ? ['video'] : [])].every(kind => reports.some(r => r.type === 'inbound-rtp' && r.kind === kind && r.bytesReceived > 0));
  }, video);
}
async function mediaReleased(page) {
  return page.evaluate(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === 'ended')) && window.__peers.every(p => p.connectionState === 'closed'));
}

(async () => {
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture did not start')), 15000);
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/\{"baseUrl":\s*"([^"]+)"\}/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs}`)); });
  });
  await until(async () => { try { return (await fetch(`${baseUrl}/api/ping`)).ok; } catch { return false; } }, 'API readiness');
  browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1100, height: 850 } })));
  const [alice, bob] = await Promise.all(contexts.map(c => c.newPage()));
  const errors = [];
  for (const page of [alice, bob]) {
    page.on('pageerror', error => errors.push(error.message));
    await instrument(page);
  }
  await register(alice, baseUrl, 'browser-alice');
  await register(bob, baseUrl, 'browser-bob');
  console.log('PASS: registration and login for two isolated users');
  await alice.getByText('Family', { exact: true }).click();
  await alice.getByPlaceholder('Family Name', { exact: true }).fill('Browser Test Family');
  await alice.getByText('Create New Family', { exact: true }).click();
  await until(() => alice.evaluate(() => Boolean(JSON.parse(localStorage.getItem('mobilecall_user_profile'))?.family_id)), 'family creation');
  const aliceToken = await alice.evaluate(() => localStorage.getItem('mobilecall_auth_token'));
  const invitation = await fetch(`${baseUrl}/api/family/invite`, { method: 'POST', headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'browser-bob' }) });
  assert.equal(invitation.status, 200);
  await bob.getByText('Inbox', { exact: true }).click();
  await bob.getByText('Grandparent', { exact: true }).click();
  await bob.getByText('Accept', { exact: true }).click();
  await until(() => bob.evaluate(() => Boolean(JSON.parse(localStorage.getItem('mobilecall_user_profile'))?.family_id)), 'invitation acceptance');
  await alice.getByText('Calls', { exact: true }).click();
  await bob.getByText('Calls', { exact: true }).click();
  await alice.getByLabel('Video call browser-bob', { exact: true }).waitFor();
  await bob.getByLabel('Video call browser-alice', { exact: true }).waitFor();
  console.log('PASS: family creation, invitation acceptance and automatic presence');
  for (const video of [true, false]) {
    await alice.evaluate(() => { window.__signals = []; });
    await alice.getByLabel(`${video ? 'Video call' : 'Call'} browser-bob`, { exact: true }).click();
    await bob.getByText('Incoming Call from', { exact: true }).waitFor();
    await bob.getByLabel('Accept call', { exact: true }).click();
    await until(async () => (await hasMedia(alice, video)) && (await hasMedia(bob, video)), `bidirectional ${video ? 'video/audio' : 'audio'} RTP`, 30000);
    const correctIceRouting = await alice.evaluate(() => {
      const session = window.__signals.find(s => s.direction === 'in' && s.event[0] === 'call-session-started')?.event[1];
      const ice = window.__signals.filter(s => s.direction === 'out' && s.event[0] === 'ice-candidate');
      return session && ice.length > 0 && ice.every(s => s.event[1].to === session.controllerSid);
    });
    assert.equal(correctIceRouting, true, 'Trickled ICE must target the selected socket, not a user ID');
    await alice.getByLabel('End call', { exact: true }).click();
    await bob.getByText('Online Family Members', { exact: true }).waitFor();
    await until(async () => (await mediaReleased(alice)) && (await mediaReleased(bob)), 'media and connection cleanup');
    console.log(`PASS: ${video ? 'video/audio' : 'audio'} call, received RTP in both browsers, hangup and media cleanup`);
  }
  await bob.reload();
  await bob.getByText('Online Family Members', { exact: true }).waitFor();
  await alice.getByLabel('Video call browser-bob', { exact: true }).click();
  await bob.getByLabel('Decline call', { exact: true }).click();
  await alice.getByText('Online Family Members', { exact: true }).waitFor();
  await until(async () => (await mediaReleased(alice)) && (await mediaReleased(bob)), 'declined call cleanup');
  await alice.getByLabel('Log out', { exact: true }).click();
  await alice.getByText('LOGIN', { exact: true }).waitFor();
  assert.equal(await alice.evaluate(() => localStorage.getItem('mobilecall_auth_token')), null);
  assert.deepEqual(errors, []);
  console.log('PASS: declined call, logout, no uncaught browser errors');
})().catch(error => { console.error(error); console.error(logs.slice(-6000)); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  server.kill('SIGTERM');
});
