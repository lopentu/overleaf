#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "git-bridge quality: $*" >&2
  exit 1
}

if [[ -z "${JAVA_HOME:-}" || ! -x "$JAVA_HOME/bin/java" || ! -x "$JAVA_HOME/bin/javac" ]]; then
  fail 'Set JAVA_HOME to a full JDK 21 (including javac); see docs/lope/DEVELOPMENT.md.'
fi
javac_version=$("$JAVA_HOME/bin/javac" -version 2>&1)
if [[ ! "$javac_version" =~ ^javac\ 21([.]|$) ]]; then
  fail "Use JDK 21; found $javac_version."
fi

command -v mvn >/dev/null 2>&1 || fail 'Install Apache Maven 3.9.16 on PATH; see docs/lope/DEVELOPMENT.md.'
maven_version=$(mvn --version -Dstyle.color=never)
if [[ "$maven_version" != 'Apache Maven 3.9.16 '* ]]; then
  fail 'Use Apache Maven 3.9.16; see docs/lope/DEVELOPMENT.md.'
fi

# Git fixtures must not inherit the invoking hook's repository/index context.
git_local_environment=$(git rev-parse --local-env-vars) || fail 'Cannot identify Git-local environment variables.'
while IFS= read -r git_local_name; do
  unset "$git_local_name"
done <<< "$git_local_environment"

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
exec mvn --batch-mode --no-transfer-progress -Dstyle.color=never \
  -f "$repo_root/services/git-bridge/pom.xml" fmt:check test
