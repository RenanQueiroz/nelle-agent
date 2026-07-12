import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';
import 'package:go_router/go_router.dart';

import '../../core/config.dart';
import 'health.dart';
import 'remote_access_section.dart';
import 'server_connection.dart';

/// Settings: edit the server URL and see whether it is reachable.
///
/// Reached from the conversation list's gear, which **pushes** it — `go()` replaces
/// the stack, and with nothing to pop and no back action this screen was a dead end.
class ConnectionScreen extends ConsumerStatefulWidget {
  const ConnectionScreen({super.key});

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
    return FScaffold(
      header: FHeader.nested(
        title: const Text('Settings'),
        prefixes: [
          FHeaderAction.back(
            key: const ValueKey('k-connection-back'),
            // Pop when this was pushed; fall back to the workbench when it was not —
            // a deep link, or a restart landing straight here — so the screen is never
            // a dead end.
            onPress: () => context.canPop() ? context.pop() : context.go('/'),
          ),
        ],
      ),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'Server connection',
                  style: TextStyle(fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 12),
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
                _HealthStatus(health: health),
                // Minting a code and managing devices are loopback-only on the server
                // (they answer 404 to a paired device), because enrolling a device is
                // an act of consent and consent is given at the machine. On a phone
                // these would be buttons that cannot work.
                if (connection.isLoopback) ...[
                  const SizedBox(height: 28),
                  const Divider(),
                  const SizedBox(height: 16),
                  const RemoteAccessSection(),
                ],
              ],
            ),
          ),
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
