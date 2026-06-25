#!/usr/bin/env bash
# Offline gauntlet-math validation: export OUR stats -> recompute via canonical refs.
# Exit 0 = all gates confirmed; exit 1 = discrepancy.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

VENV=validation/.venv
if [ ! -x "$VENV/bin/python" ]; then
  echo "[setup] creating venv + installing purgedcv/skfolio/numpy/scipy ..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet purgedcv skfolio numpy scipy
fi

echo "[1/2] exporting our statistics -> validation/cases.json"
npx tsx validation/export_cases.ts validation/cases.json

echo "[2/2] recomputing via canonical references"
"$VENV/bin/python" validation/validate.py validation/cases.json
