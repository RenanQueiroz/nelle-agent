import 'package:flutter/material.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/chat_performance.dart';

/// The three numbers one message's stats row shows, independent of which wire DTO they came
/// from (`Prompt`, `Generation`, or the legacy top-level fields — all carry the same shape).
class PerfMetric {
  const PerfMetric({required this.tokens, this.tokensPerSecond, this.milliseconds});

  final int tokens;

  /// **Only what the server timed.** llama.cpp reports no rate for a burst too short to
  /// measure (a captured frame really said `79 tokens / 0.003ms`), and a rate derived from
  /// that is astronomical noise. Absent means "no rate to show", never zero — the row omits
  /// the speed badge rather than inventing one.
  final double? tokensPerSecond;
  final double? milliseconds;

  /// The rate to display: the server's if it timed one, else derived from count ÷ time but
  /// only when the elapsed time is long enough to be meaningful (≥ 1 ms). Null → no badge.
  double? get displayRate {
    if (tokensPerSecond != null && tokensPerSecond! > 0) {
      return tokensPerSecond;
    }
    final ms = milliseconds;
    if (ms != null && ms >= 1 && tokens > 0) {
      return tokens / ms * 1000;
    }
    return null;
  }
}

/// Parses a settled message's `performance` (raw JSON on `ConversationMessage`, typed `dynamic`).
ChatPerformance? parseMessagePerformance(Object? raw) {
  if (raw is! Map) {
    return null;
  }
  try {
    return ChatPerformance.fromJson(raw.cast<String, Object?>());
  } catch (_) {
    return null;
  }
}

/// The prompt-processing metric (the "reading" row), or null when there is none.
PerfMetric? promptMetricOf(ChatPerformance? p) {
  final prompt = p?.prompt;
  if (prompt == null) {
    return null;
  }
  return PerfMetric(
    tokens: prompt.tokens.toInt(),
    tokensPerSecond: prompt.tokensPerSecond?.toDouble(),
    milliseconds: prompt.milliseconds?.toDouble(),
  );
}

/// The generation metric, preferring the structured object and falling back to the legacy
/// top-level fields so a message persisted before the metric objects existed still renders.
PerfMetric? generationMetricOf(ChatPerformance? p) {
  if (p == null) {
    return null;
  }
  final generation = p.generation;
  if (generation != null) {
    return PerfMetric(
      tokens: generation.tokens.toInt(),
      tokensPerSecond: generation.tokensPerSecond?.toDouble(),
      milliseconds: generation.milliseconds?.toDouble(),
    );
  }
  final legacyTokens = p.generatedTokens;
  if (legacyTokens != null) {
    return PerfMetric(
      tokens: legacyTokens.toInt(),
      tokensPerSecond: p.tokensPerSecond?.toDouble(),
    );
  }
  return null;
}

/// Groups digits with a thin separator, matching the UI's `toLocaleString()`: `1,234`.
String formatTokens(int tokens) {
  final digits = tokens.abs().toString();
  final buffer = StringBuffer(tokens < 0 ? '-' : '');
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) {
      buffer.write(',');
    }
    buffer.write(digits[i]);
  }
  return buffer.toString();
}

/// Time the way llama.cpp's UI formats it: `0.2s`, `7.0s`, and `1m 12s` past a minute.
String formatPerfTime(double milliseconds) {
  final seconds = milliseconds / 1000;
  if (seconds < 60) {
    return '${seconds.toStringAsFixed(1)}s';
  }
  final minutes = seconds ~/ 60;
  final rem = (seconds - minutes * 60).round();
  return '${minutes}m ${rem}s';
}

/// The stats row under one message: tokens, time, speed — each an icon+value badge whose field
/// name appears on hover (desktop) or long-press (mobile). [generation] picks the labels and the
/// speed unit (`t/s` for generation, `tokens/s` for reading — llama.cpp's own inconsistency,
/// copied deliberately). A missing time or rate simply drops its badge.
class PerformanceStatsRow extends StatelessWidget {
  const PerformanceStatsRow({
    super.key,
    required this.metric,
    required this.generation,
    required this.alignEnd,
  });

  final PerfMetric metric;

  /// Generation (assistant) vs prompt-processing (user "reading") labels and units.
  final bool generation;

  /// Reading rows sit under the right-aligned user message; generation under the left assistant.
  final bool alignEnd;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final rate = metric.displayRate;
    final ms = metric.milliseconds;
    final badges = <Widget>[
      _StatBadge(
        icon: FLucideIcons.wholeWord,
        value: '${formatTokens(metric.tokens)} tokens',
        fieldName: generation ? 'Generated tokens' : 'Prompt tokens',
        color: scheme.outline,
      ),
      if (ms != null)
        _StatBadge(
          icon: FLucideIcons.clock,
          value: formatPerfTime(ms),
          fieldName: generation ? 'Generation time' : 'Prompt processing time',
          color: scheme.outline,
        ),
      if (rate != null)
        _StatBadge(
          icon: FLucideIcons.gauge,
          value: generation
              ? '${rate.toStringAsFixed(2)} t/s'
              : '${rate.toStringAsFixed(2)} tokens/s',
          fieldName: generation ? 'Generation speed' : 'Prompt processing speed',
          color: scheme.outline,
        ),
    ];
    return Padding(
      padding: const EdgeInsets.only(top: 2, bottom: 4),
      child: Wrap(
        alignment: alignEnd ? WrapAlignment.end : WrapAlignment.start,
        spacing: 12,
        runSpacing: 4,
        children: badges,
      ),
    );
  }
}

/// One `icon value` pair; the [fieldName] is the tooltip, shown on hover and on long-press.
///
/// `FTooltip` handles both triggers, and it is what the rest of the app uses — a Material
/// `Tooltip` would throw "No Material widget found" here (forui over a bare `FScaffold`).
class _StatBadge extends StatelessWidget {
  const _StatBadge({
    required this.icon,
    required this.value,
    required this.fieldName,
    required this.color,
  });

  final IconData icon;
  final String value;
  final String fieldName;
  final Color color;

  @override
  Widget build(BuildContext context) => FTooltip(
    tipBuilder: (context, _) => Text(fieldName),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 12, color: color),
        const SizedBox(width: 4),
        Text(value, style: TextStyle(fontSize: 11, color: color)),
      ],
    ),
  );
}
