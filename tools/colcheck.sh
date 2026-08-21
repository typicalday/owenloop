#!/usr/bin/env bash
# Controlled collection-check receipt for owenloop#229.
#
# Every collection topology below keeps its one-variable non-collection control:
# P/Q, H/I, and N guards against calling any ordinary parallel-workflow state
# a collection defect. Run from any directory; the repository is located from
# this script, and all generated definitions stay in a temporary directory.
set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/bin/owenloop.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$ROOT" || exit 1
head="$(git rev-parse HEAD)"
tree="$(git rev-parse HEAD^{tree})"
dirty="$(git status --porcelain | wc -l | tr -d ' ')"
printf 'engine HEAD=%s\nengine tree=%s\nengine dirty-paths=%s\n\n' "$head" "$tree" "$dirty"

if ! npm run build >/dev/null; then
  echo 'local CLI build failed' >&2
  exit 1
fi

body='    executor: agent
    body: do the thing'

# A: bare reduce over a step-produced sealed collection.
cat > "$TMP/shapeA.yaml" <<EOF
name: shapeA
title: CONSUMER - bare reduce over a sealed collection
outputs: [report]
inputs: [{ name: request, seedOwed: true, producer: human, schema: { type: object } }]
steps:
  - name: a-producer
$body
    consumes: [request]
    produces: [{ name: "q[]", schema: { type: object } }]
  - name: a-reduce
$body
    consumes: [request, "q[*]"]
    produces: [{ name: report, schema: { type: object } }]
EOF

# B: map over members, then reduce over map children.
cat > "$TMP/shapeB.yaml" <<EOF
name: shapeB
title: CONSUMER - map then suffix reduce
outputs: [report]
inputs: [{ name: request, seedOwed: true, producer: human, schema: { type: object } }]
steps:
  - name: b-producer
$body
    consumes: [request]
    produces: [{ name: "q[]", schema: { type: object } }]
  - name: b-map
$body
    consumes: [request, "q[\$i]"]
    produces: [{ name: "q[\$i].out", schema: { type: object } }]
  - name: b-reduce
$body
    consumes: [request, "q[*].out"]
    produces: [{ name: report, schema: { type: object } }]
EOF

# C: invalid human-seeded collection control, retained to expose loader behavior.
cat > "$TMP/shapeC.yaml" <<EOF
name: shapeC
title: CONSUMER - human-seeded collection
outputs: [report]
inputs: [{ name: "q[]", seedOwed: true, producer: human, schema: { type: object } }]
steps:
  - name: c-map
$body
    consumes: ["q[\$i]"]
    produces: [{ name: "q[\$i].out", schema: { type: object } }]
  - name: c-reduce
$body
    consumes: ["q[*].out"]
    produces: [{ name: report, schema: { type: object } }]
EOF

# E: B with low collection-produce budgets.
sed -e 's/^name: shapeB/name: shapeE/' \
    -e 's|produces: \[{ name: "q\[\]", schema: { type: object } }\]|produces: [{ name: "q[]", maxAttempts: 1, maxSchemaFailures: 1, schema: { type: object } }]|' \
    "$TMP/shapeB.yaml" > "$TMP/shapeE.yaml"

# P: control for Q — ordinary chained two-step workflow.
cat > "$TMP/shapeP.yaml" <<EOF
name: shapeP
title: CONTROL for Q - chained two-step def, no collection
outputs: [report]
inputs: [{ name: request, seedOwed: true, producer: human, schema: { type: object } }]
steps:
  - name: p-first
$body
    consumes: [request]
    produces: [{ name: note, schema: { type: object } }]
  - name: p-second
$body
    consumes: [note]
    produces: [{ name: report, schema: { type: object } }]
EOF

# Q: P plus one otherwise-unconsumed generated collection.
cat > "$TMP/shapeQ.yaml" <<EOF
name: shapeQ
title: PRODUCE-ONLY - chained def plus a collection nobody consumes
outputs: [report, q]
inputs: [{ name: request, seedOwed: true, producer: human, schema: { type: object } }]
steps:
  - name: p-first
$body
    consumes: [request]
    produces: [{ name: note, schema: { type: object } }]
    generates: [{ name: "q[]", schema: { type: object } }]
  - name: p-second
$body
    consumes: [note]
    produces: [{ name: report, schema: { type: object } }]
EOF

# H/I: lone-step control and collection-only sibling.
cat > "$TMP/shapeH.yaml" <<EOF
name: shapeH
title: CONTROL for I - lone step, no collection
outputs: [report]
inputs: [{ name: request, seedOwed: true, producer: human, schema: { type: object } }]
steps:
  - name: h-worker
$body
    consumes: [request]
    produces: [{ name: report, schema: { type: object } }]
EOF

cat > "$TMP/shapeI.yaml" <<EOF
name: shapeI
title: PRODUCE-ONLY - lone step, collection is the sole output
outputs: [items]
inputs: [{ name: request, seedOwed: true, producer: human, schema: { type: object } }]
steps:
  - name: generate-items
$body
    consumes: [request]
    generates: [{ name: "items[]", schema: { type: object } }]
EOF

# N: scalar negative control — independent ordinary branches can truly be stuck.
cat > "$TMP/shapeN.yaml" <<EOF
name: shapeN
title: CONTROL - two independent output producers, no collection
outputs: [report, note]
inputs: [{ name: request, seedOwed: true, producer: human, schema: { type: object } }]
steps:
  - name: n-logger
$body
    consumes: [request]
    produces: [{ name: note, schema: { type: object } }]
  - name: n-worker
$body
    consumes: [request]
    produces: [{ name: report, schema: { type: object } }]
EOF

for shape in shapeA shapeB shapeC shapeE shapeP shapeQ shapeH shapeI shapeN; do
  printf '######## %s ########\n' "$shape"
  sed -n '2p' "$TMP/$shape.yaml"
  node "$CLI" --defs "$TMP" check "$shape" --format json --max-states 5000 --max-depth 50 --max-collection 2 > "$TMP/$shape.json" 2> "$TMP/$shape.err"
  status=$?
  printf '  check-exit=%s\n' "$status"
  if [ -s "$TMP/$shape.err" ]; then
    echo '  stderr:'
    sed -n '1,6p' "$TMP/$shape.err" | sed 's/^/    /'
  fi
  python3 - "$TMP/$shape.json" <<'PY'
import json, sys
from collections import Counter

try:
    report = json.load(open(sys.argv[1]))
except Exception:
    print('  (no check result)')
    raise SystemExit

print(f"  completable={report.get('completable')} bounded={report.get('bounded')} boundsHit={report.get('boundsHit')}")
for field in ['deadlocks', 'stuck', 'structurallyDeadSteps', 'unreachedSteps', 'invariantViolations']:
    print(f"  {field}={len(report.get(field) or [])}")
for entry in (report.get('stuck') or [])[:1]:
    print('  stuck witness: ' + ' -> '.join(f"{move['step']}:{move['outcome']}" for move in entry['path']))
deadlocks = report.get('deadlocks') or []
if deadlocks:
    shortest = min(deadlocks, key=lambda item: len(item.get('path', [])))
    print('  shortest deadlock: ' + ' -> '.join(f"{move['step']}:{move['outcome']}" for move in shortest['path']))
    terminals = Counter(item['path'][-1]['step'] + ':' + item['path'][-1]['outcome'] for item in deadlocks if item.get('path'))
    for move, count in terminals.most_common(3): print(f'    terminal move {move} x{count}')
PY
  if [ "$shape" != shapeN ]; then echo; fi
done
