// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'runtime_status.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

RuntimeStatus _$RuntimeStatusFromJson(Map<String, dynamic> json) =>
    RuntimeStatus(
      platform: json['platform'] as String,
      arch: json['arch'] as String,
      dataDir: json['dataDir'] as String,
      binaryPath: json['binaryPath'] as String?,
      logPath: json['logPath'] as String,
      installMode: RuntimeStatusInstallMode.fromJson(
        json['installMode'] as String,
      ),
      installed: json['installed'] as bool,
      installedVersion: json['installedVersion'] as String?,
      latestVersion: json['latestVersion'] as String?,
      updateAvailable: json['updateAvailable'] as bool,
      running: json['running'] as bool,
      pid: json['pid'] as num?,
      host: json['host'] as String,
      port: json['port'] as num,
      modelsMax: json['modelsMax'] as num,
      sleepIdleSeconds: json['sleepIdleSeconds'] as num,
      activeModelId: json['activeModelId'] as String?,
      lastError: json['lastError'] as String?,
    );

Map<String, dynamic> _$RuntimeStatusToJson(RuntimeStatus instance) =>
    <String, dynamic>{
      'platform': instance.platform,
      'arch': instance.arch,
      'dataDir': instance.dataDir,
      'binaryPath': instance.binaryPath,
      'logPath': instance.logPath,
      'installMode': instance.installMode,
      'installed': instance.installed,
      'installedVersion': instance.installedVersion,
      'latestVersion': instance.latestVersion,
      'updateAvailable': instance.updateAvailable,
      'running': instance.running,
      'pid': instance.pid,
      'host': instance.host,
      'port': instance.port,
      'modelsMax': instance.modelsMax,
      'sleepIdleSeconds': instance.sleepIdleSeconds,
      'activeModelId': instance.activeModelId,
      'lastError': instance.lastError,
    };
