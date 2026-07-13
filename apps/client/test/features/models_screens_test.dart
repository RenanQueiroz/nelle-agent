import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/generated/models/invalid_model_param.dart';
import 'package:nelle_agent/src/api/generated/models/model_param_warning.dart';
import 'package:nelle_agent/src/api/generated/models/invalid_model_param_reason.dart';
import 'package:nelle_agent/src/features/models/active_runs.dart';
import 'package:nelle_agent/src/features/models/model_detail_screen.dart';
import 'package:nelle_agent/src/features/models/models_controller.dart';
import 'package:nelle_agent/src/features/models/models_screen.dart';
import 'package:nelle_agent/src/features/models/param_editor.dart';

import '../helpers/fake_dio.dart';

Map<String, dynamic> _model({
  String id = 'org/repo:Q4_K_XL',
  bool pinned = true,
  int? diskBytes = 15000000000,
  Map<String, String> extra = const {'temp': '0.7'},
}) => {
  'id': id,
  'name': id,
  'presetName': id,
  'source': 'huggingface',
  'repoId': 'org/repo',
  'quant': 'UD-Q4_K_XL',
  'hfRef': 'org/repo:UD-Q4_K_XL',
  'pinned': pinned,
  'diskBytes': diskBytes,
  'params': {'extra': extra},
  'createdAt': '2026-07-13T00:00:00.000Z',
};

Widget _host(
  Widget child, {
  List<Map<String, dynamic>>? models,
  Map<String, dynamic>? deleteResponse,
  List<Map<String, dynamic>>? routerModels,
}) => ProviderScope(
  overrides: [
    dioProvider.overrideWithValue(
      stubDio((options) {
        if (options.method == 'DELETE') {
          return jsonResponse(
            deleteResponse ??
                {
                  'ok': true,
                  'removedModelId': 'org/repo:Q4_K_XL',
                  'catalog': {
                    'models': <Object>[],
                    'activeModelId': null,
                    'globalModelParams': <String, String>{},
                  },
                  'weightsRemoved': true,
                  'reclaimedBytes': 15000000000,
                  'sharedWithModelIds': <String>[],
                },
          );
        }
        if (options.path.contains('/api/llama/models')) {
          return jsonResponse({'models': routerModels ?? <Object>[]});
        }
        return jsonResponse({
          'models': models ?? [_model()],
          'activeModelId': 'org/repo:Q4_K_XL',
          'globalModelParams': <String, String>{},
        });
      }),
    ),
  ],
  child: MaterialApp(
    theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
    home: FTheme(data: FThemes.neutral.light.desktop, child: child),
  ),
);

void main() {
  _activeRunTests();
  group('formatBytes', () {
    test('null is "not downloaded", and never zero', () {
      // Absent is a real state: the weights arrive on the model's *first load*. Rendering it as
      // "0 B" would say the model is empty, which is a different and untrue thing.
      expect(formatBytes(null), 'Not downloaded');
      expect(formatBytes(0), '0 B');
      expect(formatBytes(15000000000), '14.0 GB');
    });
  });

  testWidgets('the list shows what each model costs on disk', (tester) async {
    await tester.pumpWidget(_host(const ModelsScreen()));
    await tester.pumpAndSettle();

    expect(find.textContaining('14.0 GB'), findsOneWidget);
    expect(find.textContaining('default for new chats'), findsOneWidget);
  });

  testWidgets('an undownloaded model says so, rather than showing 0 bytes', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        const ModelsScreen(),
        models: [_model(diskBytes: null, pinned: false)],
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('14.0 GB'), findsNothing);
  });

  group('ModelDetailScreen', () {
    testWidgets('the pin is a switch, and it is off-limits before the first load', (
      tester,
    ) async {
      // An unpinned model is one that has never loaded -- Nelle pins it the moment it has,
      // because a successful load is proof its blobs are complete. There is nothing to offer for
      // a model with no weights yet.
      await tester.pumpWidget(
        _host(
          const ModelDetailScreen(modelId: 'org/repo:Q4_K_XL'),
          models: [_model(pinned: false, diskBytes: null)],
        ),
      );
      await tester.pumpAndSettle();

      final pin = tester.widget<FSwitch>(
        find.byKey(const ValueKey('k-model-pinned')),
      );
      expect(pin.value, isFalse);
      expect(pin.onChange, isNull, reason: 'nothing to pin to');
      expect(find.textContaining('Not downloaded yet'), findsOneWidget);
    });

    testWidgets(
      'a pinned model explains that un-pinning is how an update lands',
      (tester) async {
        await tester.pumpWidget(
          _host(const ModelDetailScreen(modelId: 'org/repo:Q4_K_XL')),
        );
        await tester.pumpAndSettle();

        final pin = tester.widget<FSwitch>(
          find.byKey(const ValueKey('k-model-pinned')),
        );
        expect(pin.value, isTrue);
        expect(pin.onChange, isNotNull);
        expect(find.textContaining('check for an update'), findsOneWidget);
      },
    );

    testWidgets('a load that died is SHOWN as dead, not left looking like a no-op', (
      tester,
    ) async {
      // The router answers `{success: true}` to a load -- it accepted the *request* -- and a
      // child that then dies before loading a byte (a bad `ctk` value, a preset it will not
      // parse) is left at `unloaded`, never `failed`, carrying only an exit code. Measured: 7s
      // of polling, `unloaded` and `exit_code: 1` on every tick. So pressing Load on a broken
      // model looked *exactly* like pressing a button that does nothing.
      await tester.pumpWidget(
        _host(
          const ModelDetailScreen(modelId: 'org/repo:Q4_K_XL'),
          routerModels: [
            {
              'sectionId': 'org/repo:Q4_K_XL',
              'alias': 'org/repo:Q4_K_XL',
              'status': 'unloaded',
              'aliases': <String>[],
              'exitCode': 1,
            },
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('k-model-load-failed')), findsOneWidget);
      expect(find.textContaining('exited with code 1'), findsOneWidget);
    });

    testWidgets('a healthy model shows no failure, whatever exit code it carries', (
      tester,
    ) async {
      // An exit code on a *loaded* model belongs to a previous life. Reading it as a current
      // failure would paint a red line under a model that is working perfectly.
      await tester.pumpWidget(
        _host(
          const ModelDetailScreen(modelId: 'org/repo:Q4_K_XL'),
          routerModels: [
            {
              'sectionId': 'org/repo:Q4_K_XL',
              'alias': 'org/repo:Q4_K_XL',
              'status': 'loaded',
              'aliases': <String>[],
              'exitCode': 1,
            },
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('k-model-load-failed')), findsNothing);
    });

    testWidgets('a clean unloaded model is not called a failure', (
      tester,
    ) async {
      // exit_code 0, or none at all: it was unloaded on purpose, or never loaded.
      await tester.pumpWidget(
        _host(
          const ModelDetailScreen(modelId: 'org/repo:Q4_K_XL'),
          routerModels: [
            {
              'sectionId': 'org/repo:Q4_K_XL',
              'alias': 'org/repo:Q4_K_XL',
              'status': 'unloaded',
              'aliases': <String>[],
              'exitCode': 0,
            },
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('k-model-load-failed')), findsNothing);
    });

    testWidgets('what a model IS survives llama.cpp being stopped', (
      tester,
    ) async {
      // The router is gone (no routerModels at all), but a model that has loaded once still
      // knows what it is: the server caches this in `model_cache` and `gguf_metadata` for
      // exactly this reason. Reading only the live router blanked every fact the moment
      // llama.cpp stopped, and then said they were "unknown until this model has loaded once"
      // -- which by then was a lie, and is what the drive caught.
      await tester.pumpWidget(
        _host(
          const ModelDetailScreen(modelId: 'org/repo:Q4_K_XL'),
          models: [
            {
              ..._model(),
              'architecture': 'gemma4',
              'parameterCount': 7463013674,
              'contextTrain': 131072,
              'contextWindow': 32768,
            },
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('k-model-facts')), findsOneWidget);
      expect(find.textContaining('gemma4'), findsOneWidget);
      expect(find.textContaining('7.5B params'), findsOneWidget);
      expect(find.textContaining('Full window: 131,072'), findsOneWidget);
      expect(find.textContaining('running at 32,768'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('k-model-facts-unknown')),
        findsNothing,
        reason: 'it has loaded once; saying otherwise is a lie',
      );
    });

    testWidgets('facts absent before a load are SAID to be absent, not guessed', (
      tester,
    ) async {
      // architecture / params / context window are all llama.cpp's to report, and it reports
      // none of them until the model has loaded once.
      await tester.pumpWidget(
        _host(const ModelDetailScreen(modelId: 'org/repo:Q4_K_XL')),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('k-model-facts-unknown')),
        findsOneWidget,
      );
    });

    testWidgets('delete is confirmed, and a kept-weights answer is not called a reclaim', (
      tester,
    ) async {
      // **The one that could lie about the user's disk.** A Hugging Face repo directory holds
      // every quant of that repo, so a sibling model can be holding the blobs alive. The server
      // keeps them and says why; claiming a reclaim that never happened would be a lie.
      //
      // A tall viewport, because a lazy ListView does not build what is off-screen -- the delete
      // section is at the bottom of the page, so on a normal viewport it does not exist to tap.
      tester.view.physicalSize = const Size(1200, 4000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      // Driven from the LIST, because that is where the answer has to land: the model is gone,
      // so its detail screen goes with it, and a message left behind on a dead screen is a
      // message nobody reads.
      await tester.pumpWidget(
        _host(
          const ModelsScreen(),
          deleteResponse: {
            'ok': true,
            'removedModelId': 'org/repo:Q4_K_XL',
            'catalog': {
              'models': <Object>[],
              'activeModelId': null,
              'globalModelParams': <String, String>{},
            },
            'weightsRemoved': false,
            'reclaimedBytes': 0,
            'sharedWithModelIds': ['org/repo:Q8_0'],
          },
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const ValueKey('k-model-tile-org/repo:Q4_K_XL')),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-model-delete-weights')));
      await tester.pumpAndSettle();

      // The first tap arms; it does not delete.
      await tester.tap(find.byKey(const ValueKey('k-model-delete')));
      await tester.pumpAndSettle();
      // The warning is its own line, not the button's label: forui lays a button's child out in
      // an unflexed Row, so a long label overflowed it by 94px -- M6's Android bug in a new
      // costume.
      expect(
        find.byKey(const ValueKey('k-model-delete-warning')),
        findsOneWidget,
      );
      expect(find.textContaining('deletes its weights'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('k-model-delete')));
      await tester.pumpAndSettle();

      // Back on the list, and it says the weights were KEPT. Claiming a reclaim that never
      // happened would be a lie about the user's disk.
      expect(find.byKey(const ValueKey('k-models-notice')), findsOneWidget);
      expect(
        find.textContaining('org/repo:Q8_0 still uses them'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });
  });

  group('ParamEditor', () {
    Widget editor({
      Map<String, String> initial = const {},
      List<InvalidModelParam> invalid = const [],
      List<ModelParamWarning> warnings = const [],
      void Function(Map<String, String>)? onChanged,
    }) => ProviderScope(
      child: MaterialApp(
        theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
        home: FTheme(
          data: FThemes.neutral.light.desktop,
          child: FScaffold(
            child: ParamEditor(
              initial: initial,
              invalidParams: invalid,
              warnings: warnings,
              onChanged: onChanged ?? (_) {},
            ),
          ),
        ),
      ),
    );

    testWidgets('a model with no params says it runs on llama.cpp defaults', (
      tester,
    ) async {
      // A freshly imported model has no params at all, and that is the honest answer -- Nelle
      // writes none of its own into a section.
      await tester.pumpWidget(editor());
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('k-param-empty')), findsOneWidget);
    });

    testWidgets('errors join to rows BY KEY, and clear when the key changes', (
      tester,
    ) async {
      // Never by row id: a row must stop being marked the moment its key changes, and editing
      // one row must never unmark another.
      await tester.pumpWidget(
        editor(
          initial: const {'temprature': '0.7', 'top-k': '40'},
          invalid: [
            InvalidModelParam(
              key: 'temprature',
              reason: InvalidModelParamReason.unknown,
              message: '"temprature" is not a llama.cpp option.',
              suggestion: 'temperature',
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      // Row 0 is marked; row 1, whose key is fine, is not.
      expect(find.byKey(const ValueKey('k-param-error-0')), findsOneWidget);
      expect(find.byKey(const ValueKey('k-param-error-1')), findsNothing);
      expect(find.text('Did you mean temperature?'), findsOneWidget);

      // Retyping the bad key unmarks that row -- and only that row.
      await tester.enterText(
        find.byKey(const ValueKey('k-param-key-0')),
        'temperature',
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('k-param-error-0')), findsNothing);
    });

    testWidgets('the suggestion is a one-tap fix', (tester) async {
      Map<String, String>? emitted;
      await tester.pumpWidget(
        editor(
          initial: const {'temprature': '0.7'},
          invalid: [
            InvalidModelParam(
              key: 'temprature',
              reason: InvalidModelParamReason.unknown,
              message: 'nope',
              suggestion: 'temperature',
            ),
          ],
          onChanged: (params) => emitted = params,
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-param-suggest-0')));
      await tester.pumpAndSettle();

      // The server already knew what they meant.
      expect(emitted, {'temperature': '0.7'});
    });

    testWidgets('an out-of-range suggestion replaces the VALUE, not the key', (
      tester,
    ) async {
      // A suggestion means two different things, and one implementation for both is a bug.
      // For an `unknown` key it is the nearest real option, so it replaces the key. For an
      // `out_of_range` context size it is the largest value that would work -- so applying it
      // to the key field, which is what the existing one-tap fix did, renames `c` to
      // `4194304` and produces a second, stranger error.
      Map<String, String>? emitted;
      await tester.pumpWidget(
        editor(
          initial: const {'c': '900000000'},
          invalid: [
            InvalidModelParam(
              key: 'c',
              reason: InvalidModelParamReason.outOfRange,
              message: '900,000,000 is 6,866x this model’s trained window.',
              suggestion: '4194304',
            ),
          ],
          onChanged: (params) => emitted = params,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Use 4194304'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('k-param-suggest-0')));
      await tester.pumpAndSettle();

      expect(emitted, {'c': '4194304'}, reason: 'the key must survive');
    });

    testWidgets('a warning shows on its row, and is not an error', (
      tester,
    ) async {
      // A context past the trained window is legitimate -- that is what RoPE/YaRN extension is,
      // and llama.cpp itself only warns -- so the value SAVED. The row must say what was asked
      // for without claiming the save failed.
      await tester.pumpWidget(
        editor(
          initial: const {'c': '524288'},
          warnings: const [
            ModelParamWarning(
              key: 'c',
              message: '524,288 is 4.0x this model’s trained window (131,072).',
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('k-param-warning-0')), findsOneWidget);
      expect(find.byKey(const ValueKey('k-param-error-0')), findsNothing);
    });

    testWidgets('a refused row shows the error, never also a warning', (
      tester,
    ) async {
      // Stacking both would say the save did and did not happen.
      await tester.pumpWidget(
        editor(
          initial: const {'c': '900000000'},
          invalid: [
            InvalidModelParam(
              key: 'c',
              reason: InvalidModelParamReason.outOfRange,
              message: 'too big',
            ),
          ],
          warnings: const [ModelParamWarning(key: 'c', message: 'stale')],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('k-param-error-0')), findsOneWidget);
      expect(find.byKey(const ValueKey('k-param-warning-0')), findsNothing);
    });

    testWidgets('a row with an empty key is dropped, not sent as ""', (
      tester,
    ) async {
      Map<String, String>? emitted;
      await tester.pumpWidget(editor(onChanged: (params) => emitted = params));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-param-add')));
      await tester.pumpAndSettle();
      expect(emitted, isEmpty, reason: 'an unfilled row is not a parameter');

      await tester.enterText(
        find.byKey(const ValueKey('k-param-key-0')),
        'seed',
      );
      await tester.enterText(
        find.byKey(const ValueKey('k-param-value-0')),
        '42',
      );
      await tester.pumpAndSettle();
      expect(emitted, {'seed': '42'});
    });

    testWidgets('a refresh does NOT eat what the user is typing', (
      tester,
    ) async {
      // The rule this whole class is built around -- and the mechanism meant to serve it broke
      // it. Keying the editor on `params.hashCode` so a save re-seeds it looks right, but Dart's
      // `Map.hashCode` is **identity**-based: every catalog refresh parses a fresh Map, mints a
      // new key, destroys the State and throws away the half-typed row. Found by typing a
      // parameter into the running app and watching it vanish.
      //
      // Here: rebuild with an equal-by-content (but *different*) Map, and the typing survives.
      Map<String, String>? emitted;
      Widget host(Map<String, String> initial) => ProviderScope(
        child: MaterialApp(
          theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
          home: FTheme(
            data: FThemes.neutral.light.desktop,
            child: FScaffold(
              child: ParamEditor(
                key: const ValueKey('k-stable'),
                initial: initial,
                invalidParams: const [],
                onChanged: (params) => emitted = params,
              ),
            ),
          ),
        ),
      );

      await tester.pumpWidget(host({'temp': '0.7'}));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-param-add')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('k-param-key-1')),
        'seed',
      );
      await tester.pumpAndSettle();

      // A new Map, same content -- exactly what a catalog refresh hands over.
      await tester.pumpWidget(host({'temp': '0.7'}));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('k-param-key-1')),
        findsOneWidget,
        reason: 'the half-typed row survived the refresh',
      );
      expect(
        tester.widget<FTextField>(find.byKey(const ValueKey('k-param-key-1'))),
        isNotNull,
      );

      // ...and a *real* change (a successful save) does re-seed.
      await tester.pumpWidget(host({'temp': '0.9'}));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('k-param-key-1')), findsNothing);
      expect(emitted, isNotNull);
    });

    testWidgets('the editor fits a phone', (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(
        editor(
          initial: const {'a-very-long-parameter-key-name': 'and-a-long-value'},
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
    });
  });
}

void _activeRunTests() {
  group('a model with a run in flight', () {
    /// Hosts the detail screen with [runs] already registered — conversation id -> model id.
    Widget host(Map<String, String> runs) => ProviderScope(
      overrides: [
        dioProvider.overrideWithValue(
          stubDio((options) {
            if (options.path.contains('/api/llama/models')) {
              return jsonResponse({
                'models': [
                  {
                    'sectionId': 'org/repo:Q4_K_XL',
                    'alias': 'org/repo:Q4_K_XL',
                    'status': 'loaded',
                    'aliases': <String>[],
                  },
                ],
              });
            }
            return jsonResponse({
              'models': [_model()],
              'activeModelId': 'org/repo:Q4_K_XL',
              'globalModelParams': <String, String>{},
            });
          }),
        ),
        activeRunsProvider.overrideWith(() => _StubActiveRuns(runs)),
      ],
      child: MaterialApp(
        theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
        home: FTheme(
          data: FThemes.neutral.light.desktop,
          child: const ModelDetailScreen(modelId: 'org/repo:Q4_K_XL'),
        ),
      ),
    );

    /// A lazy `ListView` does not build what is off-screen, so on a normal viewport the action
    /// buttons do not exist to be found at all. (The delete test learned this the same way.)
    void tallViewport(WidgetTester tester) {
      tester.view.physicalSize = const Size(1200, 4000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
    }

    testWidgets('save and unload are locked, and the screen says why', (
      tester,
    ) async {
      tallViewport(tester);
      // All three of these go through llama.cpp and would kill the reply the user is watching:
      // unloading evicts the weights it is being generated from, saving rewrites `models.ini`
      // and reloads the router under the run, and removing deletes the section outright.
      await tester.pumpWidget(host({'conv-1': 'org/repo:Q4_K_XL'}));
      await tester.pumpAndSettle();

      expect(
        tester.widget<FButton>(find.byKey(const ValueKey('k-model-save'))).onPress,
        isNull,
      );
      expect(
        tester.widget<FButton>(find.byKey(const ValueKey('k-model-unload'))).onPress,
        isNull,
      );
      // A dead button with no explanation is a bug report.
      expect(find.byKey(const ValueKey('k-model-run-lock')), findsOneWidget);
    });

    testWidgets('bookkeeping that never touches llama.cpp stays available', (
      tester,
    ) async {
      tallViewport(tester);
      // Duplicating writes a new `models.ini` section. It does not reach the running model, so
      // locking it would be cargo-culting the run lock rather than applying it.
      await tester.pumpWidget(host({'conv-1': 'org/repo:Q4_K_XL'}));
      await tester.pumpAndSettle();

      expect(
        tester
            .widget<FButton>(find.byKey(const ValueKey('k-model-duplicate')))
            .onPress,
        isNotNull,
      );
    });

    testWidgets('a run on a DIFFERENT model locks nothing here', (tester) async {
      tallViewport(tester);
      await tester.pumpWidget(host({'conv-1': 'some/other:Q4_K_XL'}));
      await tester.pumpAndSettle();

      expect(
        tester.widget<FButton>(find.byKey(const ValueKey('k-model-save'))).onPress,
        isNotNull,
      );
      expect(find.byKey(const ValueKey('k-model-run-lock')), findsNothing);
    });
  });

  test('two conversations on one model: the first to finish must not unlock it', () {
    // Keyed by conversation, not by model, exactly for this. `runtime.modelsMax >= 2` exists so
    // two chats can be answered at once, and they can be answered by the *same* model. A bare
    // set of model ids would be cleared by whichever run finished first, unlocking a model that
    // is still generating — and the user unloads it out from under the other answer.
    final container = ProviderContainer();
    addTearDown(container.dispose);
    final runs = container.read(activeRunsProvider.notifier);

    runs.start('conv-1', 'org/repo:Q4_K_XL');
    runs.start('conv-2', 'org/repo:Q4_K_XL');
    expect(container.read(activeRunModelIdsProvider), {'org/repo:Q4_K_XL'});

    runs.end('conv-1');
    expect(
      container.read(activeRunModelIdsProvider),
      {'org/repo:Q4_K_XL'},
      reason: 'conv-2 is still generating on it',
    );

    runs.end('conv-2');
    expect(container.read(activeRunModelIdsProvider), isEmpty);
  });
}

class _StubActiveRuns extends ActiveRuns {
  _StubActiveRuns(this._initial);

  final Map<String, String> _initial;

  @override
  Map<String, String> build() => _initial;
}
