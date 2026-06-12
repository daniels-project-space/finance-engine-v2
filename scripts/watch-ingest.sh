#!/bin/bash
# Poll Convex until an ingest run with status ok appears (or ~50 min pass).
for i in $(seq 1 70); do
  R=$(curl -s -X POST 'https://glad-poodle-88.convex.cloud/api/query' \
    -H 'Content-Type: application/json' \
    -d '{"path":"pipeline:recentRuns","args":{"limit":5},"format":"json"}')
  OK=$(echo "$R" | python3 -c 'import sys,json
try:
    runs=json.load(sys.stdin)["value"]
    for r in runs:
        if r["kind"]=="ingest" and r["status"]=="ok":
            print("INGEST_OK", (r.get("summary") or "")[:300]); break
except Exception: pass')
  if [ -n "$OK" ]; then echo "$OK"; exit 0; fi
  sleep 45
done
echo "INGEST_NOT_OK_YET"
