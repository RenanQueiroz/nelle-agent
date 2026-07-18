import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/generated/models/reasoning_level.dart';
import 'settings_controller.dart';

/// The served `reasoning` settings group's slug. The group is flat — one number field
/// per budgeted level — which is what lets the settings screen render it generically.
const reasoningSettingsSlug = 'reasoning';

/// `0` is not "no thinking", it is **no limit**: llama.cpp spells unlimited `-1`, and the
/// server's `UNLIMITED_REASONING_BUDGET` normalizes it to `0` so the settings field can
/// stay a plain non-negative number.
const unlimitedReasoningBudget = 0;

/// How many tokens the model may spend thinking at each budgeted level.
///
/// The defaults are the server's (`DEFAULT_REASONING_BUDGETS`) and must stay that way: a
/// default here is a claim the client makes *before* the server answers, so a wrong one
/// shows the user a number that is not the one in force.
class ReasoningBudgets {
  const ReasoningBudgets({
    this.low = 512,
    this.medium = 2048,
    this.high = 8192,
  });

  final int low;
  final int medium;
  final int high;

  static ReasoningBudgets fromJson(Map<String, Object?> json) {
    const fallback = ReasoningBudgets();
    int read(String key, int fallbackValue) {
      final value = json[key];
      // The registry serves these as numbers, but a hand-edited state.json (or a newer
      // server) can hand back anything; a junk value falls back rather than crashing the
      // composer.
      if (value is num && value.isFinite && value >= 0) {
        return value.toInt();
      }
      return fallbackValue;
    }

    return ReasoningBudgets(
      low: read('low', fallback.low),
      medium: read('medium', fallback.medium),
      high: read('high', fallback.high),
    );
  }

  /// Tokens allowed inside the thinking block, or `null` when the model thinks
  /// uncapped.
  ///
  /// **Mirrors the server's `reasoningBudgetTokens`** (`contracts/reasoning.ts`), which is
  /// the authority: `off` and `max` carry no budget at all (`off` asks for no thinking,
  /// `max` sends no cap), and a budgeted level set to [unlimitedReasoningBudget] is
  /// likewise uncapped. Keep the two in step — this is rendering the server's rule, not
  /// inventing one.
  int? tokensFor(ReasoningLevel level) => switch (level) {
    ReasoningLevel.low => low > unlimitedReasoningBudget ? low : null,
    ReasoningLevel.medium => medium > unlimitedReasoningBudget ? medium : null,
    ReasoningLevel.high => high > unlimitedReasoningBudget ? high : null,
    _ => null,
  };
}

/// The budgets in force, defaulted while they load and if they cannot be read.
///
/// Derived from [settingsValuesProvider] rather than fetching `/api/settings/reasoning`
/// itself, and that is the point: saving the section already invalidates that provider,
/// so an edited budget reaches the composer's picker immediately instead of sitting
/// stale in a second cache until the app restarts.
final reasoningBudgetsProvider = Provider<ReasoningBudgets>((ref) {
  final values = ref.watch(
    settingsValuesProvider(
      const SettingsScope(slug: reasoningSettingsSlug, isDevice: false),
    ),
  );
  return ReasoningBudgets.fromJson(values.valueOrNull ?? const {});
});
