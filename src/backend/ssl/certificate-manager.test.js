const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const certificateManager = require('./certificate-manager');

const useDirectory = (directory) => Object.assign(certificateManager, {
  certDir: directory,
  caKeyPath: path.join(directory, 'ca.key'),
  caCertPath: path.join(directory, 'ca.crt'),
  serverKeyPath: path.join(directory, 'server.key'),
  serverCertPath: path.join(directory, 'server.crt')
});

const original = { ...certificateManager };
const withDirectory = async (run) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'certificate-manager-'));
  useDirectory(directory);
  try { return await run(directory); } finally {
    Object.assign(certificateManager, original);
    await fs.rm(directory, { recursive: true, force: true });
  }
};

test('generated CA and server certificate form a verifiable chain with the requested SANs', async () => {
  await withDirectory(async () => {
    const sans = ['localhost', '192.168.1.5', '::1', 'beef', 'files.example.com'];
    const result = await certificateManager.generateFullCertificateSet(sans);
    assert.equal(result.success, true, result.message);

    const ca = new crypto.X509Certificate(await fs.readFile(certificateManager.caCertPath));
    const server = new crypto.X509Certificate(await fs.readFile(certificateManager.serverCertPath));
    assert.equal(ca.ca, true);
    assert.equal(server.ca, false);
    assert.equal(server.checkIssued(ca), true);
    assert.equal(server.verify(ca.publicKey), true, 'server certificate signature verifies against the CA key');
    assert.equal(ca.verify(ca.publicKey), true, 'CA is self-signed');
    assert.equal(server.issuer, ca.subject);
    assert.match(server.subject, /CN=File Transfer Server/);
    assert.notEqual(server.serialNumber, ca.serialNumber);
    assert.ok(Number.parseInt(server.serialNumber.slice(0, 2), 16) < 0x80, 'serial is a positive DER integer');
    assert.equal(server.publicKey.asymmetricKeyDetails.modulusLength, 2048);
    assert.equal(server.keyUsage?.includes('1.3.6.1.5.5.7.3.1'), true, 'serverAuth extended key usage');

    // Host names that only contain hex digits stay DNS names, not IP addresses.
    assert.deepEqual((await certificateManager.extractSANs(certificateManager.serverCertPath)).sort(), [...sans].sort());
    assert.match(server.subjectAltName, /DNS:beef/);
    assert.match(server.subjectAltName, /IP Address:192\.168\.1\.5/);
    assert.equal(server.checkHost('files.example.com'), 'files.example.com');
    assert.equal(server.checkIP('192.168.1.5'), '192.168.1.5');
    assert.equal(server.checkIP('192.168.1.6'), undefined);

    const expiration = await certificateManager.getCertificateExpiration(certificateManager.serverCertPath);
    assert.ok(expiration instanceof Date);
    const years = (expiration - new Date()) / (365.25 * 24 * 3600 * 1000);
    assert.ok(years > 9.9 && years < 10.1, `validity ${years}`);
    assert.equal(certificateManager.isExpired(expiration), false);
    assert.equal(certificateManager.isExpiringSoon(expiration, 90), false);

    const mode = (await fs.stat(certificateManager.serverKeyPath)).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600);
    assert.match(await fs.readFile(certificateManager.serverKeyPath, 'utf8'), /^-----BEGIN RSA PRIVATE KEY-----/);
  });
});

test('a real TLS handshake trusts the server certificate only through the generated CA', async () => {
  await withDirectory(async () => {
    assert.equal((await certificateManager.generateFullCertificateSet(['localhost', '127.0.0.1'])).success, true);
    const [key, cert, ca] = await Promise.all([certificateManager.serverKeyPath, certificateManager.serverCertPath, certificateManager.caCertPath].map(file => fs.readFile(file)));
    const server = https.createServer({ key, cert }, (request, response) => response.end('secure'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const request = (options) => new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', servername: 'localhost', port: server.address().port, agent: false, ...options }, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve(body));
      }).on('error', reject);
    });
    try {
      assert.equal(await request({ ca }), 'secure');
      await assert.rejects(request({}), /self-signed|unable to (get|verify)/i);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});

test('renewal re-signs with the existing CA and keeps the CA untouched', async () => {
  await withDirectory(async () => {
    await certificateManager.generateFullCertificateSet(['localhost']);
    const caBefore = await fs.readFile(certificateManager.caCertPath, 'utf8');
    const serialBefore = new crypto.X509Certificate(await fs.readFile(certificateManager.serverCertPath)).serialNumber;
    const renewed = await certificateManager.renewServerCertificate(['localhost', '10.0.0.8']);
    assert.equal(renewed.success, true, renewed.message);
    assert.equal(await fs.readFile(certificateManager.caCertPath, 'utf8'), caBefore);
    const server = new crypto.X509Certificate(await fs.readFile(certificateManager.serverCertPath));
    assert.notEqual(server.serialNumber, serialBefore);
    assert.equal(server.verify(new crypto.X509Certificate(caBefore).publicKey), true);
    assert.deepEqual((await certificateManager.extractSANs(certificateManager.serverCertPath)).sort(), ['10.0.0.8', 'localhost']);
  });
});

test('renewal accepts a CA key stored as PKCS#8 as well as PKCS#1', async () => {
  await withDirectory(async () => {
    await certificateManager.generateFullCertificateSet(['localhost']);
    const keyObject = crypto.createPrivateKey(await fs.readFile(certificateManager.caKeyPath));
    await fs.writeFile(certificateManager.caKeyPath, keyObject.export({ type: 'pkcs8', format: 'pem' }));
    const renewed = await certificateManager.renewServerCertificate(['localhost']);
    assert.equal(renewed.success, true, renewed.message);
  });
});

test('missing or unreadable files report null expiry, empty SANs and failed renewal', async () => {
  await withDirectory(async directory => {
    assert.deepEqual(await certificateManager.certificatesExist(), { ca: false, server: false });
    assert.equal(await certificateManager.getCertificateExpiration(path.join(directory, 'none.crt')), null);
    assert.deepEqual(await certificateManager.extractSANs(path.join(directory, 'none.crt')), []);
    assert.equal((await certificateManager.renewServerCertificate(['localhost'])).success, false);
    await fs.writeFile(certificateManager.serverCertPath, 'not a certificate');
    assert.equal(await certificateManager.getCertificateExpiration(certificateManager.serverCertPath), null);
  });
});

test('certificates previously issued by node-forge remain readable and can be renewed', async (t) => {
  const fixture = path.join(__dirname, 'fixtures/forge-legacy');
  const exists = await fs.access(fixture).then(() => true, () => false);
  if (!exists) return t.skip('legacy fixture not present');
  await withDirectory(async directory => {
    for (const name of ['ca.key', 'ca.crt', 'server.key', 'server.crt']) await fs.copyFile(path.join(fixture, name), path.join(directory, name));
    assert.deepEqual((await certificateManager.extractSANs(certificateManager.serverCertPath)).sort(), ['192.168.1.5', '::1', 'fs.example.com', 'localhost'].sort());
    assert.ok((await certificateManager.getCertificateExpiration(certificateManager.caCertPath)) instanceof Date);
    const renewed = await certificateManager.renewServerCertificate(['localhost', '192.168.1.5']);
    assert.equal(renewed.success, true, renewed.message);
    const ca = new crypto.X509Certificate(await fs.readFile(certificateManager.caCertPath));
    const server = new crypto.X509Certificate(await fs.readFile(certificateManager.serverCertPath));
    assert.equal(server.checkIssued(ca), true);
    assert.equal(server.verify(ca.publicKey), true);
  });
});
