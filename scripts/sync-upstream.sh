#!/usr/bin/env bash
# Merge ryanbr/TwitchAdSolutions master into this fork, keeping only vaft.
#
# - Upstream-owned files are taken verbatim from upstream (vaft script, tests, DEBUG.md),
#   then the userscript header is repointed at this fork.
# - Fork-owned files keep our version (README, CLAUDE.md, CI, this script).
# - Anything else upstream adds or changes (uBO variants, testing builds, other scripts,
#   docs) is dropped.
#
# Leaves a merge commit (history stays linked to upstream). Does not push.
set -euo pipefail

FORK_URL='https://github.com/controlled-opposition/TwitchAdSolutions'
SCRIPT='vaft/vaft.user.js'
THEIRS=("$SCRIPT" tests/test.js tests/benchmark.js DEBUG.md LICENSE)
OURS=(README.md CLAUDE.md .github/workflows/validate.yml scripts/sync-upstream.sh)

cd "$(git rev-parse --show-toplevel)"

if ! git diff --quiet || ! git diff --cached --quiet; then
    echo 'Working tree has uncommitted changes; commit or stash first.' >&2
    exit 1
fi

git remote get-url upstream >/dev/null 2>&1 ||
    git remote add upstream https://github.com/ryanbr/TwitchAdSolutions.git
git fetch -q upstream master

if git merge-base --is-ancestor upstream/master HEAD; then
    echo 'Already up to date with upstream.'
    exit 0
fi

old_version=$(grep -m1 '@version' "$SCRIPT" | awk '{print $NF}')

# Conflicts are expected here; everything is resolved explicitly below.
git merge --no-commit --no-ff -q upstream/master >/dev/null 2>&1 || true

for f in "${THEIRS[@]}"; do
    if git cat-file -e "upstream/master:$f" 2>/dev/null; then
        git checkout upstream/master -- "$f"
    else
        echo "warning: upstream no longer has $f" >&2
    fi
done
for f in "${OURS[@]}"; do
    git checkout HEAD -- "$f"
done

# Drop every tracked or conflicted path that isn't on the keep list.
keep=$(printf '%s\n' "${THEIRS[@]}" "${OURS[@]}" | sort -u)
git ls-files | sort -u | comm -23 - <(echo "$keep") | while IFS= read -r f; do
    git rm -q --cached --ignore-unmatch -- "$f"
    rm -f -- "$f"
done

sed -i \
    -e "s|^// @namespace .*|// @namespace    $FORK_URL|" \
    -e "s|^// @updateURL .*|// @updateURL    $FORK_URL/raw/master/$SCRIPT|" \
    -e "s|^// @downloadURL .*|// @downloadURL  $FORK_URL/raw/master/$SCRIPT|" \
    "$SCRIPT"
git add -- "${THEIRS[@]}" "${OURS[@]}"

if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
    echo 'Unresolved conflicts remain:' >&2
    git diff --name-only --diff-filter=U >&2
    exit 1
fi

echo 'Validating...'
npx --yes acorn --ecma2022 "$SCRIPT" >/dev/null
node tests/test.js

new_version=$(grep -m1 '@version' "$SCRIPT" | awk '{print $NF}')
git commit -q -m "Sync upstream vaft ${old_version} -> ${new_version}"
echo "Merged upstream: vaft ${old_version} -> ${new_version}. Review with 'git show --stat', then push."
