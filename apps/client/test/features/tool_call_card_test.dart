import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/generated/models/tool_call_event.dart';
import 'package:nelle_agent/src/api/generated/models/tool_call_event_status.dart';
import 'package:nelle_agent/src/features/chat/tool_call_card.dart';

ToolCallEvent _call({
  String id = 't1',
  String name = 'read_file',
  ToolCallEventStatus status = ToolCallEventStatus.complete,
  String? input,
  String? output,
}) => ToolCallEvent(
  id: id,
  name: name,
  status: status,
  input: input,
  output: output,
);

Widget _host(Widget child) => MaterialApp(
  home: FTheme(
    data: FThemes.neutral.light.desktop,
    child: FScaffold(child: child),
  ),
);

void main() {
  group('parseToolCalls', () {
    test('reads a list of tool calls, skipping junk', () {
      final calls = parseToolCalls([
        {'id': 'a', 'name': 'grep', 'status': 'complete'},
        'nonsense',
        {'id': 'b', 'name': 'read', 'status': 'running'},
      ]);
      expect(calls.map((c) => c.id), ['a', 'b']);
      expect(calls.first.name, 'grep');
    });

    test('is empty for a non-list or null', () {
      expect(parseToolCalls(null), isEmpty);
      expect(parseToolCalls('nope'), isEmpty);
      expect(parseToolCalls(42), isEmpty);
    });
  });

  group('upsertToolCall', () {
    test('appends a new id and replaces an existing one in place', () {
      var calls = <ToolCallEvent>[];
      calls = upsertToolCall(calls, _call(id: 'a', status: ToolCallEventStatus.running));
      calls = upsertToolCall(calls, _call(id: 'b', status: ToolCallEventStatus.running));
      expect(calls.map((c) => c.id), ['a', 'b']);

      // 'a' moves running → complete, in place (order preserved).
      calls = upsertToolCall(calls, _call(id: 'a', status: ToolCallEventStatus.complete));
      expect(calls.map((c) => c.id), ['a', 'b']);
      expect(calls.first.status, ToolCallEventStatus.complete);
    });
  });

  testWidgets('renders the tool name and expands to input/output', (tester) async {
    await tester.pumpWidget(
      _host(
        ToolCallCard(
          call: _call(
            name: 'read_file',
            input: '{"path":"/tmp/x"}',
            output: 'file contents here',
          ),
        ),
      ),
    );

    // Collapsed: the name shows, the detail is present but not hit-testable.
    expect(find.text('read_file'), findsOneWidget);
    expect(find.text('file contents here').hitTestable(), findsNothing);

    await tester.tap(find.text('read_file'));
    await tester.pumpAndSettle();

    expect(find.text('Input'), findsOneWidget);
    expect(find.text('Output'), findsOneWidget);
    expect(find.text('file contents here').hitTestable(), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a running call with no output omits the output block', (tester) async {
    await tester.pumpWidget(
      _host(
        ToolCallCard(
          call: _call(
            name: 'search',
            status: ToolCallEventStatus.running,
            input: 'query',
          ),
        ),
      ),
    );
    await tester.tap(find.text('search'));
    await tester.pumpAndSettle();

    expect(find.text('Input'), findsOneWidget);
    expect(find.text('Output'), findsNothing);
  });
}
