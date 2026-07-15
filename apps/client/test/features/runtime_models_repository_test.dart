import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/runtime_install_event.dart';
import 'package:nelle_agent/src/features/models/llama_params_repository.dart';
import 'package:nelle_agent/src/features/models/models_repository.dart';

import '../helpers/fake_dio.dart';

Map<String, dynamic> _model({
  String id = 'org/repo:Q4_K_XL',
  bool pinned = false,
  Map<String, String> extra = const {},
}) => {
  'id': id,
  'name': id,
  'presetName': id,
  'source': 'huggingface',
  'pinned': pinned,
  'params': {'extra': extra},
  'createdAt': '2026-07-13T00:00:00.000Z',
};

Map<String, dynamic> _catalog({
  List<Map<String, dynamic>>? models,
  String? activeModelId,
  Map<String, String> globalModelParams = const {},
}) => {
  'models': models ?? [_model()],
  'activeModelId': activeModelId,
  'globalModelParams': globalModelParams,
};

void main() {
  group('RuntimeInstallEvent', () {
    RuntimeInstallEvent parse(Map<String, dynamic> data) =>
        RuntimeInstallEvent.fromEnvelope({'type': data['type'], 'data': data});

    test('reads every variant off the wire type', () {
      expect(
        parse({'type': 'runtime.install.started', 'mode': 'source-master'}),
        isA<InstallStartedEvent>().having(
          (e) => e.mode,
          'mode',
          'source-master',
        ),
      );
      expect(
        parse({
          'type': 'runtime.install.output',
          'stream': 'stdout',
          'line': '[ 41%] Building CUDA object',
        }),
        isA<InstallOutputEvent>()
            .having((e) => e.line, 'line', '[ 41%] Building CUDA object')
            .having((e) => e.isStderr, 'isStderr', false),
      );
      expect(
        parse({
          'type': 'runtime.install.failed',
          'error': {
            'code': 'runtime_install_failed',
            'message': 'Missing build dependency: git',
          },
        }),
        isA<InstallFailedEvent>().having(
          (e) => e.error.code,
          'code',
          'runtime_install_failed',
        ),
      );
    });

    test('stderr is a stream label, not a verdict', () {
      // A real llama.cpp build emitted 820 stdout lines and 2 stderr -- and succeeded. cmake
      // and git narrate progress on stderr. A client that reads `isStderr` as "failed" calls
      // a working build broken.
      final event = parse({
        'type': 'runtime.install.output',
        'stream': 'stderr',
        'line': 'Cloning into ...',
      });
      expect(
        event,
        isA<InstallOutputEvent>().having((e) => e.isStderr, 'isStderr', true),
      );
    });

    test(
      'the terminal event carries the status, so nothing needs refetching',
      () {
        final event = parse({
          'type': 'runtime.install.completed',
          'runtime': {
            'platform': 'linux',
            'arch': 'x64',
            'dataDir': '/data',
            'workspaceDir': '/home/user',
            'binaryPath': '/data/llama/bin/llama-server',
            'logPath': '/data/logs/llama-server.log',
            'installMode': 'source-master',
            'installed': true,
            'installedVersion': '99f3dc32',
            'latestVersion': '99f3dc32',
            'updateAvailable': false,
            'running': false,
            'pid': null,
            'host': '127.0.0.1',
            'port': 8080,
            'modelsMax': 1,
            'sleepIdleSeconds': 90,
            'activeModelId': null,
            'lastError': null,
          },
        });
        expect(
          event,
          isA<InstallCompletedEvent>()
              .having((e) => e.runtime.installed, 'installed', true)
              .having((e) => e.runtime.installedVersion, 'version', '99f3dc32'),
        );
      },
    );

    test('an unknown event never crashes a ten-minute build', () {
      expect(
        RuntimeInstallEvent.fromEnvelope({'type': 'runtime.install.rebooted'}),
        isA<UnknownInstallEvent>(),
      );
    });
  });

  group('ModelsRepository', () {
    test('a mutation applies the catalog the server answers with', () async {
      // Every mutation can move more than the row it touched: a duplicate *becomes* the
      // active model. A client that patched its own row and guessed at the rest would show
      // the wrong selection until the next refetch.
      final repo = ModelsRepository(
        stubDio(
          (options) => jsonResponse({
            'model': _model(id: 'org/repo:Q4_K_XL-copy'),
            'catalog': _catalog(
              models: [
                _model(),
                _model(id: 'org/repo:Q4_K_XL-copy'),
              ],
              activeModelId: 'org/repo:Q4_K_XL-copy',
            ),
          }),
        ),
      );

      final catalog = await repo.duplicate('org/repo:Q4_K_XL');
      expect(catalog.models, hasLength(2));
      expect(catalog.activeModelId, 'org/repo:Q4_K_XL-copy');
    });

    test('params are sent FLAT, and only what was touched', () async {
      // The read shape is `{contextSize?, extra}`; the write shape is a flat map that
      // replaces `extra` wholesale. Round-tripping the read shape back is a 400 -- which is
      // right, but it is not guessable.
      Map<String, dynamic>? sent;
      final repo = ModelsRepository(
        stubDio((options) {
          sent = (options.data as Map).cast<String, dynamic>();
          return jsonResponse({'model': _model(), 'catalog': _catalog()});
        }),
      );

      await repo.update('org/repo:Q4_K_XL', params: {'temp': '0.7'});
      expect(sent, {
        'params': {'temp': '0.7'},
      });
      expect(
        sent!.containsKey('name'),
        isFalse,
        reason: 'an untouched field is not rewritten',
      );
      expect(sent!.containsKey('pinned'), isFalse);
    });

    test('un-pinning is a field, and it is how an update lands', () async {
      Map<String, dynamic>? sent;
      final repo = ModelsRepository(
        stubDio((options) {
          sent = (options.data as Map).cast<String, dynamic>();
          return jsonResponse({
            'model': _model(pinned: false),
            'catalog': _catalog(models: [_model(pinned: false)]),
          });
        }),
      );

      await repo.update('org/repo:Q4_K_XL', pinned: false);
      expect(sent, {'pinned': false});
    });

    test('a refused save names EVERY bad key, not just the first', () async {
      // A form with three typos should light up three rows on one save, not on three. The
      // client joins them to rows by `key`, never by row id.
      final repo = ModelsRepository(
        stubDio(
          (options) => jsonResponse({
            'error': {
              'code': 'invalid_model_param',
              'message': '2 parameters are not valid.',
            },
            'invalidParams': [
              {
                'key': 'temprature',
                'reason': 'unknown',
                'message': '"temprature" is not a llama.cpp option.',
                'suggestion': 'temperature',
              },
              {
                'key': 'tpo-k',
                'reason': 'unknown',
                'message': '"tpo-k" is not a llama.cpp option.',
              },
            ],
          }, status: 400),
        ),
      );

      await expectLater(
        repo.update(
          'org/repo:Q4_K_XL',
          params: {'temprature': '0.7', 'tpo-k': '40'},
        ),
        throwsA(
          isA<InvalidModelParamsException>()
              .having((e) => e.invalidParams.map((p) => p.key), 'keys', [
                'temprature',
                'tpo-k',
              ])
              .having(
                (e) => e.invalidParams.first.suggestion,
                'suggestion',
                'temperature',
              )
              .having((e) => e.code, 'code', 'invalid_model_param'),
        ),
      );
    });
  });

  group('LlamaOptionCatalogue', () {
    test('accepted keys include every spelling AND the env names', () async {
      // `common/preset.cpp` builds the same union, which is why a validator that only knew
      // `ctx-size` would reject Nelle's own `models.ini`.
      final repo = LlamaParamsRepository(
        stubDio(
          (options) => jsonResponse({
            'available': true,
            'options': [
              {
                'keys': ['c', 'ctx-size'],
                'env': ['LLAMA_ARG_CTX_SIZE'],
                'help': 'size of the prompt context',
                'section': 'common',
              },
            ],
          }),
        ),
      );

      final keys = acceptedParamKeys(await repo.catalogue());
      expect(keys, containsAll(['c', 'ctx-size', 'LLAMA_ARG_CTX_SIZE']));
    });

    test('an unavailable catalogue is a state, not an error', () async {
      // No binary, or a `--help` the server could not parse. The *server* then skips the
      // unknown-key check entirely -- refusing to save a parameter because Nelle could not run
      // a binary is worse than the typo -- so the client must not invent a validator either.
      final repo = LlamaParamsRepository(
        stubDio(
          (options) =>
              jsonResponse({'available': false, 'options': <Object>[]}),
        ),
      );

      final catalogue = await repo.catalogue();
      expect(catalogue.available, isFalse);
      expect(acceptedParamKeys(catalogue), isEmpty);
    });
  });
}
