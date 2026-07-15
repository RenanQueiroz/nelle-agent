import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import 'features/settings/device_settings.dart';
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

    // Device-local, and the reason Appearance is: `system` resolves against *this* OS.
    final themeMode =
        ref.watch(themeModeProvider).valueOrNull ?? ThemeMode.system;

    return MaterialApp.router(
      title: 'Nelle Agent',
      debugShowCheckedModeBanner: false,
      // Flutter's frame-timing HUD (UI + raster thread graphs), off unless asked for:
      // `flutter run --dart-define=nelle.perfOverlay=true`. A compile-time constant, so it
      // costs nothing when off and stays web-safe (no dart:io env read).
      showPerformanceOverlay: const bool.fromEnvironment('nelle.perfOverlay'),
      routerConfig: router,
      localizationsDelegates: FLocalizations.localizationsDelegates,
      supportedLocales: FLocalizations.supportedLocales,
      theme: variant(FThemes.neutral.light).toApproximateMaterialTheme(),
      darkTheme: variant(FThemes.neutral.dark).toApproximateMaterialTheme(),
      themeMode: themeMode,
      builder: (context, child) {
        // **The forui theme must follow the resolved mode, not the platform.**
        //
        // This read `MediaQuery.platformBrightnessOf(context)` -- the OS's brightness,
        // directly -- which was harmless only while there was no override. With one,
        // `MaterialApp` switches to the light Material theme while every forui widget
        // stays dark, and the app renders half in each. `flutter analyze` is perfectly
        // happy; you just look at it.
        final dark = switch (themeMode) {
          ThemeMode.light => false,
          ThemeMode.dark => true,
          ThemeMode.system =>
            MediaQuery.platformBrightnessOf(context) == Brightness.dark,
        };
        final theme = variant(
          dark ? FThemes.neutral.dark : FThemes.neutral.light,
        );
        return FTheme(
          data: theme,
          child: FToaster(child: FTooltipGroup(child: child!)),
        );
      },
    );
  }
}
