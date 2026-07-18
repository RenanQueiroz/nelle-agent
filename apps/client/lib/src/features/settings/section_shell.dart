import 'package:flutter/material.dart';
import 'package:forui/forui.dart';

/// A header action a section offers in either mode — data, not widgets, because the two
/// modes render it differently (an [FHeaderAction] in a pushed screen's header, a ghost
/// [FButton.icon] beside the pane title) while the key and behavior must stay identical.
class SectionAction {
  const SectionAction({
    required this.key,
    required this.icon,
    required this.onPress,
  });

  final ValueKey<String> key;
  final IconData icon;
  final VoidCallback onPress;
}

/// The one shell every settings destination renders in.
///
/// Standalone (`embedded: false`, the phone path): a pushed screen — `FScaffold`,
/// nested header with a back affordance, content centered in a readable column. This is
/// byte-for-byte the shell all five destinations used to hand-roll.
///
/// Embedded (`embedded: true`, the desktop path): no scaffold and **no back button** —
/// the two-pane settings screen already provides both — just a pane heading with the
/// same actions, over the same constrained content.
///
/// One widget on purpose: a destination declares its title, back key and actions once,
/// and cannot drift between the two layouts.
class SectionShell extends StatelessWidget {
  const SectionShell({
    super.key,
    required this.title,
    required this.child,
    this.embedded = false,
    this.backKey,
    this.onBack,
    this.actions = const [],
    this.maxWidth = 560,
  });

  final String title;
  final Widget child;
  final bool embedded;

  /// The standalone back affordance's key (`k-<section>-back`), kept per screen because
  /// device tests and drives address them by name.
  final ValueKey<String>? backKey;

  /// Standalone only. Defaults to popping; the connection screen falls back to the
  /// workbench because a deep link can land there with nothing to pop.
  final VoidCallback? onBack;

  final List<SectionAction> actions;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    if (!embedded) {
      return FScaffold(
        header: FHeader.nested(
          title: Text(title),
          prefixes: [
            FHeaderAction.back(
              key: backKey,
              onPress: onBack ?? Navigator.of(context).pop,
            ),
          ],
          suffixes: [
            for (final action in actions)
              FHeaderAction(
                key: action.key,
                icon: Icon(action.icon),
                onPress: action.onPress,
              ),
          ],
        ),
        child: Center(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: maxWidth),
            child: child,
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 20, 16, 0),
          child: Center(
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: maxWidth),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  for (final action in actions)
                    FButton.icon(
                      key: action.key,
                      variant: FButtonVariant.ghost,
                      size: FButtonSizeVariant.sm,
                      onPress: action.onPress,
                      child: Icon(action.icon, size: 18),
                    ),
                ],
              ),
            ),
          ),
        ),
        Expanded(
          child: Center(
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: maxWidth),
              child: child,
            ),
          ),
        ),
      ],
    );
  }
}
