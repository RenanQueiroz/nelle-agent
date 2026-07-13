import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/invalid_model_param.dart';
import 'models_controller.dart';
import 'models_repository.dart';
import 'param_editor.dart';

/// The `[*]` section: applied to every model, overridden by a model's own params.
///
/// The **same** [ParamEditor] as model detail — one widget, two scopes. And a full replacement,
/// which is what makes a global context cap *removable*: an empty map clears the section.
class GlobalParamsScreen extends ConsumerStatefulWidget {
  const GlobalParamsScreen({super.key});

  @override
  ConsumerState<GlobalParamsScreen> createState() => _GlobalParamsScreenState();
}

class _GlobalParamsScreenState extends ConsumerState<GlobalParamsScreen> {
  Map<String, String> _params = const {};
  List<InvalidModelParam> _invalid = const [];
  bool _saving = false;
  String? _notice;

  @override
  Widget build(BuildContext context) {
    final catalog = ref.watch(modelCatalogProvider).valueOrNull;
    final theme = Theme.of(context);

    return FScaffold(
      header: FHeader.nested(
        title: const Text('Global parameters'),
        prefixes: [
          FHeaderAction.back(
            key: const ValueKey('k-global-params-back'),
            onPress: Navigator.of(context).pop,
          ),
        ],
      ),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: catalog == null
              ? const Center(child: CircularProgressIndicator())
              : ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                  children: [
                    Text(
                      'Written to the [*] section of models.ini and applied to every model. '
                      'A model’s own parameters override these.',
                      style: TextStyle(
                        fontSize: 12,
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      // Sampling belongs to the model, not to Pi's requests: Pi sends no sampling
                      // parameters at all, so llama.cpp's launch flags are what every conversation
                      // runs with.
                      'Sampling lives here: temp, top-k, top-p, min-p, seed, repeat-penalty. '
                      'An unknown key stops llama-server from starting, so Nelle checks them '
                      'against llama-server --help before saving.',
                      style: TextStyle(
                        fontSize: 11,
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 16),
                    if (_notice != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: Text(
                          _notice!,
                          key: const ValueKey('k-global-params-notice'),
                          style: TextStyle(
                            fontSize: 12,
                            color: theme.colorScheme.error,
                          ),
                        ),
                      ),
                    ParamEditor(
                      // Stable, for the same reason as model detail: Map.hashCode is identity-based.
                      key: const ValueKey('k-global-params-editor'),
                      initial: catalog.globalModelParams,
                      invalidParams: _invalid,
                      onChanged: (params) => _params = params,
                    ),
                    const SizedBox(height: 12),
                    FButton(
                      key: const ValueKey('k-global-params-save'),
                      onPress: _saving ? null : _save,
                      child: Text(_saving ? 'Saving…' : 'Save'),
                    ),
                  ],
                ),
        ),
      ),
    );
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _notice = null;
    });
    try {
      await ref.read(modelCatalogProvider.notifier).saveGlobalParams(_params);
      setState(() => _invalid = const []);
    } on InvalidModelParamsException catch (error) {
      setState(() => _invalid = error.invalidParams);
    } catch (error) {
      setState(() => _notice = '$error');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }
}
