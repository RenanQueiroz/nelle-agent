// ignore_for_file: avoid_print
// Drives every M7 repository against a **live** Nelle server, with the client's own code.
//
// A repository that has only ever met a stub has never met the wire. The unit tests pin the
// shapes we *believe* the server sends; this asks it. That distinction has caught something in
// every milestone so far.
//
//   1. Start Nelle (`bun run serve`) and llama.cpp (`POST /api/runtime/start`).
//   2. cd apps/client && flutter test tool/t4_smoke.dart
//
// It is a `flutter test` and not a `dart run` (which is how `lan_smoke.dart` goes) for a dull
// reason: these repositories declare their Riverpod providers in the same file as the class, so
// importing one pulls in Flutter, and the pure Dart VM crashes in its own FFI transformer trying
// to compile it. Living in tool/ keeps it out of the default `flutter test` sweep.
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/runtime_install_event.dart';
import 'package:nelle_agent/src/features/chat/sse_transport.dart';
import 'package:nelle_agent/src/features/models/huggingface_repository.dart';
import 'package:nelle_agent/src/features/models/llama_params_repository.dart';
import 'package:nelle_agent/src/features/models/llama_repository.dart';
import 'package:nelle_agent/src/features/models/models_repository.dart';
import 'package:nelle_agent/src/features/runtime/runtime_repository.dart';

void main() {
  final dio = Dio(
    BaseOptions(
      baseUrl: 'http://127.0.0.1:8787',
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 30),
      validateStatus: (_) => true,
    ),
  );

  test(
    'every M7 repository, against the live server',
    () async {
      final runtime = RuntimeRepository(dio, SseTransport(dio));
      final models = ModelsRepository(dio);
      final llama = LlamaRepository(dio);
      final params = LlamaParamsRepository(dio);
      final hf = HuggingFaceRepository(dio);

      final status = await runtime.status(checkLatest: true);
      print(
        'runtime   : installed=${status.installed} running=${status.running} '
        'mode=${status.installMode.name} version=${status.installedVersion} '
        'updateAvailable=${status.updateAvailable} lastError=${status.lastError}',
      );

      final props = await runtime.props();
      print(
        'router    : role=${props.role} maxInstances=${props.maxInstances}',
      );

      final tail = await runtime.logs(maxBytes: 500);
      print('logs      : ${tail.text.length} chars');

      final catalog = await models.catalog();
      print(
        'catalog   : ${catalog.models.length} models, active=${catalog.activeModelId}',
      );
      for (final m in catalog.models) {
        print(
          '            pinned=${m.pinned}  extra=${m.params.extra}  ${m.id}',
        );
      }

      final routerModels = await llama.list();
      print(
        'router    : ${routerModels.length} models (cache strangers filtered)',
      );

      final cat = await params.catalogue();
      final keys = acceptedParamKeys(cat);
      print(
        'params    : available=${cat.available} options=${cat.options.length} '
        'acceptedKeys=${keys.length}',
      );
      print(
        '            c=${keys.contains('c')} ctx-size=${keys.contains('ctx-size')} '
        'LLAMA_ARG_CTX_SIZE=${keys.contains('LLAMA_ARG_CTX_SIZE')} '
        'stop-timeout=${keys.contains('stop-timeout')}',
      );

      final results = await hf.search('gemma-4-E2B-it-qat');
      final first = results.first;
      print(
        'hf search : ${results.length} repos; ${first.id} -> '
        '${first.quants.map((q) => q.quant).join(', ')}',
      );

      // The install stream. llama.cpp is already installed here, so this would rebuild from
      // source -- T3 drove a real one end to end (824 events). What is checked here is that the
      // stream *opens* and its first event parses through the hand-written union.
      final firstEvent = await runtime.install().first;
      print('install   : first event = ${firstEvent.runtimeType}');

      expect(status.installed, isTrue);
      expect(catalog.models, isNotEmpty);
      expect(cat.available, isTrue);
      // `--help` never prints this one; only PRESET_ONLY_KEYS keeps the validator from calling a
      // key llama-server is perfectly happy with a typo.
      expect(keys, contains('stop-timeout'));
      expect(results, isNotEmpty);
      expect(firstEvent, isA<InstallStartedEvent>());
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
