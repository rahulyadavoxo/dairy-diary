#!/bin/bash
# Runs the Firestore security-rules tests (tests/rules) against the local Firestore emulator.
# Needs Java 11+ (JDK 21 recommended). The emulator is fetched once from Google's Cloud SDK
# component mirror into ~/tools/firestore-emulator (firebase-tools is NOT needed).
#   Usage: bash scripts/rules-test.sh        (or: npm run test:rules)
set -e
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
EMU=$HOME/tools/firestore-emulator
PORT=${FIRESTORE_PORT:-8085}
[ -z "$JAVA_HOME" ] && ls -d $HOME/tools/jdk-21* >/dev/null 2>&1 && export JAVA_HOME=$(ls -d $HOME/tools/jdk-21* | head -1)
[ -n "$JAVA_HOME" ] && export PATH=$JAVA_HOME/bin:$PATH
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}" no_proxy="127.0.0.1,localhost${no_proxy:+,$no_proxy}"
if [ ! -f $EMU/cloud-firestore-emulator.jar ]; then
  mkdir -p $EMU
  SRC=$(curl -sSL https://dl.google.com/dl/cloudsdk/channels/rapid/components-2.json | python3 -c "import json,sys;print([c['data']['source'] for c in json.load(sys.stdin)['components'] if c['id']=='cloud-firestore-emulator'][0])")
  curl -sSL -o /tmp/fse.tgz "https://dl.google.com/dl/cloudsdk/channels/rapid/$SRC"
  rm -rf /tmp/fse && mkdir /tmp/fse && tar xzf /tmp/fse.tgz -C /tmp/fse
  cp /tmp/fse/platform/cloud-firestore-emulator/* $EMU/
fi
if ! curl -s --noproxy '*' http://127.0.0.1:$PORT/ >/dev/null 2>&1; then
  (cd $EMU && setsid nohup java -Duser.language=en -cp cloud-firestore-emulator.jar \
     com.google.cloud.datastore.emulator.firestore.CloudFirestore start --host=127.0.0.1 --port=$PORT \
     >/tmp/firestore-emulator.log 2>&1 </dev/null &)
  for i in $(seq 1 40); do curl -s --noproxy '*' http://127.0.0.1:$PORT/ >/dev/null 2>&1 && break; sleep 1; done
fi
cd "$PROJ"
FIRESTORE_EMULATOR_HOST=127.0.0.1:$PORT npx vitest run tests/rules
