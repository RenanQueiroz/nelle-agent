import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../api/generated/models/device_view.dart';
import '../../api/generated/models/pairing_code_response.dart';
import 'remote_access.dart';

/// Settings > Remote access: let other devices on the network reach this server.
///
/// Rendered **only on a loopback connection**. Minting a code and managing devices are
/// loopback-only on the server — a paired device gets 404 — because enrolling a device
/// is an act of consent, and consent is given at the machine. Showing the controls on a
/// phone would be showing buttons that cannot work.
class RemoteAccessSection extends ConsumerStatefulWidget {
  const RemoteAccessSection({super.key});

  @override
  ConsumerState<RemoteAccessSection> createState() =>
      _RemoteAccessSectionState();
}

class _RemoteAccessSectionState extends ConsumerState<RemoteAccessSection> {
  PairingCodeResponse? _pairing;
  String? _error;
  bool _minting = false;

  Future<void> _mint() async {
    setState(() {
      _minting = true;
      _error = null;
    });
    try {
      final pairing = await ref
          .read(remoteAccessRepositoryProvider)
          .mintPairingCode();
      setState(() => _pairing = pairing);
    } catch (error) {
      setState(() => _error = '$error');
    } finally {
      if (mounted) {
        setState(() => _minting = false);
      }
    }
  }

  Future<void> _revoke(DeviceView device) async {
    try {
      await ref.read(remoteAccessRepositoryProvider).revoke(device.id);
      ref.invalidate(pairedDevicesProvider);
    } catch (error) {
      setState(() => _error = '$error');
    }
  }

  @override
  Widget build(BuildContext context) {
    final enabled = ref.watch(lanAccessProvider);
    final schema = ref.watch(networkSettingSchemaProvider).valueOrNull;
    final devices = ref.watch(pairedDevicesProvider);
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text(
          'Remote access',
          style: TextStyle(fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 8),

        Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  // The server's own label and help text, fetched rather than retyped.
                  // "Takes effect after a server restart" is the most important sentence
                  // on this screen, and a copy of it here is a copy that goes stale.
                  Text(schema?.label ?? 'Allow LAN devices'),
                  if (schema != null && schema.help.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        schema.help,
                        style: TextStyle(
                          fontSize: 11,
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            switch (enabled) {
              AsyncLoading() => const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              // forui's switch, not Material's. This app is forui over a bare
              // FScaffold and has no Material ancestor, so a MaterialSwitch throws
              // "No Material widget found" and paints a red error box where the
              // control should be. Analyzer-clean, and broken on sight.
              _ => FSwitch(
                key: const ValueKey('k-lan-toggle'),
                value: enabled.valueOrNull ?? false,
                onChange: (value) =>
                    ref.read(lanAccessProvider.notifier).set(value),
              ),
            },
          ],
        ),

        if (enabled case AsyncError(:final error))
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              '$error',
              key: const ValueKey('k-lan-error'),
              style: TextStyle(fontSize: 12, color: theme.colorScheme.error),
            ),
          ),

        if (enabled.valueOrNull == true) ...[
          const SizedBox(height: 16),
          FButton(
            key: const ValueKey('k-pair-device'),
            onPress: _minting ? null : _mint,
            child: Text(_minting ? 'Creating…' : 'Pair a device'),
          ),
          if (_pairing != null) ...[
            const SizedBox(height: 12),
            _PairingCard(pairing: _pairing!),
          ],
        ],

        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              _error!,
              key: const ValueKey('k-remote-access-error'),
              style: TextStyle(fontSize: 12, color: theme.colorScheme.error),
            ),
          ),

        const SizedBox(height: 20),
        const Text(
          'Paired devices',
          style: TextStyle(fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 8),
        switch (devices) {
          AsyncData(:final value) when value.isEmpty => Text(
            'No devices are paired.',
            key: const ValueKey('k-devices-empty'),
            style: TextStyle(
              fontSize: 12,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          AsyncData(:final value) => Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final device in value)
                _DeviceRow(device: device, onRevoke: () => _revoke(device)),
            ],
          ),
          AsyncError(:final error) => Text(
            'Could not list devices: $error',
            style: TextStyle(fontSize: 12, color: theme.colorScheme.error),
          ),
          _ => const SizedBox(
            height: 16,
            width: 16,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        },
      ],
    );
  }
}

/// The code, the QR, and the URLs — all three, on purpose.
///
/// The QR is an accelerator, not the way in: the code's alphabet has no `0`/`O`/`1`/`I`
/// precisely so it can be read aloud and typed, and a desktop joining another desktop
/// has no camera. A pairing flow that only offers a QR excludes the case we actually
/// drive.
class _PairingCard extends StatelessWidget {
  const _PairingCard({required this.pairing});

  final PairingCodeResponse pairing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final payload = pairing.qrPayload;

    return Container(
      key: const ValueKey('k-pairing-card'),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        border: Border.all(color: theme.colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Center(
            child: Container(
              padding: const EdgeInsets.all(8),
              // The QR needs a light quiet zone to scan; a dark-themed card would
              // otherwise hand the camera a dark-on-dark image it cannot read.
              color: Colors.white,
              child: QrImageView(
                data: pairingQrData(pairing.qrPayload),
                size: 180,
                backgroundColor: Colors.white,
                // A payload this size needs the error correction budget spent on
                // capacity, not redundancy.
                errorCorrectionLevel: QrErrorCorrectLevel.L,
              ),
            ),
          ),
          const SizedBox(height: 12),
          const Text('Or type this code on the other device:'),
          const SizedBox(height: 4),
          Row(
            children: [
              SelectableText(
                pairing.code,
                key: const ValueKey('k-pairing-code'),
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 22,
                  letterSpacing: 3,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 8),
              // Likewise: IconButton needs a Material ancestor for its ink splash.
              GestureDetector(
                key: const ValueKey('k-pairing-code-copy'),
                behavior: HitTestBehavior.opaque,
                onTap: () =>
                    Clipboard.setData(ClipboardData(text: pairing.code)),
                child: Padding(
                  padding: const EdgeInsets.all(6),
                  child: Icon(
                    FLucideIcons.copy,
                    size: 14,
                    color: theme.colorScheme.outline,
                  ),
                ),
              ),
            ],
          ),
          Text(
            'Valid for 5 minutes, once.',
            style: TextStyle(
              fontSize: 11,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 12),
          FButton(
            key: const ValueKey('k-pairing-copy-details'),
            variant: FButtonVariant.outline,
            // The joining machine pastes this one blob: it carries the addresses, the
            // code, *and* the certificate fingerprint -- which is the whole trust
            // decision and which nobody is going to retype 32 bytes of by hand.
            onPress: () => Clipboard.setData(
              ClipboardData(text: pairingQrData(pairing.qrPayload)),
            ),
            child: const Text('Copy pairing details'),
          ),
          const SizedBox(height: 12),
          const Text('Server address:'),
          for (final url in payload.lanUrls)
            SelectableText(
              url,
              key: ValueKey('k-pairing-url-$url'),
              style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
            ),
          if (payload.lanUrls.isEmpty)
            Text(
              'This machine has no network address to offer. Is it connected?',
              style: TextStyle(fontSize: 12, color: theme.colorScheme.error),
            ),
        ],
      ),
    );
  }
}

class _DeviceRow extends StatelessWidget {
  const _DeviceRow({required this.device, required this.onRevoke});

  final DeviceView device;
  final VoidCallback onRevoke;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      key: ValueKey('k-device-${device.id}'),
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Icon(
            FLucideIcons.smartphone,
            size: 16,
            color: theme.colorScheme.outline,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(device.name, style: const TextStyle(fontSize: 13)),
                Text(
                  [
                    if (device.platform != null) device.platform!,
                    'last seen ${_ago(device.lastSeenAt)}',
                  ].join(' · '),
                  style: TextStyle(
                    fontSize: 11,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          FButton(
            key: ValueKey('k-device-revoke-${device.id}'),
            // Destructive, and irreversible: the device's tokens die with the row and
            // it must pair again from scratch. The button should look like what it is.
            variant: FButtonVariant.destructive,
            onPress: onRevoke,
            child: const Text('Remove'),
          ),
        ],
      ),
    );
  }

  String _ago(String? timestamp) {
    if (timestamp == null) {
      return 'never';
    }
    final at = DateTime.tryParse(timestamp);
    if (at == null) {
      return 'unknown';
    }
    final elapsed = DateTime.now().difference(at);
    if (elapsed.inMinutes < 1) {
      return 'just now';
    }
    if (elapsed.inHours < 1) {
      return '${elapsed.inMinutes}m ago';
    }
    if (elapsed.inDays < 1) {
      return '${elapsed.inHours}h ago';
    }
    return '${elapsed.inDays}d ago';
  }
}
