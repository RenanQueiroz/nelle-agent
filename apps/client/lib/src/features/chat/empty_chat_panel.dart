import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';
import 'package:go_router/go_router.dart';

import '../models/models_controller.dart';
import '../runtime/runtime_controller.dart';

/// What an empty transcript says.
///
/// On a ready install it is a greeting. On a fresh one it is the guided path — install
/// llama.cpp, add a model, start it — **offered where the user already is**, instead of
/// a refusal after they type. The checks are ordered by dependency: a model without a
/// runtime cannot run, a runtime with no model has nothing to load.
class EmptyChatPanel extends ConsumerWidget {
  const EmptyChatPanel({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final runtime = ref.watch(runtimeStatusProvider).valueOrNull;
    final catalog = ref.watch(modelCatalogProvider).valueOrNull;

    // Unknown is not broken: while either is still loading (or unreachable), greet.
    // Flashing "Install llama.cpp" at someone whose install is fine costs more than a
    // beat of neutrality costs someone whose install is missing.
    if (runtime == null || catalog == null) {
      return const _Greeting();
    }
    if (!runtime.installed) {
      return _Guide(
        icon: FLucideIcons.cpu,
        title: 'Install llama.cpp',
        body:
            'Nelle runs models on this machine through llama.cpp. '
            'Install it once; updates are one tap after that.',
        ctaKey: const ValueKey('k-chat-cta-install'),
        ctaLabel: 'Install llama.cpp',
        onPress: () => context.push('/settings?section=llamacpp'),
      );
    }
    if (catalog.models.isEmpty) {
      return _Guide(
        icon: FLucideIcons.box,
        title: 'Add a model',
        body:
            'llama.cpp is installed, but there is nothing for it to run yet. '
            'Download a model from Hugging Face and every chat can use it.',
        ctaKey: const ValueKey('k-chat-cta-models'),
        ctaLabel: 'Add a model',
        onPress: () => context.push('/settings?section=models'),
      );
    }
    if (!runtime.running) {
      return _Guide(
        icon: FLucideIcons.play,
        title: 'Start llama.cpp',
        body: 'Everything is installed. Start llama.cpp and this chat is ready.',
        ctaKey: const ValueKey('k-chat-cta-start'),
        ctaLabel: 'Start llama.cpp',
        onPress: () => _start(context, ref),
      );
    }
    return const _Greeting();
  }

  /// Starts llama.cpp **from here** — the settings screen is where you go when this
  /// fails, not a detour the happy path requires.
  Future<void> _start(BuildContext context, WidgetRef ref) async {
    await ref.read(runtimeStatusProvider.notifier).start();
    if (!context.mounted) {
      return;
    }
    final status = ref.read(runtimeStatusProvider);
    if (status.hasError || status.valueOrNull?.running == false) {
      showFToast(
        context: context,
        icon: const Icon(FLucideIcons.circleX),
        title: const Text('llama.cpp did not start. See Settings › llama.cpp.'),
      );
    }
  }
}

class _Greeting extends StatelessWidget {
  const _Greeting();

  @override
  Widget build(BuildContext context) => Center(
    child: Text(
      'What can I help with?',
      key: const ValueKey('k-chat-greeting'),
      textAlign: TextAlign.center,
      style: TextStyle(
        fontSize: 22,
        fontWeight: FontWeight.w500,
        color: context.theme.colors.mutedForeground,
      ),
    ),
  );
}

/// One step of the guided path: an icon, a sentence of why, and the single next action.
class _Guide extends StatelessWidget {
  const _Guide({
    required this.icon,
    required this.title,
    required this.body,
    required this.ctaKey,
    required this.ctaLabel,
    required this.onPress,
  });

  final IconData icon;
  final String title;
  final String body;
  final ValueKey<String> ctaKey;
  final String ctaLabel;
  final VoidCallback onPress;

  @override
  Widget build(BuildContext context) {
    final colors = context.theme.colors;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 380),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  color: colors.muted,
                  shape: BoxShape.circle,
                ),
                child: Icon(icon, size: 26, color: colors.mutedForeground),
              ),
              const SizedBox(height: 16),
              Text(
                title,
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 6),
              Text(
                body,
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 13.5, color: colors.mutedForeground),
              ),
              const SizedBox(height: 18),
              FButton(
                key: ctaKey,
                mainAxisSize: MainAxisSize.min,
                onPress: onPress,
                child: Text(ctaLabel),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
