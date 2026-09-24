#!/bin/sh
set -eu

branch_name='fix/github-allowlist-signup-bypass'
upstream_url='https://github.com/happier-dev/happier.git'
upstream_branch_ref='refs/remotes/upstream/dev'
script_path='scripts/pipeline/git/update-allowlist-fork.sh'

usage() {
  printf 'Usage: %s [--help]\n\n' "$0"
  printf 'Merge the latest happier-dev/happier dev branch into the fork branch,\n'
  printf 'reapply local Docker image recipe edits, then push only that fork branch.\n'
}

case "${1:-}" in
  '') ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

current_branch=$(git branch --show-current)
if [ "$current_branch" != "$branch_name" ]; then
  printf 'Refusing to update branch %s; expected %s.\n' "$current_branch" "$branch_name" >&2
  exit 1
fi

check_github_repo_url() {
  remote_name=$1
  expected_owner_repo=$2
  remote_url=$3

  case "$remote_url" in
    "https://github.com/$expected_owner_repo.git"|"https://github.com/$expected_owner_repo"|"git@github.com:$expected_owner_repo.git"|"git@github.com:$expected_owner_repo"|"ssh://git@github.com/$expected_owner_repo.git"|"ssh://git@github.com/$expected_owner_repo")
      ;;
    *)
      printf 'Refusing unexpected %s URL: %s\n' "$remote_name" "$remote_url" >&2
      exit 1
      ;;
  esac
}

origin_fetch_url=$(git remote get-url origin)
origin_push_url=$(git remote get-url --push origin)
check_github_repo_url origin alfdupont/happier "$origin_fetch_url"
check_github_repo_url origin alfdupont/happier "$origin_push_url"

if git remote get-url upstream >/dev/null 2>&1; then
  configured_upstream_url=$(git remote get-url upstream)
  check_github_repo_url upstream happier-dev/happier "$configured_upstream_url"
else
  git remote add upstream "$upstream_url"
fi

# Only the Docker image edits from this task may be carried as a dirty overlay.
# Refuse to stash unrelated work in the shared checkout.
changed_paths=$(
  git diff --name-only
  git diff --cached --name-only
  git ls-files --others --exclude-standard
)
unexpected_paths=$(printf '%s\n' "$changed_paths" | while IFS= read -r changed_path; do
  [ -n "$changed_path" ] || continue
  case "$changed_path" in
    Dockerfile|scripts/pipeline/docker/build-local-relay-server.sh|scripts/pipeline/docker/prune-relay-server-runtime.sh|"$script_path")
      ;;
    *)
      printf '%s\n' "$changed_path"
      ;;
  esac
done)
if [ -n "$unexpected_paths" ]; then
  printf 'Refusing to update with unrelated local changes:\n%s\n' "$unexpected_paths" >&2
  printf 'Commit or handle those changes separately, then rerun.\n' >&2
  exit 1
fi

stash_before=$(git rev-parse -q --verify refs/stash 2>/dev/null || true)
stash_oid=''
trap 'result=$?; if [ "$result" -ne 0 ] && [ -n "$stash_oid" ]; then printf "Local Docker image edits remain preserved in Git stash %s.\n" "$stash_oid" >&2; fi; exit "$result"' EXIT

if [ -n "$changed_paths" ]; then
  git stash push --include-untracked \
    --message 'Preserve local Docker image recipe while updating fork' \
    -- \
    Dockerfile \
    scripts/pipeline/docker/build-local-relay-server.sh \
    scripts/pipeline/docker/prune-relay-server-runtime.sh \
    "$script_path"
  stash_after=$(git rev-parse -q --verify refs/stash 2>/dev/null || true)
  if [ "$stash_after" != "$stash_before" ]; then
    stash_oid=$stash_after
  fi
fi

if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  printf 'Working tree is still dirty after preserving the Docker image edits; stopping before fetch or merge.\n' >&2
  exit 1
fi

git fetch upstream "refs/heads/dev:$upstream_branch_ref"
git merge --no-edit "$upstream_branch_ref"

if [ -n "$stash_oid" ]; then
  if ! git stash pop --index "$stash_oid"; then
    printf 'The upstream merge completed, but local Docker edits need conflict resolution before pushing.\n' >&2
    exit 1
  fi
  stash_oid=''
fi

git push origin "HEAD:refs/heads/$branch_name"
