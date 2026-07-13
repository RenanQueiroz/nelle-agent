import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/features/models/favorites.dart';

import '../helpers/fake_dio.dart';

void main() {
  group('sortByFavorite', () {
    test('favourites come first, and each group keeps the catalog order', () {
      // The point of a favourite is to be near the top of a list that may hold dozens of
      // models, so the sort *is* the feature.
      expect(sortByFavorite(['a', 'b', 'c', 'd'], ['c', 'a']), [
        'a',
        'c',
        'b',
        'd',
      ]);
    });

    test('no favourites changes nothing', () {
      expect(sortByFavorite(['a', 'b'], []), ['a', 'b']);
    });

    test(
      'a favourite for a model that is not in the catalog is simply not shown',
      () {
        // The server filters a favourite whose model has gone from `models.ini` -- it does
        // not delete it, so a model that reappears brings its favourite back.
        expect(sortByFavorite(['a', 'b'], ['gone', 'b']), ['b', 'a']);
      },
    );
  });

  group('toggling', () {
    test('a star is optimistic, and goes back if the server refuses', () async {
      var refuse = false;
      final container = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio((options) {
              if (options.method == 'PATCH' && refuse) {
                return jsonResponse({
                  'error': {'code': 'invalid_request', 'message': 'no'},
                }, status: 400);
              }
              final sent = options.method == 'PATCH'
                  ? ((options.data as Map)['favoriteModelIds'] as List)
                        .cast<String>()
                  : <String>[];
              return jsonResponse({'favoriteModelIds': sent});
            }),
          ),
        ],
      );
      addTearDown(container.dispose);

      expect(await container.read(favoriteModelsProvider.future), isEmpty);

      await container.read(favoriteModelsProvider.notifier).toggle('a');
      expect(container.read(favoriteModelsProvider).valueOrNull, ['a']);

      // Now the server says no. A star is not worth a spinner -- but it must not lie
      // either, so it goes back rather than leaving the user looking at a favourite that
      // was never saved.
      refuse = true;
      await container.read(favoriteModelsProvider.notifier).toggle('b');
      expect(container.read(favoriteModelsProvider).valueOrNull, ['a']);
    });

    test('toggling twice removes it', () async {
      final container = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio((options) {
              final sent = options.method == 'PATCH'
                  ? ((options.data as Map)['favoriteModelIds'] as List)
                        .cast<String>()
                  : <String>[];
              return jsonResponse({'favoriteModelIds': sent});
            }),
          ),
        ],
      );
      addTearDown(container.dispose);

      await container.read(favoriteModelsProvider.future);
      final notifier = container.read(favoriteModelsProvider.notifier);

      await notifier.toggle('a');
      expect(container.read(favoriteModelsProvider).valueOrNull, ['a']);
      await notifier.toggle('a');
      expect(container.read(favoriteModelsProvider).valueOrNull, isEmpty);
    });
  });
}
