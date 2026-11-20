import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

export function hostCertificateBundle(read = readFileSync) {
  const paths = [
    '/run/host/etc/ssl/certs/ca-certificates.crt',
    '/run/host/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
    '/run/host/etc/pki/tls/certs/ca-bundle.crt',
    '/run/host/etc/ssl/ca-bundle.pem',
    '/run/host/etc/ssl/cert.pem',
  ];
  for (const path of paths) {
    try {
      if (read(path, 'utf8').includes('-----BEGIN CERTIFICATE-----')) return path;
    } catch {}
  }
}

export function trustSystemCertificates(tls = { getCACertificates, setDefaultCACertificates }) {
  const now = Date.now();
  const system = tls.getCACertificates('system').filter((cert) => {
    try {
      return new X509Certificate(cert).validToDate.getTime() > now;
    } catch {
      return true;
    }
  });
  if (!system.length) return;
  tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...system])]);
}
