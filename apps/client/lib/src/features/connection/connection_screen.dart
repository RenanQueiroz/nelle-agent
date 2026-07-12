import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../core/config.dart';
import 'health.dart';

/// M1 landing screen: edit the server URL and see whether it is reachable.
/// Superseded by the workbench once the conversation list lands.
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
    await ref.read(serverBaseUrlProvider.notifier).set(_controller.text);
    ref.invalidate(healthProvider);
  }

  @override
  Widget build(BuildContext context) {
    final health = ref.watch(healthProvider);
    return FScaffold(
      header: const FHeader(title: Text('Nelle Agent')),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Server connection'),
              const SizedBox(height: 12),
              FTextField(
                control: FTextFieldControl.managed(controller: _controller),
                label: const Text('Server URL'),
                hint: defaultServerBaseUrl,
                keyboardType: TextInputType.url,
                onSubmit: (_) => _save(),
              ),
              const SizedBox(height: 12),
              FButton(onPress: _save, child: const Text('Save & test')),
              const SizedBox(height: 20),
              _HealthStatus(health: health),
            ],
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
