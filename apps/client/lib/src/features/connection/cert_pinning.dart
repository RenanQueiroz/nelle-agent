import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/// The server's certificate is self-signed, so chain validation cannot work — there
/// is no authority to appeal to. It is trusted by **fingerprint** instead, and the
/// fingerprint is handed over out-of-band, in the pairing payload, *before* the first
/// connection is ever made. That is what makes this pre-shared pinning rather than
/// trust-on-first-use: we do not learn the identity from the party we are trying to
/// identify.
///
/// The format is the one the server emits and the one `openssl x509 -fingerprint
/// -sha256` prints — uppercase hex byte-pairs joined by colons. Matching it exactly
/// means nobody has to invent a second encoding for the same 32 bytes.
String fingerprintOf(Uint8List der) {
  final digest = sha256.convert(der);
  return digest.bytes
      .map((byte) => byte.toRadixString(16).padLeft(2, '0').toUpperCase())
      .join(':');
}

/// Whether a certificate is the one this device pinned when it paired.
///
/// A mismatch is refused, always. The certificate is stable for five years precisely
/// so a pin holds, so a changed fingerprint is either a re-key or a machine-in-the-
/// middle — and **the client cannot tell which**. Offering to continue anyway would
/// hand the decision to someone with strictly less information than we have.
bool certificateMatchesPin(Uint8List der, String? pin) {
  if (pin == null || pin.isEmpty) {
    return false;
  }
  return _normalize(fingerprintOf(der)) == _normalize(pin);
}

/// Tolerant of how the pin was typed or pasted: case, and colons that a user might
/// have dropped. The bytes are what matter.
String _normalize(String fingerprint) =>
    fingerprint.toUpperCase().replaceAll(':', '').replaceAll(' ', '');
