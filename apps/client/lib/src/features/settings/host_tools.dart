import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/api_client.dart';
import 'section_shell.dart';

/// Host tools: **not a setting, a gate**.
///
/// They are unsandboxed — they run with the same OS permissions as the user who launched
/// Nelle — so enabling them is not a preference, it is a decision. The server enforces
/// that: `enabled` without `acknowledged` is *refused*, not merely discouraged. This
/// screen is custom for that reason, and it is the reason "custom" exists as an escape
/// hatch at all: the registry can express a boolean, but not "this one may only be turned
/// on after you have read something".
///
/// The switch is also not the only guard. Tools fail closed at *runtime*: turning them off
/// mid-run makes the next tool call fail rather than killing the run, so nothing here
/// should imply the switch is the whole story.
@immutable
class HostToolsState {
  const HostToolsState({
    required this.enabled,
    required this.acknowledged,
    required this.warning,
    required this.description,
  });

  final bool enabled;
  final bool acknowledged;

  /// The server's sentence. A security warning each client writes for itself is the one
  /// copy you least want drifting.
  final String warning;
  final String description;
}

final hostToolsProvider =
    AsyncNotifierProvider<HostToolsNotifier, HostToolsState>(
      HostToolsNotifier.new,
    );

class HostToolsNotifier extends AsyncNotifier<HostToolsState> {
  @override
  Future<HostToolsState> build() async {
    final response = await ref
        .watch(dioProvider)
        .get<Map<String, Object?>>('/api/settings/host-tools');
    return _parse(response.statusCode, response.data);
  }

  Future<void> acknowledge() => _patch({'acknowledged': true});

  Future<void> setEnabled(bool enabled) => _patch({'enabled': enabled});

  Future<void> _patch(Map<String, Object?> body) async {
    state = const AsyncValue.loading();
    final response = await ref
        .read(dioProvider)
        .patch<Map<String, Object?>>('/api/settings/host-tools', data: body);
    try {
      state = AsyncValue.data(_parse(response.statusCode, response.data));
    } catch (error) {
      // The server refused -- most likely `enabled` without `acknowledged`, which it
      // *enforces* rather than trusting the client to. Show its sentence, and leave the
      // switch where the server says it is rather than where the tap left it.
      state = AsyncValue.error(error, StackTrace.current);
      ref.invalidate(hostToolsProvider);
    }
  }

  HostToolsState _parse(int? status, Map<String, Object?>? body) {
    // A non-2xx does not throw: dio hands the body back so a NelleError can be read off
    // it. Parsing a refusal as settings would show "tools are off" when the truth is
    // "the server would not let you".
    if (status == null || status < 200 || status >= 300 || body == null) {
      final error = body?['error'];
      throw Exception(
        error is Map && error['message'] is String
            ? error['message'] as String
            : 'Host tools request failed ($status).',
      );
    }
    final tools =
        (body['hostTools'] as Map?)?.cast<String, Object?>() ?? const {};
    return HostToolsState(
      enabled: tools['enabled'] == true,
      acknowledged: tools['acknowledged'] == true,
      warning: body['warning'] as String? ?? '',
      description: body['description'] as String? ?? '',
    );
  }
}

/// Settings > Host tools.
class HostToolsScreen extends ConsumerWidget {
  const HostToolsScreen({super.key, this.embedded = false});

  /// Rendered inside the two-pane settings screen (desktop) rather than pushed (phone).
  final bool embedded;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tools = ref.watch(hostToolsProvider);
    final theme = Theme.of(context);

    return SectionShell(
      title: 'Host tools',
      embedded: embedded,
      backKey: const ValueKey('k-host-tools-back'),
      child: switch (tools) {
        AsyncData(:final value) => ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
          children: [_Body(state: value)],
        ),
        AsyncError(:final error) => Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                '$error',
                key: const ValueKey('k-host-tools-error'),
                textAlign: TextAlign.center,
                style: TextStyle(color: theme.colorScheme.error),
              ),
              const SizedBox(height: 12),
              FButton(
                onPress: () => ref.invalidate(hostToolsProvider),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

class _Body extends ConsumerWidget {
  const _Body({required this.state});

  final HostToolsState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final notifier = ref.read(hostToolsProvider.notifier);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // The warning stays visible after acknowledgement. It does not stop being true.
        Container(
          key: const ValueKey('k-host-tools-warning'),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: theme.colorScheme.errorContainer,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                FLucideIcons.triangleAlert,
                size: 16,
                color: theme.colorScheme.error,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  // The server's copy, not ours.
                  state.warning,
                  style: TextStyle(
                    fontSize: 12,
                    color: theme.colorScheme.onErrorContainer,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),

        if (!state.acknowledged)
          FButton(
            key: const ValueKey('k-host-tools-acknowledge'),
            onPress: notifier.acknowledge,
            child: const Text('I understand'),
          )
        else
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text('Enable host tools'),
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        state.description,
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
              FSwitch(
                key: const ValueKey('k-host-tools-enabled'),
                value: state.enabled,
                onChange: notifier.setEnabled,
              ),
            ],
          ),

        const SizedBox(height: 16),
        Text(
          // Disabling mid-run does not kill the run: the next tool call fails closed.
          // Saying so stops the switch from reading as the only guard.
          'Turning this off while a conversation is running makes its next tool call '
          'fail, rather than ending the run.',
          style: TextStyle(
            fontSize: 11,
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}
