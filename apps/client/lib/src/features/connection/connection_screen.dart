import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';
import 'package:go_router/go_router.dart';

import '../../core/config.dart';
import '../settings/section_shell.dart';
import 'health.dart';
import 'join_section.dart';
import 'remote_access_section.dart';
import 'server_connection.dart';

/// Settings > This device > **Server**: which Nelle this app talks to, and pairing.
///
/// A section of the settings screen rather than a schema-rendered group, because a
/// pairing is a *flow* -- mint a code, scan or paste it, probe the addresses, pin a
/// certificate -- and none of that is a field. That is what "custom" is the escape hatch
/// for; everything that *is* a field goes through the generic renderer.
///
/// It is device-local for the plainest of reasons: it *is* this device's relationship to
/// a server, and it carries a pinned certificate and a token.
class ConnectionScreen extends ConsumerStatefulWidget {
  const ConnectionScreen({super.key, this.embedded = false});

  /// Rendered inside the two-pane settings screen (desktop) rather than pushed (phone).
  final bool embedded;

  @override
  ConsumerState<ConnectionScreen> createState() => _ConnectionScreenState();
}

class _ConnectionScreenState extends ConsumerState<ConnectionScreen> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: ref.read(serverBaseUrlProvider));
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    await ref.read(connectionProvider.notifier).setBaseUrl(_controller.text);
    ref.invalidate(healthProvider);
  }

  @override
  Widget build(BuildContext context) {
    final health = ref.watch(healthProvider);
    final connection = ref.watch(connectionProvider);

    // The box is seeded once in initState, so it goes stale the moment the connection
    // changes underneath it -- and it does: pairing, disconnecting, and a revoked device
    // unpairing itself all move it. After a disconnect the box still read
    // `https://<lan>:8788` while the app was back on loopback, and pressing "Save & test"
    // would have pointed it at the LAN server with **no certificate pinned**. Follow the
    // connection instead.
    ref.listen<ServerConnection>(connectionProvider, (previous, next) {
      if (previous?.baseUrl != next.baseUrl) {
        _controller.text = next.baseUrl;
      }
    });

    return SectionShell(
      title: 'Server',
      embedded: widget.embedded,
      maxWidth: 460,
      backKey: const ValueKey('k-connection-back'),
      // `Navigator`, not go_router: this is pushed imperatively from the settings
      // screen, so it is a route on the navigator rather than a location in the
      // router. Falls back to the workbench when it was *not* pushed -- a deep
      // link, or a restart landing straight here -- so the screen is never a dead
      // end, which it was before M2.
      onBack: () => Navigator.of(context).canPop()
          ? Navigator.of(context).pop()
          : context.go('/'),
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(vertical: 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'Connection',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 12),
            // The manual URL box is hidden while paired. A pairing *is* the
            // connection -- it carries the address, the pinned certificate and the
            // device id together -- so an editable URL beside it is a second,
            // contradictory answer to the same question. It showed 127.0.0.1 while
            // the app was talking to the LAN server, which is worse than useless.
            if (!connection.isPaired) ...[
              FTextField(
                key: const ValueKey('k-connection-url'),
                control: FTextFieldControl.managed(controller: _controller),
                label: const Text('Server URL'),
                hint: defaultServerBaseUrl,
                keyboardType: TextInputType.url,
                onSubmit: (_) => _save(),
              ),
              const SizedBox(height: 12),
              FButton(
                key: const ValueKey('k-connection-save'),
                onPress: _save,
                child: const Text('Save & test'),
              ),
              const SizedBox(height: 20),
            ],
            _HealthStatus(health: health),
            const SizedBox(height: 28),
            const Divider(),
            const SizedBox(height: 16),
            // Joining is possible from anywhere -- that is the point of a client.
            const JoinSection(),
            // Hosting is not: minting a code and managing devices are loopback-only
            // on the server (they answer 404 to a paired device), because enrolling
            // a device is an act of consent and consent is given at the machine. On
            // a phone these would be buttons that cannot work.
            if (connection.isLoopback) ...[
              const SizedBox(height: 28),
              const Divider(),
              const SizedBox(height: 16),
              const RemoteAccessSection(),
            ],
          ],
        ),
      ),
    );
  }
}

class _HealthStatus extends StatelessWidget {
  const _HealthStatus({required this.health});

  final AsyncValue<ServerHealth> health;

  @override
  Widget build(BuildContext context) {
    return switch (health) {
      AsyncData(:final value) => _row(
        const Icon(FLucideIcons.circleCheck, color: Colors.green, size: 18),
        'Connected to ${value.app}',
      ),
      AsyncError(:final error) => _row(
        const Icon(FLucideIcons.circleX, color: Colors.red, size: 18),
        'Not reachable: $error',
      ),
      _ => _row(
        const SizedBox(
          width: 16,
          height: 16,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
        'Checking…',
      ),
    };
  }

  Widget _row(Widget leading, String text) => Row(
    mainAxisAlignment: MainAxisAlignment.center,
    children: [
      leading,
      const SizedBox(width: 8),
      Flexible(child: Text(text)),
    ],
  );
}
