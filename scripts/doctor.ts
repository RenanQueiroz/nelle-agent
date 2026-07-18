/**
 * `bun run doctor` — what this machine has, what it is missing, and the exact command to fix it.
 *
 * **It checks and reports. It installs nothing.** That is a design decision, not timidity:
 *
 * 1. **sudo.** `libsecret`, `cmake`, KVM group membership all need root. A setup script that asks
 *    for your root password is one people are right to refuse.
 * 2. **There is no single correct way.** Flutter installs via git clone, a tarball, `fvm`, `asdf`,
 *    or (macOS only) a Homebrew cask. Picking one for the user fights the one they already chose,
 *    and the failure mode is *two SDKs and a PATH fight* — strictly worse than not installing.
 * 3. **"Install X" is not idempotent when X already exists elsewhere.** Re-running setup must never
 *    be able to make things worse.
 * 4. **Licences and interactivity.** `sdkmanager --licenses` is an interactive y/N loop; Xcode needs
 *    an Apple ID. A script cannot honestly automate consent.
 * 5. **Chicken-and-egg.** This runs *under Bun*. It can never install Bun.
 *
 * But it does the *hard* half: knowing what is needed, at what version, and the right command for
 * the OS it is running on. That is the part that costs someone an afternoon.
 *
 * **"Required" is relative to the work.** A server-only contributor is not failed for lacking the
 * Android SDK. Only things required for what this host can actually do make the exit code non-zero.
 */

import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {hostCapabilities} from './lib/hostCapabilities.ts';
import {createAppPaths} from '../apps/server/src/lib/paths.ts';

type Status = 'ok' | 'missing' | 'stale' | 'optional-missing';

type Check = {
  name: string;
  status: Status;
  /** What we found, if anything. */
  found?: string;
  /** Why it matters — only shown when it is not `ok`. */
  needed?: string;
  /** The exact command(s) to fix it, for THIS os. */
  fix?: string[];
};

const host = hostCapabilities();

// --- helpers ---------------------------------------------------------------------------------

async function run(command: string[]): Promise<{ok: boolean; out: string}> {
  try {
    const proc = Bun.spawn(command, {stdout: 'pipe', stderr: 'pipe'});
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    return {ok: (await proc.exited) === 0, out: `${out}${err}`.trim()};
  } catch {
    return {ok: false, out: ''};
  }
}

function which(binary: string): string | null {
  const paths = (process.env.PATH ?? '').split(path.delimiter);
  for (const directory of paths) {
    const candidate = path.join(directory, binary);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** `1.2.3` -> `[1, 2, 3]`, for comparing versions without pulling in semver. */
function versionParts(value: string): number[] {
  return (value.match(/\d+/g) ?? []).slice(0, 3).map(Number);
}

function atLeast(found: string, wanted: string): boolean {
  const a = versionParts(found);
  const b = versionParts(wanted);
  for (let i = 0; i < b.length; i += 1) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

// --- the checks ------------------------------------------------------------------------------

async function checkBun(): Promise<Check> {
  // Tier 2, and the chicken-and-egg one: we are *running* under Bun, so it exists. `.bun-version`
  // is the exact pin — CI reads it (`setup-bun`'s `bun-version-file`), so local == pin is what
  // "tested the same thing CI runs" means. `engines.bun` stays the floor for a fresh machine.
  const pin = (
    await Bun.file('.bun-version')
      .text()
      .catch(() => '')
  ).trim();
  const found = Bun.version;
  if (!pin || found === pin) {
    return {name: `Bun == ${pin || Bun.version}`, status: 'ok', found};
  }
  const ahead = atLeast(found, pin);
  return {
    name: `Bun == ${pin}`,
    status: 'stale',
    found,
    needed: 'everything — the server, the tests, the scripts. CI runs the pinned version',
    fix: ahead
      ? [
          '# Local Bun is AHEAD of the pin. Run the gates (bun run test), then bump the pin:',
          `echo "${found}" > .bun-version   # CI follows automatically`,
        ]
      : [
          host.os === 'macos'
            ? 'brew upgrade bun   # or `bun upgrade` — match how Bun was installed'
            : 'bun upgrade   # or your package manager — match how Bun was installed',
          '# If that lands you AHEAD of the pin: run the gates, then bump .bun-version.',
          '# Avoid installing a second Bun beside an existing one — upgrade in place.',
        ],
  };
}

async function checkNodeModules(): Promise<Check> {
  const present = existsSync('node_modules/.bin') || existsSync('node_modules/zod');
  return {
    name: 'bun install (node_modules)',
    status: present ? 'ok' : 'missing',
    needed: 'the server and its tests',
    fix: ['bun install'],
  };
}

async function checkFlutter(): Promise<Check> {
  const binary = which('flutter');
  if (!binary) {
    return {
      name: 'Flutter SDK',
      status: 'missing',
      needed: 'any work on apps/client (the only client)',
      fix:
        host.os === 'macos'
          ? [
              'brew install --cask flutter',
              '# or a git clone, if you prefer to manage the SDK yourself.',
            ]
          : [
              'git clone -b stable https://github.com/flutter/flutter.git ~/development/flutter',
              'export PATH="$HOME/development/flutter/bin:$PATH"   # add to your shell rc',
              "# Homebrew's flutter is a macOS-only cask -- on Linux it cannot install.",
            ],
    };
  }

  // The Dart constraint in pubspec is the real requirement.
  const pubspec = await Bun.file(path.join('apps', 'client', 'pubspec.yaml'))
    .text()
    .catch(() => '');
  const wantedDart = /sdk:\s*\^?([\d.]+)/.exec(pubspec)?.[1] ?? '3.12.0';

  const version = await run(['flutter', '--version']);
  const dart = /Dart\s+(?:SDK\s+version:\s*)?([\d.]+)/.exec(version.out)?.[1];
  const flutter = /Flutter\s+([\d.]+)/.exec(version.out)?.[1] ?? 'unknown';

  if (dart && !atLeast(dart, wantedDart)) {
    return {
      name: 'Flutter SDK',
      status: 'stale',
      found: `Flutter ${flutter} (Dart ${dart})`,
      needed: `apps/client/pubspec.yaml wants Dart >= ${wantedDart}`,
      fix: ['flutter upgrade'],
    };
  }

  // The exact pin in `environment.flutter` is what CI runs (flutter-action's
  // `flutter-version-file`), and `flutter pub get` refuses a mismatched local SDK — so a
  // mismatch here is not cosmetic, it blocks client work until the local SDK and pin agree.
  const wantedFlutter = /^ {2}flutter:\s*([\d.]+)/m.exec(pubspec)?.[1];
  if (wantedFlutter && flutter !== 'unknown' && flutter !== wantedFlutter) {
    return {
      name: 'Flutter SDK',
      status: 'stale',
      found: `Flutter ${flutter} (Dart ${dart ?? '?'})`,
      needed: `pubspec.yaml pins Flutter ${wantedFlutter} exactly; CI runs the pin`,
      fix: atLeast(flutter, wantedFlutter)
        ? [
            '# Local Flutter is AHEAD of the pin. Run the client gates, then bump the pin:',
            `#   apps/client/pubspec.yaml -> environment.flutter: ${flutter}`,
          ]
        : ['flutter upgrade   # if that lands you AHEAD of the pin: test, then bump it'],
    };
  }
  return {name: 'Flutter SDK', status: 'ok', found: `Flutter ${flutter} (Dart ${dart ?? '?'})`};
}

async function checkPubGet(): Promise<Check> {
  const present = existsSync(path.join('apps', 'client', '.dart_tool', 'package_config.json'));
  return {
    name: 'flutter pub get (apps/client)',
    status: present ? 'ok' : 'missing',
    needed: 'any work on apps/client',
    fix: ['cd apps/client && flutter pub get'],
  };
}

async function checkMarionette(): Promise<Check> {
  const pubCacheBin = path.join(os.homedir(), '.pub-cache', 'bin');
  const onPath = (process.env.PATH ?? '').split(path.delimiter).includes(pubCacheBin);
  const installed = existsSync(path.join(pubCacheBin, 'marionette_mcp'));

  if (installed && onPath) {
    return {name: 'marionette_mcp (agent UI drives)', status: 'ok'};
  }
  return {
    name: 'marionette_mcp (agent UI drives)',
    status: 'optional-missing',
    found: installed ? 'installed, but ~/.pub-cache/bin is not on PATH' : undefined,
    needed: 'driving the running Flutter app from an agent (the exploratory testing tool)',
    fix: installed
      ? [`export PATH="${pubCacheBin}:$PATH"   # add to your shell rc`]
      : [
          'dart pub global activate marionette_mcp',
          `export PATH="${pubCacheBin}:$PATH"   # add to your shell rc`,
        ],
  };
}

async function checkAndroid(): Promise<Check> {
  const sdk = process.env.ANDROID_HOME ?? path.join(os.homedir(), 'Android', 'Sdk');
  if (!existsSync(sdk)) {
    return {
      name: 'Android SDK + an AVD',
      status: 'optional-missing',
      needed: '`bun run test:device -d emulator-*` and `flutter build apk` ONLY',
      fix: [
        'Install Android Studio (or the command-line tools), then:',
        'sdkmanager "platform-tools" "emulator" "system-images;android-35;google_apis;x86_64"',
        'avdmanager create avd -n nelle_phone -k "system-images;android-35;google_apis;x86_64"',
        `export ANDROID_HOME="${sdk}"`,
        'export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"',
      ],
    };
  }

  const avds = await run([path.join(sdk, 'emulator', 'emulator'), '-list-avds']);
  const names = avds.out
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  if (names.length === 0) {
    return {
      name: 'Android SDK + an AVD',
      status: 'optional-missing',
      found: 'SDK present, but no AVD',
      needed: '`bun run test:device -d emulator-*` ONLY',
      fix: [
        'avdmanager create avd -n nelle_phone -k "system-images;android-35;google_apis;x86_64"',
      ],
    };
  }
  return {name: 'Android SDK + an AVD', status: 'ok', found: names.join(', ')};
}

async function checkKvm(): Promise<Check> {
  if (host.os !== 'linux') {
    return {name: 'KVM (emulator acceleration)', status: 'ok', found: 'n/a on this OS'};
  }
  const groups = await run(['id', '-nG']);
  const inGroup = groups.out.split(/\s+/).includes('kvm');
  return {
    name: 'KVM (emulator acceleration)',
    status: inGroup ? 'ok' : 'optional-missing',
    needed: 'the Android emulator — without it the boot silently falls back to something unusable',
    fix: ['sudo usermod -aG kvm "$USER"', '# then log out and back in'],
  };
}

async function checkLlamaBuildDeps(): Promise<Check> {
  // Optional: llama.cpp installs *itself* from Settings. This only says whether that will succeed.
  const missing = ['git', 'cmake'].filter(binary => !which(binary));
  const compiler = which('c++') ?? which('g++') ?? which('clang++');
  if (!compiler) {
    missing.push('a C++ compiler');
  }
  if (missing.length === 0) {
    return {name: 'llama.cpp build deps', status: 'ok'};
  }
  return {
    name: 'llama.cpp build deps',
    status: 'optional-missing',
    found: `missing: ${missing.join(', ')}`,
    needed: 'llama.cpp building itself from Settings (nothing else)',
    fix:
      host.os === 'macos'
        ? ['brew install cmake', 'xcode-select --install']
        : ['sudo apt install -y git cmake build-essential'],
  };
}

async function checkKeyring(): Promise<Check> {
  if (host.os !== 'linux') {
    return {name: 'Secret store', status: 'ok', found: 'OS-provided (Keychain/credential store)'};
  }
  // `flutter_secure_storage` needs libsecret AND something answering org.freedesktop.secrets.
  const answered = await run(['busctl', '--user', 'status', 'org.freedesktop.secrets']);
  return {
    name: 'Secret store (org.freedesktop.secrets)',
    status: answered.ok ? 'ok' : 'optional-missing',
    needed:
      'LAN pairing on Linux ONLY. Loopback is unauthenticated by design and needs no keyring — ' +
      'the token store reports *unavailable* rather than throwing',
    fix: [
      'sudo apt install -y libsecret-1-0 gnome-keyring',
      '# or KWallet / KeePassXC — anything answering org.freedesktop.secrets',
    ],
  };
}

async function checkToolchainFreshness(): Promise<Check> {
  // Best-effort and online-only: are the *pins themselves* behind upstream? A newer release is
  // never an error — the flow is always upgrade locally, run the gates, then bump the pin. This
  // check exists so "a new Bun/Flutter is out" is something doctor tells you, not something you
  // discover mid-task.
  const name = 'Toolchain pins vs upstream';
  const pin = (
    await Bun.file('.bun-version')
      .text()
      .catch(() => '')
  ).trim();
  const pubspec = await Bun.file(path.join('apps', 'client', 'pubspec.yaml'))
    .text()
    .catch(() => '');
  const flutterPin = /^ {2}flutter:\s*([\d.]+)/m.exec(pubspec)?.[1];

  const flutterReleasesUrl = `https://storage.googleapis.com/flutter_infra_release/releases/releases_${
    host.os === 'macos' ? 'macos' : host.os === 'windows' ? 'windows' : 'linux'
  }.json`;

  try {
    const signal = AbortSignal.timeout(3000);
    const [bunResponse, flutterResponse] = await Promise.all([
      fetch('https://api.github.com/repos/oven-sh/bun/releases/latest', {signal}),
      fetch(flutterReleasesUrl, {signal}),
    ]);
    const bunLatest = ((await bunResponse.json()) as {tag_name?: string}).tag_name?.replace(
      /^bun-v/,
      '',
    );
    const flutterData = (await flutterResponse.json()) as {
      current_release?: {stable?: string};
      releases?: Array<{hash: string; version: string}>;
    };
    const stableHash = flutterData.current_release?.stable;
    const flutterLatest = flutterData.releases?.find(r => r.hash === stableHash)?.version;

    const behind: string[] = [];
    if (pin && bunLatest && pin !== bunLatest) {
      behind.push(`Bun pin ${pin} -> ${bunLatest} available`);
    }
    if (flutterPin && flutterLatest && flutterPin !== flutterLatest) {
      behind.push(`Flutter pin ${flutterPin} -> ${flutterLatest} available`);
    }
    if (behind.length === 0) {
      return {name, status: 'ok', found: `bun ${pin}, flutter ${flutterPin} — both current`};
    }
    return {
      name,
      status: 'optional-missing',
      found: behind.join('; '),
      needed: 'nothing today — upgrade locally, run the gates, then bump the pin(s)',
      fix: [
        '# Upgrade locally first (brew upgrade bun / flutter upgrade), run the gates,',
        '# then bump .bun-version and/or pubspec environment.flutter. CI follows the pins.',
      ],
    };
  } catch {
    return {name, status: 'ok', found: 'offline — skipped'};
  }
}

// --- report ----------------------------------------------------------------------------------

const ICON: Record<Status, string> = {
  ok: '✔',
  missing: '✘',
  stale: '⚠',
  'optional-missing': '○',
};

function render(check: Check): void {
  const icon = ICON[check.status];
  const found = check.found ? `  (${check.found})` : '';
  console.log(`  ${icon} ${check.name}${check.status === 'ok' ? found : ''}`);
  if (check.status === 'ok') {
    return;
  }
  if (check.found) {
    console.log(`      found: ${check.found}`);
  }
  if (check.needed) {
    console.log(`      needed for: ${check.needed}`);
  }
  for (const line of check.fix ?? []) {
    console.log(`      ${line}`);
  }
  console.log('');
}

export async function doctor(options: {strict?: boolean} = {}): Promise<number> {
  const checks: Check[] = [
    await checkBun(),
    await checkNodeModules(),
    await checkFlutter(),
    await checkPubGet(),
    await checkMarionette(),
    await checkAndroid(),
    await checkKvm(),
    await checkLlamaBuildDeps(),
    await checkKeyring(),
    await checkToolchainFreshness(),
  ];

  console.log(`\nNelle — doctor\n  host: ${host.os}/${host.arch}${host.isWsl ? ' (WSL)' : ''}\n`);

  // Where this host will read and write. Both are overridable, and the override is worth naming:
  // "why is it there?" is the first question when either is not where someone expected.
  const paths = createAppPaths();
  console.log('Paths');
  console.log(
    `  data:      ${paths.dataDir}${process.env.NELLE_DATA_DIR ? '  (NELLE_DATA_DIR)' : ''}`,
  );
  console.log(
    `  workspace: ${paths.workspaceDir}${process.env.NELLE_WORKSPACE_DIR ? '  (NELLE_WORKSPACE_DIR)' : ''}\n`,
  );

  console.log('Required\n');
  const required = checks.filter(c => c.status !== 'optional-missing');
  for (const check of required) {
    render(check);
  }

  console.log('Optional — only needed for the work named beside each\n');
  for (const check of checks.filter(c => c.status === 'optional-missing')) {
    render(check);
  }

  // The capability summary, in words rather than a table of ticks.
  console.log('On this host you can:');
  console.log(`  build:        ${host.buildTargets.join(', ')}`);
  console.log(`  device-test:  ${host.deviceTargets.join(', ')}`);
  const impossible = (['linux', 'macos', 'windows', 'ipa'] as const).filter(
    target => !host.buildTargets.includes(target),
  );
  if (impossible.length > 0) {
    console.log(
      `  you CANNOT build: ${impossible.join(', ')} — those need their own OS (Flutter does not ` +
        'cross-compile desktop or iOS targets).',
    );
  }
  if (!host.lanReachableByPhone) {
    console.log(
      "  a physical phone CANNOT reach this server: WSL2 is NAT'd, so Nelle binds the VM's\n" +
        '  172.31.x.x while the phone is on 192.168.x.x. Use the Android emulator, which runs\n' +
        '  inside WSL and shares its network namespace.',
    );
  }
  console.log('');

  const broken = checks.filter(c => c.status === 'missing' || c.status === 'stale');
  const optional = checks.filter(c => c.status === 'optional-missing');
  const failing = options.strict ? [...broken, ...optional] : broken;

  if (failing.length === 0) {
    console.log(
      optional.length > 0
        ? `Ready. (${optional.length} optional item(s) missing — see above.)\n`
        : 'Ready.\n',
    );
    return 0;
  }
  console.log(`${failing.length} required item(s) missing. Fix them with the commands above.\n`);
  return 1;
}

if (import.meta.main) {
  process.exit(await doctor({strict: process.argv.includes('--strict')}));
}
