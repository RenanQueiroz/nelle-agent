import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';

/// Favourite models: a **set**, not a field.
///
/// That is why they stay out of the settings registry and out of the generic renderer --
/// the registry has a type for a boolean, a number, a string and a choice, and none for
/// "an ordered set of model ids". Knowing where that line falls is what keeps the generic
/// renderer generic.
///
/// They are stored server-side (`GET`/`PATCH /api/settings/preferences`) because they
/// follow the *user*: they lived in the browser's `localStorage` once, so a phone started
/// with an empty list and could never be told about the desktop's.
final favoriteModelsProvider =
    AsyncNotifierProvider<FavoriteModelsNotifier, List<String>>(
      FavoriteModelsNotifier.new,
    );

class FavoriteModelsNotifier extends AsyncNotifier<List<String>> {
  @override
  Future<List<String>> build() async {
    final response = await ref
        .watch(dioProvider)
        .get<Map<String, Object?>>('/api/settings/preferences');
    return _read(response.statusCode, response.data);
  }

  bool isFavorite(String modelId) =>
      state.valueOrNull?.contains(modelId) ?? false;

  Future<void> toggle(String modelId) async {
    final current = state.valueOrNull ?? const <String>[];
    final next = current.contains(modelId)
        ? [...current.where((id) => id != modelId)]
        : [...current, modelId];

    // Optimistic: a star is not worth a spinner. It goes back if the server refuses.
    state = AsyncValue.data(next);
    final response = await ref
        .read(dioProvider)
        .patch<Map<String, Object?>>(
          '/api/settings/preferences',
          data: {'favoriteModelIds': next},
        );
    try {
      state = AsyncValue.data(_read(response.statusCode, response.data));
    } catch (_) {
      // Put the star back rather than leave the user looking at a favourite that was
      // never saved.
      state = AsyncValue.data(current);
    }
  }

  List<String> _read(int? status, Map<String, Object?>? body) {
    if (status == null || status < 200 || status >= 300 || body == null) {
      throw Exception('Favourites request failed ($status).');
    }
    // A favourite whose model has since gone from `models.ini` is *filtered* by the
    // server, not deleted: a model that reappears brings its favourite back. So the list
    // this returns can be shorter than the one that was sent, and that is correct.
    return (body['favoriteModelIds'] as List?)?.cast<String>() ?? const [];
  }
}

/// Favourites first, then the rest, each keeping the catalog's order.
///
/// The point of a favourite is to be near the top of a list that may hold dozens of
/// models, so the sort *is* the feature.
List<String> sortByFavorite(Iterable<String> modelIds, List<String> favorites) {
  final favored = <String>[];
  final rest = <String>[];
  for (final id in modelIds) {
    (favorites.contains(id) ? favored : rest).add(id);
  }
  return [...favored, ...rest];
}
