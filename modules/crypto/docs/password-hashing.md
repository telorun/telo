# Password hashing

`Crypto.PasswordHash` is configured once with the algorithm new hashes are made with; `op: hash` makes one and `op: verify` checks a password against a stored one.

## Algorithms and parameters

`algorithm` is `argon2id` (default), `bcrypt`, `scrypt` or `pbkdf2`. `parameters` holds one block per algorithm; only the configured algorithm's block is read. Omitted values default to the OWASP recommendations:

| Algorithm | Default parameters | Stored as |
| --- | --- | --- |
| argon2id | `memoryKiB: 19456`, `iterations: 2`, `parallelism: 1` | PHC `$argon2id$…` |
| bcrypt | `cost: 12` | `$2a$…` |
| scrypt | `cost: 131072` (N, a power of two), `blockSize: 8`, `parallelization: 1` | PHC `$scrypt$ln=…,r=…,p=…$salt$hash` |
| pbkdf2 | `iterations: 600000` over SHA-256 | PHC `$pbkdf2-sha256$i=…$salt$hash` |

Salts are 16 random bytes, derived keys 32 bytes. scrypt and PBKDF2 PHC fields use standard base64 without padding.

## Pepper

`pepper` (bind it from `secrets:`) is applied as an HMAC-SHA-256 of the password before hashing. It lives outside the database, so a leaked table alone cannot be attacked offline. **Changing it invalidates every stored hash.** bcrypt then hashes a fixed 44-character value, so its 72-byte limit no longer applies.

## Rehash on login

`verify` returns `{ valid, rehash }`. `rehash: true` means the password matched but the stored hash is a different algorithm or weaker than configured (lower memory or iterations, lower cost). After a successful login, hash the password again with `op: hash` and store the result: hashes upgrade as users sign in, with no migration job.

## Imported hashes

`verify` accepts every encoding the module knows whatever the configuration: argon2 (id, i, d), bcrypt (`$2a$`, `$2b$`, `$2x$`, `$2y$`), scrypt and PBKDF2-SHA-256/512 PHC strings. Hashes imported from another system verify, and report `rehash: true` when they differ from the configuration. An encoding it does not know is `ERR_CRYPTO_UNSUPPORTED_HASH`; a known encoding that is malformed is `valid: false`.

## bcrypt length limit

bcrypt reads only the first 72 bytes of a password. A longer one (unpeppered) is refused with `ERR_PASSWORD_TOO_LONG` instead of being silently truncated.
