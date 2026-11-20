import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureHostCertificateBundle,
  hostCertificateBundle,
} from '../main/system-certificates.mjs';

const paths = [
  '/run/host/etc/ssl/certs/ca-certificates.crt',
  '/run/host/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
  '/run/host/etc/pki/tls/certs/ca-bundle.crt',
  '/run/host/etc/ssl/ca-bundle.pem',
  '/run/host/etc/ssl/cert.pem',
];

test('host certificate discovery selects the first readable PEM bundle', () => {
  const reads = [];
  const selected = hostCertificateBundle((path) => {
    reads.push(path);
    if (path === paths[0]) throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
    if (path === paths[1]) return 'not a certificate bundle';
    if (path === paths[2]) return '-----BEGIN CERTIFICATE-----\nsynthetic';
    throw new Error('Should not read later paths');
  });
  assert.equal(selected, paths[2]);
  assert.deepEqual(reads, paths.slice(0, 3));
});

test('host certificate discovery returns undefined when no bundle is usable', () => {
  assert.equal(
    hostCertificateBundle(() => {
      throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
    }),
    undefined,
  );
  assert.equal(hostCertificateBundle(() => 'no PEM data'), undefined);
});

test('Flatpak host CA selection sets SSL_CERT_FILE without replacing an override', () => {
  const env = { FLATPAK_ID: 'io.n8n.Nod' };
  assert.equal(configureHostCertificateBundle(env, (path) => {
    if (path === paths[0]) return '-----BEGIN CERTIFICATE-----\nsynthetic';
    throw new Error('Unexpected path');
  }), paths[0]);
  assert.equal(env.SSL_CERT_FILE, paths[0]);

  const existing = { FLATPAK_ID: 'io.n8n.Nod', SSL_CERT_FILE: '/custom/ca.pem' };
  assert.equal(configureHostCertificateBundle(existing, () => assert.fail('Must preserve override')), undefined);
  assert.equal(existing.SSL_CERT_FILE, '/custom/ca.pem');
});

test('host CA selection does not affect non-Flatpak installations', () => {
  const env = { FLATPAK_ID: 'another.app' };
  assert.equal(configureHostCertificateBundle(env, () => assert.fail('Must not inspect host')), undefined);
  assert.equal(env.SSL_CERT_FILE, undefined);
});
