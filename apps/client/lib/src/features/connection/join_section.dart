import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import 'join_server.dart';
import 'server_connection.dart';

/// Settings > Join a server: point this app at a Nelle running on another machine.
///
/// The details are pasted, not retyped field by field. The certificate fingerprint is
/// 32 bytes of hex and nobody is going to transcribe it — but it is also the *entire*
/// trust decision, so it cannot be dropped. The host screen offers the whole payload to
/// copy (and as a QR); this takes it in one go.
///
/// That is what keeps the pin **pre-shared**: the fingerprint travels through a channel
/// the network cannot touch (a clipboard, a camera, a person reading it out) rather than
/// being learned from the server we are trying to authenticate.
class JoinSection extends ConsumerStatefulWidget {
  const JoinSection({super.key});

  @override
  ConsumerState<JoinSection> createState() => _JoinSectionState();
}

class _JoinSectionState extends ConsumerState<JoinSection> {
  final _details = TextEditingController();
  final _name = TextEditingController();
  String? _error;
  bool _joining = false;

  @override
  void dispose() {
    _details.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _join() async {
    final payload = parsePairingPayload(_details.text);
    if (payload == null) {
      setState(() {
        _error =
            'That does not look like pairing details. Copy them from the other machine '
            '(Settings > Remote access > Pair a device).';
      });
      return;
    }

    setState(() {
      _joining = true;
      _error = null;
    });
    try {
      await ref.read(joinServerProvider)(payload, deviceName: _name.text);
      _details.clear();
    } on JoinFailure catch (failure) {
      setState(() => _error = failure.message);
    } catch (error) {
      setState(() => _error = '$error');
    } finally {
      if (mounted) {
        setState(() => _joining = false);
      }
    }
  }

  Future<void> _leave() async {
    await ref.read(connectionProvider.notifier).unpair();
  }

  @override
  Widget build(BuildContext context) {
    final connection = ref.watch(connectionProvider);
    final theme = Theme.of(context);

    if (connection.isPaired) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text(
            'Paired server',
            style: TextStyle(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Icon(
                FLucideIcons.shieldCheck,
                size: 16,
                color: theme.colorScheme.primary,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      connection.baseUrl,
                      key: const ValueKey('k-paired-url'),
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 12,
                      ),
                    ),
                    Text(
                      'Certificate pinned · this device is ${connection.deviceId}',
                      style: TextStyle(
                        fontSize: 11,
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          FButton(
            key: const ValueKey('k-leave-server'),
            variant: FButtonVariant.destructive,
            onPress: _leave,
            child: const Text('Disconnect'),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              'Disconnecting returns this app to the local server. The other machine '
              'still lists this device until you remove it there.',
              style: TextStyle(
                fontSize: 11,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text(
          'Join a server',
          style: TextStyle(fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 4),
        Text(
          'On the other machine: Settings > Remote access > Pair a device. Copy the '
          'pairing details and paste them here.',
          style: TextStyle(
            fontSize: 11,
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 12),
        FTextField(
          key: const ValueKey('k-join-details'),
          control: FTextFieldControl.managed(controller: _details),
          label: const Text('Pairing details'),
          hint: '{"lanUrls":["https://…"],"certFingerprint":"…","code":"…"}',
          maxLines: 3,
        ),
        const SizedBox(height: 8),
        FTextField(
          key: const ValueKey('k-join-name'),
          control: FTextFieldControl.managed(controller: _name),
          label: const Text('Name for this device (optional)'),
          hint: 'Shown on the other machine',
        ),
        const SizedBox(height: 12),
        FButton(
          key: const ValueKey('k-join-submit'),
          onPress: _joining ? null : _join,
          child: Text(_joining ? 'Pairing…' : 'Pair'),
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              _error!,
              key: const ValueKey('k-join-error'),
              style: TextStyle(fontSize: 12, color: theme.colorScheme.error),
            ),
          ),
      ],
    );
  }
}
