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

# Prime a Gradle cache from the original repository, then ensure the exclusive
# filter selects the mirror even when the original metadata is already cached.
python3 - "$work" "$init_script" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
for repository, content in (("central", "central"), ("mirror", "mirror")):
    artifact = root / repository / "org/jetbrains/kotlin/kotlin-compiler-embeddable/2.1.20"
    artifact.mkdir(parents=True)
    (artifact / "kotlin-compiler-embeddable-2.1.20.pom").write_text(
        '<project><modelVersion>4.0.0</modelVersion><groupId>org.jetbrains.kotlin</groupId>'
        '<artifactId>kotlin-compiler-embeddable</artifactId><version>2.1.20</version></project>'
    )
    (artifact / "kotlin-compiler-embeddable-2.1.20.jar").write_text(content)
def uri(name):
    return (root / name).absolute().as_uri().replace("file://", "file:", 1)
script = Path(sys.argv[2]).read_text()
script = script.replace("https://repo.maven.apache.org/maven2", uri("central"))
script = script.replace("https://maven-central.storage-download.googleapis.com/maven2", uri("mirror"))
(root / "fixture.init.gradle").write_text(script)
PY
mkdir -p "$work/cache-test"
cat > "$work/cache-test/settings.gradle" <<'EOF'
rootProject.name = 'ork-maven-cache-test'
EOF
cat > "$work/cache-test/build.gradle" <<'EOF'
repositories { maven { name = 'MavenRepo'; url = uri(System.getenv('ORK_TEST_MAVEN_CENTRAL')) } }
configurations { fixture }
dependencies { fixture('org.jetbrains.kotlin:kotlin-compiler-embeddable:2.1.20') { transitive = false } }
tasks.register('resolveFixture') {
  doLast { assert configurations.fixture.singleFile.text == System.getenv('ORK_TEST_EXPECTED') }
}
EOF
export ORK_TEST_MAVEN_CENTRAL="$work/central"
ORK_TEST_EXPECTED=central "$gradle" --no-daemon --offline -p "$work/cache-test" resolveFixture
ORK_TEST_EXPECTED=mirror "$gradle" --no-daemon --offline -p "$work/cache-test" --init-script "$work/fixture.init.gradle" resolveFixture
