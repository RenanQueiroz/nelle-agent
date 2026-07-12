import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import 'routing/router.dart';

/// Root app widget. forui themes the app via `MaterialApp.builder` -> `FTheme`,
/// so Material widgets stay available for anything forui doesn't cover.
class NelleApp extends ConsumerWidget {
  const NelleApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);
    final isMobile =
        defaultTargetPlatform == TargetPlatform.iOS ||
        defaultTargetPlatform == TargetPlatform.android;

    // FThemes.neutral.light is an FPlatformThemeData; .touch/.desktop resolve it
    // to a concrete FThemeData sized for the platform.
    FThemeData variant(FPlatformThemeData base) =>
        isMobile ? base.touch : base.desktop;

    return MaterialApp.router(
      title: 'Nelle Agent',
      debugShowCheckedModeBanner: false,
      routerConfig: router,
      localizationsDelegates: FLocalizations.localizationsDelegates,
      supportedLocales: FLocalizations.supportedLocales,
      theme: variant(FThemes.neutral.light).toApproximateMaterialTheme(),
      darkTheme: variant(FThemes.neutral.dark).toApproximateMaterialTheme(),
      builder: (context, child) {
        final brightness = MediaQuery.platformBrightnessOf(context);
        final theme = variant(
          brightness == Brightness.dark
              ? FThemes.neutral.dark
              : FThemes.neutral.light,
        );
        return FTheme(
          data: theme,
          child: FToaster(child: FTooltipGroup(child: child!)),
        );
      },
    );
  }
}
