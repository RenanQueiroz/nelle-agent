import 'package:flutter/material.dart';
import 'package:forui/forui.dart';

import '../../api/settings_schema.dart';

/// One control per field type, and **nothing that knows what any field means**.
///
/// That is the bar. The moment this file special-cases `maxImageMegapixels`, the served
/// schema has been thrown away and every future setting needs a client release again.
/// Labels, help, bounds, options and defaults all arrive from the source.
class SettingsFieldControl extends StatelessWidget {
  const SettingsFieldControl({
    super.key,
    required this.field,
    required this.value,
    required this.onChanged,
  });

  final SettingsField field;

  /// The effective value: the draft if the user has touched it, else what the source
  /// holds, else the field's own default.
  final Object? value;
  final ValueChanged<Object?> onChanged;

  @override
  Widget build(BuildContext context) => switch (field) {
    final BooleanSettingsField it => _BooleanField(
      field: it,
      value: value is bool ? value! as bool : it.defaultValue,
      onChanged: onChanged,
    ),
    final TextSettingsField it => _TextField(
      field: it,
      value: value is String ? value! as String : it.defaultValue,
      onChanged: onChanged,
    ),
    final NumberSettingsField it => _NumberField(
      field: it,
      value: value is num ? (value! as num).toDouble() : it.defaultValue,
      onChanged: onChanged,
    ),
    final SelectSettingsField it => _SelectField(
      field: it,
      value: value is String ? value! as String : it.defaultValue,
      onChanged: onChanged,
    ),
    // A field type this build has never heard of. It renders as nothing, and the section
    // around it still renders -- one field from the future must not cost the user the
    // others, and must certainly not break the screen.
    UnknownSettingsField() => const SizedBox.shrink(),
  };
}

class _FieldFrame extends StatelessWidget {
  const _FieldFrame({required this.field, required this.child, this.trailing});

  final SettingsField field;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(field.label),
                    if (field.help.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          // The server's sentence. It is the only thing telling the user
                          // what this does, and a copy in the client goes stale.
                          field.help,
                          style: TextStyle(
                            fontSize: 11,
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              if (trailing != null) ...[const SizedBox(width: 12), trailing!],
            ],
          ),
          if (trailing == null) ...[const SizedBox(height: 8), child],
        ],
      ),
    );
  }
}

class _BooleanField extends StatelessWidget {
  const _BooleanField({
    required this.field,
    required this.value,
    required this.onChanged,
  });

  final BooleanSettingsField field;
  final bool value;
  final ValueChanged<Object?> onChanged;

  @override
  Widget build(BuildContext context) => _FieldFrame(
    field: field,
    // forui's switch. A Material `Switch` throws "No Material widget found" in this app
    // and paints a red error box where the control should be.
    trailing: FSwitch(
      key: ValueKey('k-setting-${field.key}'),
      value: value,
      onChange: onChanged,
    ),
    child: const SizedBox.shrink(),
  );
}

class _TextField extends StatefulWidget {
  const _TextField({
    required this.field,
    required this.value,
    required this.onChanged,
  });

  final TextSettingsField field;
  final String value;
  final ValueChanged<Object?> onChanged;

  @override
  State<_TextField> createState() => _TextFieldState();
}

class _TextFieldState extends State<_TextField> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.value,
  )..addListener(_emit);

  // FTextField exposes no `onChange`; the controller is the source of truth.
  void _emit() => widget.onChanged(_controller.text);

  @override
  void dispose() {
    _controller
      ..removeListener(_emit)
      ..dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => _FieldFrame(
    field: widget.field,
    child: FTextField(
      key: ValueKey('k-setting-${widget.field.key}'),
      control: FTextFieldControl.managed(controller: _controller),
      // `text` and `textarea` differ only in height -- which is the distinction
      // swagger_parser lost, and why 8,000 characters of custom instructions would have
      // been typed into a one-line box.
      maxLines: widget.field.multiline ? 8 : 1,
      minLines: widget.field.multiline ? 3 : 1,
      maxLength: widget.field.maxLength,
    ),
  );
}

class _NumberField extends StatefulWidget {
  const _NumberField({
    required this.field,
    required this.value,
    required this.onChanged,
  });

  final NumberSettingsField field;
  final double value;
  final ValueChanged<Object?> onChanged;

  @override
  State<_NumberField> createState() => _NumberFieldState();
}

class _NumberFieldState extends State<_NumberField> {
  late final TextEditingController _controller = TextEditingController(
    text: _format(widget.value),
  )..addListener(_emit);

  String _format(double value) =>
      widget.field.integer ? value.toInt().toString() : '$value';

  void _emit() {
    final parsed = num.tryParse(_controller.text.trim());
    widget.onChanged(
      parsed == null
          ? null
          : (widget.field.integer ? parsed.toInt() : parsed.toDouble()),
    );
  }

  @override
  void dispose() {
    _controller
      ..removeListener(_emit)
      ..dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final field = widget.field;
    final bounds = [
      if (field.min != null) 'min ${_format(field.min!)}',
      if (field.max != null) 'max ${_format(field.max!)}',
    ].join(' · ');

    return _FieldFrame(
      field: field,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          FTextField(
            key: ValueKey('k-setting-${field.key}'),
            control: FTextFieldControl.managed(controller: _controller),
            // The bounds are *shown*, not enforced here: the source validates, and the
            // server refuses by name. A second copy of the rule in the client is a copy
            // that drifts.
            keyboardType: TextInputType.numberWithOptions(
              decimal: !field.integer,
            ),
          ),
          if (bounds.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                bounds,
                style: TextStyle(
                  fontSize: 10,
                  color: Theme.of(context).colorScheme.outline,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _SelectField extends StatelessWidget {
  const _SelectField({
    required this.field,
    required this.value,
    required this.onChanged,
  });

  final SelectSettingsField field;
  final String value;
  final ValueChanged<Object?> onChanged;

  @override
  Widget build(BuildContext context) => _FieldFrame(
    field: field,
    child: FSelect<String>(
      key: ValueKey('k-setting-${field.key}'),
      items: {for (final option in field.options) option.label: option.value},
      control: FSelectControl.lifted(
        // A value the options do not offer -- a stored setting whose option the server has
        // since dropped -- shows as empty rather than as a lie.
        value: field.options.any((option) => option.value == value)
            ? value
            : null,
        onChange: onChanged,
      ),
    ),
  );
}
