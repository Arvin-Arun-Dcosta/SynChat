#!/usr/bin/env bash
# Download the dev and test splits of the Ubuntu IRC disentanglement corpus
# (Kummerfeld et al., ACL 2019; data licensed CC-BY-4.0) into eval/data/irc.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data
if [ -d data/irc/data/test ]; then
  echo "IRC data already present in eval/data/irc"
  exit 0
fi
rm -rf data/irc
git clone --depth 1 --filter=blob:none --sparse https://github.com/jkkummerfeld/irc-disentanglement.git data/irc
git -C data/irc sparse-checkout set data/dev data/test
echo "Done: $(ls data/irc/data/dev/*.annotation.txt | wc -l) dev files, $(ls data/irc/data/test/*.annotation.txt | wc -l) test files"
