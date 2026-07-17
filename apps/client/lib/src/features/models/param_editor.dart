import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/invalid_model_param.dart';
import '../../api/generated/models/invalid_model_param_reason.dart';
import '../../api/generated/models/model_param_warning.dart';

/// One row of the free-form `models.ini` param table.
///
/// The **id** is stable and the **key** is not: the user retypes keys constantly. That
/// distinction is the whole design (see [ParamEditor]).
class ParamRow {
  ParamRow({required this.id, this.key = '', this.value = ''});

  final int id;
  String key;
  String value;
}

/// The free-form `models.ini` parameter table, used by model detail *and* the global `[*]`
/// section — one widget, two scopes.
///
/// Three rules, each of which was a bug somewhere before it was a rule:
///
/// 1. **The client never validates a key.** Keys are checked against the *binary* —
///    `llama-server --help`, parsed by the server — and an unknown key is fatal: llama-server
///    refuses to start with `option '...' not recognized in preset`. A second copy of that rule
///    living in the client is exactly how it goes stale on the next llama.cpp upgrade. Ship the
///    keys; render the server's refusal.
///
/// 2. **Errors are joined to rows by `key`, never by row id.** A row must stop being marked the
///    moment its key changes, and editing one row must never unmark another. (Two rows with the
///    same bad key therefore both light up, which is correct.)
///
/// 3. **A refresh must never overwrite what the user is typing.** In Flutter that means the
///    `TextEditingController`s are created once per row and *not* rebuilt from server state on
///    every rebuild — which is what would eat keystrokes.
class ParamEditor extends ConsumerStatefulWidget {
  const ParamEditor({
    super.key,
    required this.initial,
    required this.invalidParams,
    this.warnings = const [],
    required this.onChanged,
  });

  final Map<String, String> initial;

  /// From the server's 400. It names **every** offending key, so a form with three typos lights
  /// up three rows on one save rather than on three.
  final List<InvalidModelParam> invalidParams;

  /// From a save that **succeeded**. A context past the model's trained window is legitimate —
  /// that is what RoPE/YaRN extension is, and llama.cpp itself only warns — so the value lands
  /// and the row says what was asked for. Amber, never red: nothing here failed.
  final List<ModelParamWarning> warnings;

  final void Function(Map<String, String>) onChanged;

  @override
  ConsumerState<ParamEditor> createState() => ParamEditorState();
}

class ParamEditorState extends ConsumerState<ParamEditor> {
  late List<ParamRow> _rows;
  final Map<int, TextEditingController> _keyControllers = {};
  final Map<int, TextEditingController> _valueControllers = {};
  int _nextId = 0;

  @override
  void initState() {
    super.initState();
    _seed();
  }

  void _seed() {
    _rows = [
      for (final entry in widget.initial.entries)
        ParamRow(id: _nextId++, key: entry.key, value: entry.value),
    ];
  }

  @override
  void didUpdateWidget(ParamEditor oldWidget) {
    super.didUpdateWidget(oldWidget);
    // **Re-seed only when the SAVED params actually changed**, by content.
    //
    // The obvious approach -- keying this widget on `params.hashCode` so a save rebuilds it --
    // is a trap: Dart's `Map.hashCode` is **identity**-based, so every catalog refresh parses a
    // fresh Map, produces a new key, destroys this State and throws away whatever the user was
    // in the middle of typing. Which is exactly the rule this class is built around, violated by
    // the mechanism meant to serve it. (Found by typing a parameter and watching it vanish.)
    if (!_sameContent(oldWidget.initial, widget.initial)) {
      for (final controller in [
        ..._keyControllers.values,
        ..._valueControllers.values,
      ]) {
        controller.dispose();
      }
      _keyControllers.clear();
      _valueControllers.clear();
      _seed();
    }
  }

  static bool _sameContent(Map<String, String> a, Map<String, String> b) {
    if (a.length != b.length) return false;
    for (final entry in a.entries) {
      if (b[entry.key] != entry.value) return false;
    }
    return true;
  }

  @override
  void dispose() {
    for (final controller in _keyControllers.values) {
      controller.dispose();
    }
    for (final controller in _valueControllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  /// One controller per row, created **once** and kept. forui's `FTextField` has no `onChange`,
  /// so the change comes from a listener — which is also how the settings fields do it.
  TextEditingController _controller(
    Map<int, TextEditingController> pool,
    int id,
    String initial, {
    required void Function(String) onChanged,
  }) => pool.putIfAbsent(id, () {
    final controller = TextEditingController(text: initial);
    controller.addListener(() => onChanged(controller.text));
    return controller;
  });

  Map<String, String> get params => {
    for (final row in _rows)
      if (row.key.trim().isNotEmpty) row.key.trim(): row.value.trim(),
  };

  void _emit() => widget.onChanged(params);

  void _add() {
    setState(() => _rows = [..._rows, ParamRow(id: _nextId++)]);
    _emit();
  }

  void _removeRow(int id) {
    setState(() => _rows = _rows.where((row) => row.id != id).toList());
    _keyControllers.remove(id)?.dispose();
    _valueControllers.remove(id)?.dispose();
    _emit();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // Rule 2: keyed by the offending key, never by row id.
    final errorsByKey = {
      for (final invalid in widget.invalidParams) invalid.key: invalid,
    };
    final warningsByKey = {
      for (final warning in widget.warnings) warning.key: warning,
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final row in _rows)
          _Row(
            key: ValueKey('k-param-row-${row.id}'),
            row: row,
            error: errorsByKey[row.key.trim()],
            warning: warningsByKey[row.key.trim()],
            keyController: _controller(
              _keyControllers,
              row.id,
              row.key,
              onChanged: (value) {
                // setState so the error join (by key) re-evaluates as the key is retyped.
                setState(() => row.key = value);
                _emit();
              },
            ),
            valueController: _controller(
              _valueControllers,
              row.id,
              row.value,
              onChanged: (value) {
                row.value = value;
                _emit();
              },
            ),
            onRemove: () => _removeRow(row.id),
            // **A suggestion does not always mean the key.** For an `unknown` key it is the
            // nearest real option (`ctx-siz` -> `ctx-size`), so it replaces the key. For an
            // `out_of_range` context size it is the largest value that *would* work
            // (`4194304`), so it replaces the value. Applying both to the key field — the
            // obvious single implementation — renames `c` to `4194304` and produces a second,
            // stranger error.
            onAcceptSuggestion: (suggestion) {
              final error = errorsByKey[row.key.trim()];
              if (error?.reason == InvalidModelParamReason.outOfRange) {
                setState(() => row.value = suggestion);
                _valueControllers[row.id]?.text = suggestion;
              } else {
                setState(() => row.key = suggestion);
                _keyControllers[row.id]?.text = suggestion;
              }
              _emit();
            },
          ),
        if (_rows.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(
              // The honest answer for a freshly imported model: it runs on llama.cpp's own
              // defaults, and Nelle writes none of its own into a section.
              'No parameters. This model runs on llama.cpp’s defaults.',
              key: const ValueKey('k-param-empty'),
              style: TextStyle(
                fontSize: 12,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerLeft,
          child: FButton(
            key: const ValueKey('k-param-add'),
            onPress: _add,
            child: const Text('Add parameter'),
          ),
        ),
      ],
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({
    super.key,
    required this.row,
    required this.error,
    required this.warning,
    required this.keyController,
    required this.valueController,
    required this.onRemove,
    required this.onAcceptSuggestion,
  });

  final ParamRow row;
  final InvalidModelParam? error;
  final ModelParamWarning? warning;
  final TextEditingController keyController;
  final TextEditingController valueController;
  final VoidCallback onRemove;
  final ValueChanged<String> onAcceptSuggestion;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              // Flexed, never fixed. A phone is not a narrow desktop, and an unflexed Row is
              // how M6 overflowed the composer by 91px on Android.
              Expanded(
                flex: 4,
                child: FTextField(
                  key: ValueKey('k-param-key-${row.id}'),
                  control: FTextFieldControl.managed(controller: keyController),
                  hint: 'ctx-size',
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                flex: 3,
                child: FTextField(
                  key: ValueKey('k-param-value-${row.id}'),
                  control: FTextFieldControl.managed(
                    controller: valueController,
                  ),
                  hint: '32768',
                ),
              ),
              const SizedBox(width: 4),
              // A ghost FButton.icon (sm, to sit level with the 36px value field), not a Material
              // IconButton: forui over a bare FScaffold has no Material ancestor, so an ink-splash
              // widget throws "No Material widget found".
              FButton.icon(
                key: ValueKey('k-param-remove-${row.id}'),
                size: FButtonSizeVariant.sm,
                variant: FButtonVariant.ghost,
                onPress: onRemove,
                child: Icon(
                  FLucideIcons.trash2,
                  size: 16,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
          if (error != null) ...[
            Padding(
              padding: const EdgeInsets.only(left: 4, top: 2),
              child: Text(
                // The server's own sentence, which names the key. One line of red text under a
                // form of ten rows tells the user nothing they can act on.
                error!.message,
                key: ValueKey('k-param-error-${row.id}'),
                style: TextStyle(fontSize: 11, color: theme.colorScheme.error),
              ),
            ),
            if (error!.suggestion != null)
              Padding(
                padding: const EdgeInsets.only(left: 4, top: 2),
                child: GestureDetector(
                  key: ValueKey('k-param-suggest-${row.id}'),
                  onTap: () => onAcceptSuggestion(error!.suggestion!),
                  child: Text(
                    // The fix is one tap. The server already knows what they meant — but it
                    // means two different things: a nearer *key* for a typo, and a workable
                    // *value* for a context size past the ceiling. Say which.
                    error!.reason == InvalidModelParamReason.outOfRange
                        ? 'Use ${error!.suggestion}'
                        : 'Did you mean ${error!.suggestion}?',
                    style: TextStyle(
                      fontSize: 11,
                      decoration: TextDecoration.underline,
                      color: theme.colorScheme.primary,
                    ),
                  ),
                ),
              ),
          ],
          // Amber, and only when the row did not also fail: a row cannot be both refused and
          // merely warned about, and stacking the two would say the save both did and did not
          // happen.
          if (error == null && warning != null)
            Padding(
              padding: const EdgeInsets.only(left: 4, top: 2),
              child: Text(
                warning!.message,
                key: ValueKey('k-param-warning-${row.id}'),
                style: const TextStyle(
                  fontSize: 11,
                  color: Color(
                    0xFFB45309,
                  ), // amber-700: legible on light and dark.
                ),
              ),
            ),
        ],
      ),
    );
  }
}
