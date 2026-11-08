#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Ork contributors
# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

set -euo pipefail
gradle="${1:?Gradle executable is required}"
init_script="${2:?Gradle init script is required}"
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ork-maven-test.XXXXXX")
trap 'rm -rf -- "$work"' EXIT

cat > "$work/settings.gradle" <<'EOF'
pluginManagement { repositories { mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { mavenCentral() } }
rootProject.name = 'ork-maven-test'
gradle.settingsEvaluated { settings ->
  def check = { repos ->
    assert repos.collect { it.name }.take(2) == ['orkMavenCentralMirror', 'MavenRepo']
    assert repos.first().url.toString() == 'https://maven-central.storage-download.googleapis.com/maven2'
    assert repos.findByName('MavenRepo').url.toString().startsWith('https://repo.maven.apache.org/maven2')
  }
  check(settings.pluginManagement.repositories)
  check(settings.dependencyResolutionManagement.repositories)
}
EOF
cat > "$work/build.gradle" <<'EOF'
buildscript { repositories { mavenCentral(); mavenCentral() } }
repositories { mavenCentral(); google() }
tasks.register('checkMirror') {
  doLast {
    def check = { repos ->
      assert repos.collect { it.name }.take(2) == ['orkMavenCentralMirror', 'MavenRepo']
      assert repos.count { it.name == 'orkMavenCentralMirror' } == 1
      assert repos.findByName('MavenRepo').url.toString().startsWith('https://repo.maven.apache.org/maven2')
    }
    check(buildscript.repositories)
    check(project.repositories)
  }
}
EOF
"$gradle" --no-daemon --offline -p "$work" --init-script "$init_script" checkMirror
