# Security

Nelle Agent runs a local AI agent on your own hardware. It is **pre-1.0 and has no users yet**;
treat it as experimental software.

## Reporting a vulnerability

Please report privately through
[GitHub Security Advisories](https://github.com/RenanQueiroz/nelle-agent/security/advisories/new),
not as a public issue.

## What Nelle deliberately does, and the trust model

Some of this looks alarming out of context. It is intentional, and knowing the design is the point
of this document.

- **Host file and shell tools are unsandboxed.** When enabled, the agent can read, write and execute
  on the machine running the server. They are **disabled by default** and stay disabled until the
  user explicitly acknowledges the warning in Settings — the server _enforces_ that
  (`enabled` without `acknowledged` is refused), it is not a client-side nicety. Per-tool permissions
  and sandboxing are not implemented yet. **Do not enable them on a machine you do not control.**

- **The loopback listener is trusted and unauthenticated** (`127.0.0.1:8787`). This is by design:
  arriving on loopback is proof of local access, and anything with local access could read the data
  directory anyway. Nelle assumes a single-user machine.

- **The LAN listener is opt-in and authenticated** (`0.0.0.0:8788`, TLS). It is off unless the user
  turns it on. Every `/api/` request needs a device bearer token except `/api/health`, `/api/pair`
  and `/api/auth/refresh`, and the gate runs _before_ routing, so an unauthenticated request cannot
  even probe which routes exist.

- **TLS is self-signed and pinned, not chain-validated.** The certificate's SHA-256 fingerprint is
  handed to the client out-of-band at pairing time (in the code/QR), which makes it _pre-shared_
  pinning rather than trust-on-first-use. A fingerprint that later changes is refused with no
  override — the client cannot distinguish a re-key from a MITM, so it must not guess.

- **Access tokens live 1 hour; a refresh rotates both tokens.** Pairing codes are single-use and
  expire in 5 minutes. A paired device cannot enrol another device or list its siblings.

- **Model weights are downloaded from Hugging Face** by llama.cpp, into Nelle's own cache. A model
  is a program's input, not a program — but a malicious GGUF is still untrusted data reaching a
  native parser. Prefer well-known repositories.

## Scope

Nelle is designed to be run **locally, by the person who owns the machine**. It is not hardened for
multi-tenant or hostile-local-user scenarios, and exposing the server to an untrusted network is
outside its threat model.
