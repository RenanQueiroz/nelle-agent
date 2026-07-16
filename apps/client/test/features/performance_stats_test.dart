import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/features/chat/performance_stats.dart';

void main() {
  group('formatTokens', () {
    test('groups thousands like toLocaleString', () {
      expect(formatTokens(0), '0');
      expect(formatTokens(281), '281');
      expect(formatTokens(1234), '1,234');
      expect(formatTokens(36010), '36,010');
      expect(formatTokens(1000000), '1,000,000');
    });
  });

  group('formatPerfTime', () {
    test('matches the UI: seconds with a decimal, then minutes', () {
      expect(formatPerfTime(200), '0.2s');
      expect(formatPerfTime(7000), '7.0s');
      expect(formatPerfTime(504.4), '0.5s');
      expect(formatPerfTime(72000), '1m 12s');
      expect(formatPerfTime(60000), '1m 0s');
    });
  });

  group('PerfMetric.displayRate', () {
    test('prefers the rate the server actually timed', () {
      expect(
        const PerfMetric(tokens: 30, tokensPerSecond: 61.2, milliseconds: 490).displayRate,
        61.2,
      );
    });

    test('derives from count and time when the server sent no rate', () {
      final rate = const PerfMetric(tokens: 171, milliseconds: 504.418).displayRate;
      expect(rate, closeTo(171 / 504.418 * 1000, 0.001));
    });

    test('shows no rate for a burst too short to time (the 0.003ms frame)', () {
      // A derived rate here would be ~26 million tokens/s — noise, never shown.
      expect(const PerfMetric(tokens: 79, milliseconds: 0.003).displayRate, isNull);
    });

    test('no time and no server rate means no rate', () {
      expect(const PerfMetric(tokens: 100).displayRate, isNull);
    });
  });

  group('metric extraction from the wire', () {
    parse(Map<String, Object?> json) => parseMessagePerformance(json);

    test('reads prompt and generation from the structured object', () {
      final perf = parse({
        'source': 'llamacpp-timings',
        'prompt': {'tokens': 171, 'milliseconds': 504.418, 'cacheTokens': 40},
        'generation': {'tokens': 281, 'milliseconds': 6980, 'tokensPerSecond': 40.25},
      });
      final reading = promptMetricOf(perf)!;
      expect(reading.tokens, 171);
      expect(reading.displayRate, closeTo(339.0, 1.0));

      final gen = generationMetricOf(perf)!;
      expect(gen.tokens, 281);
      expect(gen.displayRate, 40.25);
    });

    test('falls back to legacy top-level fields for old persisted messages', () {
      final perf = parse({
        'source': 'llamacpp-slots',
        'generatedTokens': 142,
        'tokensPerSecond': 13.5,
      });
      expect(promptMetricOf(perf), isNull, reason: 'no reading row for a legacy message');
      final gen = generationMetricOf(perf)!;
      expect(gen.tokens, 142);
      expect(gen.displayRate, 13.5);
    });

    test('a metric with only generation shows no reading row (slots source)', () {
      final perf = parse({
        'source': 'llamacpp-slots',
        'generation': {'tokens': 12, 'milliseconds': 300},
      });
      expect(promptMetricOf(perf), isNull);
      expect(generationMetricOf(perf)!.tokens, 12);
    });

    test('junk performance is null, never a crash', () {
      expect(parseMessagePerformance(null), isNull);
      expect(parseMessagePerformance('nope'), isNull);
      expect(parseMessagePerformance(42), isNull);
      expect(promptMetricOf(null), isNull);
      expect(generationMetricOf(null), isNull);
    });
  });
}
