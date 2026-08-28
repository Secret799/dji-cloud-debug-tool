#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: npm run release:tag -- <version>"
  echo "Example: npm run release:tag -- 1.2.0"
}

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

version="${1#v}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid version: $1"
  usage
  exit 1
fi

tag="v$version"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "The working tree has uncommitted changes. Commit them before creating $tag."
  exit 1
fi

if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  echo "Tag $tag already exists locally."
  exit 1
fi

git tag --annotate "$tag" --message "Release $tag"
git push origin "$tag"

echo "Pushed $tag. GitHub Actions will build and publish all release packages."
