# Private document scanner operations

## Scope

This step provisions only the production-grade malware-scanning half of the
passenger-document pipeline. It does **not** enable uploads.

The API must remain:

```
OBJECT_STORAGE_PROVIDER=DISABLED
MALWARE_SCANNER=DISABLED
```

until approved private S3-compatible storage, encryption-at-rest, backup and
retention are separately provisioned and reviewed.

## Runtime

- container: `euroteranga-clamav`
- image: pinned by digest in `infrastructure/plesk/documents/docker-compose.yml`
- host bind: `127.0.0.1:3310` only
- protocol: clamd `INSTREAM`
- signatures: persisted in Docker volume `euroteranga-clamav-db`
- restart policy: `unless-stopped`

No public Plesk host or nginx route is needed for ClamAV.

## Install / update

Run as root from the deployed release:

```bash
bash infrastructure/plesk/documents/install-clamav.sh
```

The installer fails closed unless:

1. the container reports healthy;
2. TCP 3310 is bound to loopback;
3. a harmless INSTREAM probe returns `OK`;
4. the standard EICAR test signature returns `FOUND`.

## Operations

```bash
docker inspect euroteranga-clamav --format '{{.State.Status}} {{.State.Health.Status}}'
docker logs --tail 200 euroteranga-clamav
ss -ltn 'sport = :3310'
python3 infrastructure/plesk/documents/verify-clamav-instream.py
```

## Security boundary

ClamAV is trusted only as a technical malware scanner. A clean result never
means that a passenger document is legally valid, authentic or sufficient for
travel.

The scanner is intentionally not enabled in the API before private object
storage is ready because the configuration contract requires storage and
scanner to be enabled together.
